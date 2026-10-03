// The owner's model gateway tool (ADR 0022).
//
//   npm run models -- list
//   npm run models -- record --gateway <name> --model <id> --family <name> --structured yes|no
//                     --reasoning yes|no --tools yes|no --context short|long --latency fast|medium|slow
//                     --cost low|medium|high --source <text> --actor <label> [--accepted-builds <id,id>]
//   npm run models -- enable|disable --gateway <name> --model <id> --reason <text> --actor <label>
//   npm run models -- pool add --pool <name> --gateway <name> --model <id> --rank <n> --actor <label>
//   npm run models -- pool remove --pool <name> --gateway <name> --model <id> --reason <text> --actor <label>
//   npm run models -- profiles [--tenant <uuid>]
//   npm run models -- profile record --tenant <uuid> --agent <uuid> --objective <text>
//                     --capabilities <a,b> --data-classes <a,b> --ceiling-usd <decimal>
//                     --timezone <IANA> --actor <label> [--pools <capability=pool,...>]
//   npm run models -- decisions --tenant <uuid>
//   npm run models -- economics --tenant <uuid> [--since <instant>]
//   npm run models -- outcome record --tenant <uuid> --decision <uuid> --outcome <code>
//                     --actor <label> [--value-usd <decimal>] [--observed-at <instant>]
//
// READ-ONLY BY DEFAULT: list, profiles, decisions and economics run in a
// read-only transaction. The acts are an explicit allowlist (MODEL_ACTS); each
// is one recorded owner act on owner data: a model, its switch, a pool member,
// an agent profile, an observed outcome. None calls a model, authorizes data
// (Q8 authorizations stay `npm run ops -- data-auth`), sets a price or a limit
// (`npm run ops`), or touches the browser.
//
// OWNER ONLY: the one variable read is ADMIN_DATABASE_URL. OUTPUT: one JSON
// object per line: ids, model ids, classes, counts and sums; never an objective,
// a source text, a reason or a connection string. Exit 0, 2 on a usage error, 1
// when the database refused.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  EXIT_USAGE,
  isEntryPoint,
  missingAdminUrlLine,
  parseFlags,
  readAdminDatabaseUrl,
  runOwnerTransaction,
  usageLine,
  type FlagArity,
} from "./cliOutput.ts";

export const MODELS_SYNOPSIS =
  "npm run models -- list | record --gateway --model --family --structured --reasoning --tools --context --latency --cost --source --actor [--accepted-builds] | enable|disable --gateway --model --reason --actor | pool add --pool --gateway --model --rank --actor | pool remove --pool --gateway --model --reason --actor | profiles [--tenant] | profile record --tenant --agent --objective --capabilities --data-classes --ceiling-usd --timezone --actor [--pools] | decisions --tenant | economics --tenant [--since] | outcome record --tenant --decision --outcome --actor [--value-usd] [--observed-at]";

type CommandName =
  | "list"
  | "record"
  | "enable"
  | "disable"
  | "pool add"
  | "pool remove"
  | "profiles"
  | "profile record"
  | "decisions"
  | "economics"
  | "outcome record";

interface Grammar {
  readonly flags: ReadonlyMap<string, FlagArity>;
  readonly required: readonly string[];
  readonly readOnly: boolean;
}

const grammar = (
  readOnly: boolean,
  flags: readonly string[],
  required: readonly string[] = flags,
): Grammar => ({
  flags: new Map(flags.map((name) => [name, "value" as FlagArity])),
  required,
  readOnly,
});

const RECORD_FLAGS = [
  "gateway",
  "model",
  "family",
  "structured",
  "reasoning",
  "tools",
  "context",
  "latency",
  "cost",
  "source",
  "actor",
];

const COMMANDS: ReadonlyMap<CommandName, Grammar> = new Map([
  ["list", grammar(true, [], [])],
  [
    "record",
    grammar(false, [...RECORD_FLAGS, "accepted-builds"], RECORD_FLAGS),
  ],
  ["enable", grammar(false, ["gateway", "model", "reason", "actor"])],
  ["disable", grammar(false, ["gateway", "model", "reason", "actor"])],
  ["pool add", grammar(false, ["pool", "gateway", "model", "rank", "actor"])],
  [
    "pool remove",
    grammar(false, ["pool", "gateway", "model", "reason", "actor"]),
  ],
  ["profiles", grammar(true, ["tenant"], [])],
  [
    "profile record",
    grammar(
      false,
      [
        "tenant",
        "agent",
        "objective",
        "capabilities",
        "data-classes",
        "ceiling-usd",
        "timezone",
        "actor",
        "pools",
      ],
      [
        "tenant",
        "agent",
        "objective",
        "capabilities",
        "data-classes",
        "ceiling-usd",
        "timezone",
        "actor",
      ],
    ),
  ],
  ["decisions", grammar(true, ["tenant"])],
  ["economics", grammar(true, ["tenant", "since"], ["tenant"])],
  [
    "outcome record",
    grammar(
      false,
      ["tenant", "decision", "outcome", "actor", "value-usd", "observed-at"],
      ["tenant", "decision", "outcome", "actor"],
    ),
  ],
]);

/** The only commands that change state. */
export const MODEL_ACTS: readonly string[] = Object.freeze(
  [...COMMANDS].filter(([, g]) => !g.readOnly).map(([name]) => name),
);

const YES_NO = new Set(["yes", "no"]);
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const USD = /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,6})?$/;
const LIST = /^[a-z0-9][a-z0-9_.:/-]*(,[a-z0-9][a-z0-9_.:/-]*)*$/i;
const POOLS = /^[a-z_]+=[a-z_]+(,[a-z_]+=[a-z_]+)*$/;

export type ModelsCommand =
  | { readonly kind: "usage_error"; readonly message: string }
  | {
      readonly kind: CommandName;
      readonly values: ReadonlyMap<string, string>;
    };

/** Pure: syntax only. What a value means is the database's. */
export function parseModelsArgs(argv: readonly string[]): ModelsCommand {
  const [first, second, ...rest] = argv;
  const twoWord = `${first ?? ""} ${second ?? ""}` as CommandName;
  const [name, tokens] = COMMANDS.has(twoWord)
    ? [twoWord, rest]
    : [first as CommandName, argv.slice(1)];
  const command = COMMANDS.get(name);
  if (command === undefined || (first ?? "").includes(" ")) {
    return {
      kind: "usage_error",
      message:
        first === undefined
          ? "no command given"
          : `unknown command ${JSON.stringify(argv.slice(0, 2).join(" "))}`,
    };
  }
  const parsed = parseFlags(tokens, {
    command: name,
    accepted: command.flags,
    required: command.required,
    takenElsewhere: (flag) =>
      [...COMMANDS.values()].some((other) => other.flags.has(flag)),
  });
  if (!parsed.ok) return { kind: "usage_error", message: parsed.message };
  const values = parsed.flags.values;
  for (const flag of ["structured", "reasoning", "tools"]) {
    const value = values.get(flag);
    if (value !== undefined && !YES_NO.has(value)) {
      return { kind: "usage_error", message: `--${flag} is yes or no` };
    }
  }
  for (const flag of ["since", "observed-at"]) {
    const value = values.get(flag);
    if (value !== undefined && !INSTANT.test(value)) {
      return {
        kind: "usage_error",
        message: `--${flag} must be an ISO 8601 instant with its offset`,
      };
    }
  }
  for (const flag of ["ceiling-usd", "value-usd"]) {
    const value = values.get(flag);
    if (value !== undefined && !USD.test(value)) {
      return {
        kind: "usage_error",
        message: `--${flag} is a decimal number of US dollars`,
      };
    }
  }
  for (const flag of ["capabilities", "data-classes", "accepted-builds"]) {
    const value = values.get(flag);
    if (value !== undefined && !LIST.test(value)) {
      return {
        kind: "usage_error",
        message: `--${flag} is a comma-separated list`,
      };
    }
  }
  const pools = values.get("pools");
  if (pools !== undefined && !POOLS.test(pools)) {
    return { kind: "usage_error", message: "--pools is capability=pool,..." };
  }
  const rank = values.get("rank");
  if (rank !== undefined && !/^[1-9][0-9]?$/.test(rank)) {
    return { kind: "usage_error", message: "--rank is 1 to 99" };
  }
  return { kind: name, values };
}

const micros = (usd: string): string => {
  const [whole, fraction = ""] = usd.split(".");
  return (
    BigInt(whole) * 1_000_000n +
    BigInt((fraction + "000000").slice(0, 6))
  ).toString();
};

const list = (value: string | undefined): string[] =>
  value ? value.split(",") : [];

async function run(
  tx: TxClient,
  command: Exclude<ModelsCommand, { kind: "usage_error" }>,
): Promise<readonly object[]> {
  const get = (flag: string): string => command.values.get(flag) as string;
  const optional = (flag: string): string | undefined =>
    command.values.get(flag);
  const yes = (flag: string) => get(flag) === "yes";
  const one = async (
    sql: string,
    params: readonly unknown[],
  ): Promise<unknown> =>
    (await tx.query<{ v: unknown }>(sql, params)).rows[0]?.v;

  switch (command.kind) {
    case "list": {
      const { rows } = await tx.query(
        `select r.gateway, r.model, r.family, r.enabled, r.structured_output as "structuredOutput",
                r.reasoning, r.context_class as "contextClass", r.latency_class as "latencyClass",
                r.cost_class as "costClass", r.accepted_builds as "acceptedBuilds",
                coalesce((select jsonb_agg(jsonb_build_object('pool', m.pool, 'rank', m.rank) order by m.pool)
                            from ops.model_pool_members m where m.registry_id = r.id and m.removed_at is null),
                         '[]'::jsonb) as pools,
                ops.current_model_price(r.gateway, r.model, now()) is not null as priced
           from ops.model_registry r order by r.gateway, r.model`,
      );
      return rows;
    }
    case "record":
      return [
        {
          result: "recorded",
          modelId: await one(
            "select ops.record_model($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as v",
            [
              get("gateway"),
              get("model"),
              get("family"),
              list(optional("accepted-builds")),
              yes("structured"),
              yes("reasoning"),
              yes("tools"),
              get("context"),
              get("latency"),
              get("cost"),
              get("source"),
              get("actor"),
            ],
          ),
        },
      ];
    case "enable":
    case "disable":
      return [
        {
          result: await one(
            "select ops.set_model_enabled($1, $2, $3, $4, $5) as v",
            [
              get("gateway"),
              get("model"),
              command.kind === "enable",
              get("reason"),
              get("actor"),
            ],
          ),
          gateway: get("gateway"),
          model: get("model"),
        },
      ];
    case "pool add":
      return [
        {
          result: "added",
          memberId: await one(
            "select ops.add_model_pool_member($1, $2, $3, $4, $5) as v",
            [
              get("pool"),
              get("gateway"),
              get("model"),
              Number(get("rank")),
              get("actor"),
            ],
          ),
        },
      ];
    case "pool remove":
      return [
        {
          result: await one(
            "select ops.remove_model_pool_member($1, $2, $3, $4, $5) as v",
            [
              get("pool"),
              get("gateway"),
              get("model"),
              get("reason"),
              get("actor"),
            ],
          ),
        },
      ];
    case "profiles": {
      const { rows } = await tx.query(
        `select p.id, p.tenant_id as "tenantId", p.agent_id as "agentId", p.capabilities,
                p.data_classes as "dataClasses", p.daily_cost_ceiling_micros::text as "dailyCostCeilingMicros",
                p.timezone, p.capability_pools as "capabilityPools", p.recorded_at as "recordedAt"
           from ops.agent_profiles p
          where p.superseded_at is null and ($1::uuid is null or p.tenant_id = $1)
          order by p.recorded_at`,
        [optional("tenant") ?? null],
      );
      return rows;
    }
    case "profile record": {
      const pools: Record<string, string> = {};
      for (const pair of list(optional("pools"))) {
        const [capability, pool] = pair.split("=");
        pools[capability] = pool;
      }
      return [
        {
          result: "recorded",
          profileId: await one(
            "select ops.record_agent_profile($1, $2, $3, $4, $5, $6::bigint, $7, $8::jsonb, $9) as v",
            [
              get("tenant"),
              get("agent"),
              get("objective"),
              list(get("capabilities")),
              list(get("data-classes")),
              micros(get("ceiling-usd")),
              get("timezone"),
              JSON.stringify(pools),
              get("actor"),
            ],
          ),
        },
      ];
    }
    case "decisions":
      return [
        {
          summary: await one(
            "select ops.structured_decision_summary($1) as v",
            [get("tenant")],
          ),
        },
      ];
    case "economics":
      return [
        {
          economics: await one(
            "select ops.model_economics($1, coalesce($2::timestamptz, now() - interval '30 days')) as v",
            [get("tenant"), optional("since") ?? null],
          ),
        },
      ];
    case "outcome record":
      return [
        {
          result: "recorded",
          outcomeId: await one(
            "select ops.record_decision_outcome($1, $2, $3, $4::bigint, $5::timestamptz, $6) as v",
            [
              get("tenant"),
              get("decision"),
              get("outcome"),
              optional("value-usd") ? micros(get("value-usd")) : null,
              optional("observed-at") ?? null,
              get("actor"),
            ],
          ),
        },
      ];
  }
}

export interface ModelsCliDependencies {
  /** Only ADMIN_DATABASE_URL is ever read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

export async function runModelsCli(
  argv: readonly string[],
  dependencies: ModelsCliDependencies,
): Promise<number> {
  const { stdout, stderr } = dependencies;
  const command = parseModelsArgs(argv);
  if (command.kind === "usage_error") {
    stderr(usageLine(command.message, MODELS_SYNOPSIS));
    return EXIT_USAGE;
  }
  const connectionString = readAdminDatabaseUrl(dependencies.env);
  if (connectionString === undefined) {
    stderr(missingAdminUrlLine());
    return EXIT_USAGE;
  }
  return runOwnerTransaction({
    connectionString,
    openDatabase: dependencies.openDatabase,
    streams: { stdout, stderr },
    work: async (tx) => {
      if (COMMANDS.get(command.kind)?.readOnly)
        await tx.query("set transaction read only");
      return run(tx, command);
    },
  });
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runModelsCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 1 }),
  });
}

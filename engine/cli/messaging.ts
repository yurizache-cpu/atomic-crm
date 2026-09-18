// The operator's messaging tool (Phase 2B).
//
//   npm run messaging -- channels list [--tenant <uuid>]
//   npm run messaging -- channels set --tenant <uuid> --company <uuid> --agent <uuid>
//                                      --target <phone number id> --mode test|production
//                                      --label <text> --actor <label> [--inactive]
//   npm run messaging -- send --review <uuid> --tenant <uuid> --operator <label>
//   npm run messaging -- outbound list [--tenant <uuid>] [--status <status>] [--limit <n>]
//   npm run messaging -- outbound show --id <uuid> [--tenant <uuid>]
//   npm run messaging -- outbound mark-indeterminate --id <uuid> --tenant <uuid> --operator <label>
//
// `send` IS THE ONLY WAY A MESSAGE LEAVES. Accepting a review (`npm run ops --
// triage accept`) sends nothing; `send` is the separate, deliberate act that
// asks for one accepted review's draft to be sent. The database decides whether
// it may be sent, twice and freshly (ops.request_outbound_send, then
// ops.begin_outbound_send), and the provider is called at most once. There is
// no retry command: an indeterminate send is resolved by the provider's status
// callbacks, never by sending again.
//
// OWNER ONLY. ADMIN_DATABASE_URL, as `npm run ops`. `send` also reads
// WHATSAPP_ACCESS_TOKEN, and only `send` does. Neither is ever printed.
//
// OUTPUT. One JSON object per line on stdout. Exit 0 on success, 2 on a usage
// error, 1 when the database or the domain refused: one JSON line on stderr.

import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import type { OutboundTransport } from "../communication/types.ts";
import { createMetaWhatsAppTransport } from "../communication/whatsapp/metaSender.ts";
import {
  configureWhatsAppChannel,
  isChannelMode,
  listChannels,
} from "../domain/communicationChannels.ts";
import {
  isOutboundStatus,
  listOutbound,
  markOutboundIndeterminate,
  readOutbound,
  readSendEligibility,
  type OutboundStatus,
} from "../domain/outboundMessages.ts";
import { sendApprovedReview } from "../domain/outboundSend.ts";
import {
  describeFailure,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  isEntryPoint,
  jsonLine,
  missingAdminUrlLine,
  parseFlags,
  readAdminDatabaseUrl,
  runOwnerTransaction,
  usageLine,
  type FlagArity,
} from "./cliOutput.ts";

export const ACCESS_TOKEN_VARIABLE = "WHATSAPP_ACCESS_TOKEN";

export const MESSAGING_SYNOPSIS =
  "npm run messaging -- channels list [--tenant <uuid>] | channels set --tenant <uuid> --company <uuid> --agent <uuid> --target <phone number id> --mode test|production --label <text> --actor <label> [--inactive] | send --review <uuid> --tenant <uuid> --operator <label> | outbound list [--tenant <uuid>] [--status <status>] [--limit <n>] | outbound show --id <uuid> [--tenant <uuid>] | outbound mark-indeterminate --id <uuid> --tenant <uuid> --operator <label>";

type CommandName =
  | "channels list"
  | "channels set"
  | "send"
  | "outbound list"
  | "outbound show"
  | "outbound mark-indeterminate";

const v = (...names: string[]): [string, FlagArity][] =>
  names.map((name) => [name, "value"]);

const FLAGS: ReadonlyMap<CommandName, ReadonlyMap<string, FlagArity>> = new Map(
  [
    ["channels list", new Map(v("tenant"))],
    [
      "channels set",
      new Map<string, FlagArity>([
        ...v("tenant", "company", "agent", "target", "mode", "label", "actor"),
        ["inactive", "switch"],
      ]),
    ],
    ["send", new Map(v("review", "tenant", "operator"))],
    ["outbound list", new Map(v("tenant", "status", "limit"))],
    ["outbound show", new Map(v("id", "tenant"))],
    ["outbound mark-indeterminate", new Map(v("id", "tenant", "operator"))],
  ],
);

const REQUIRED: ReadonlyMap<CommandName, readonly string[]> = new Map([
  ["channels list", []],
  [
    "channels set",
    ["tenant", "company", "agent", "target", "mode", "label", "actor"],
  ],
  ["send", ["review", "tenant", "operator"]],
  ["outbound list", []],
  ["outbound show", ["id"]],
  ["outbound mark-indeterminate", ["id", "tenant", "operator"]],
]);

export type MessagingCommand =
  | { readonly kind: "usage_error"; readonly message: string }
  | {
      readonly kind: CommandName;
      readonly values: ReadonlyMap<string, string>;
      readonly switches: ReadonlySet<string>;
    };

/** Pure: syntax only. What a value means is the domain's and the database's answer. */
export function parseMessagingArgs(argv: readonly string[]): MessagingCommand {
  const [first, second, ...rest] = argv;
  const twoWord = `${first ?? ""} ${second ?? ""}` as CommandName;
  const [name, tokens] = FLAGS.has(twoWord)
    ? [twoWord, rest]
    : [first as CommandName, argv.slice(1)];
  if (!FLAGS.has(name)) {
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
    accepted: FLAGS.get(name) ?? new Map(),
    required: REQUIRED.get(name) ?? [],
    takenElsewhere: (flag) =>
      [...FLAGS.values()].some((flags) => flags.has(flag)),
  });
  if (!parsed.ok) return { kind: "usage_error", message: parsed.message };
  if (
    name === "channels set" &&
    !isChannelMode(parsed.flags.values.get("mode"))
  ) {
    return {
      kind: "usage_error",
      message: "--mode must be test or production",
    };
  }
  const status = parsed.flags.values.get("status");
  if (status !== undefined && !isOutboundStatus(status)) {
    return {
      kind: "usage_error",
      message: "--status is not an outbound status",
    };
  }
  const limit = parsed.flags.values.get("limit");
  if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) {
    return { kind: "usage_error", message: "--limit is 1 to 200" };
  }
  return {
    kind: name,
    values: parsed.flags.values,
    switches: parsed.flags.switches,
  };
}

export interface MessagingCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
  /** Builds the provider transport for `send`. Production: the Meta Cloud API. */
  readonly openTransport?: (accessToken: string) => OutboundTransport;
}

export async function runMessagingCli(
  argv: readonly string[],
  dependencies: MessagingCliDependencies,
): Promise<number> {
  const { stdout, stderr, env } = dependencies;
  const command = parseMessagingArgs(argv);
  if (command.kind === "usage_error") {
    stderr(usageLine(command.message, MESSAGING_SYNOPSIS));
    return EXIT_USAGE;
  }
  const connectionString = readAdminDatabaseUrl(env);
  if (connectionString === undefined) {
    stderr(missingAdminUrlLine());
    return EXIT_USAGE;
  }
  const get = (flag: string): string | undefined => command.values.get(flag);

  if (command.kind === "send") {
    const token = env[ACCESS_TOKEN_VARIABLE];
    if (typeof token !== "string" || token === "") {
      stderr(
        jsonLine({
          error: "usage",
          message: `${ACCESS_TOKEN_VARIABLE} is required to send: the Meta access token, read from the environment only`,
        }),
      );
      return EXIT_USAGE;
    }
    const transport = (
      dependencies.openTransport ??
      ((accessToken: string) => createMetaWhatsAppTransport({ accessToken }))
    )(token);
    const db = dependencies.openDatabase(connectionString);
    try {
      const report = await sendApprovedReview(db, transport, {
        tenantId: get("tenant") as string,
        reviewId: get("review") as string,
        requestedBy: get("operator") as string,
        source: "operator-cli",
      });
      stdout(jsonLine(report));
      return EXIT_OK;
    } catch (error) {
      stderr(jsonLine(describeFailure(error, true)));
      return EXIT_REFUSED;
    } finally {
      try {
        await db.close();
      } catch {
        stderr(
          jsonLine({ warning: "the database pool did not close cleanly" }),
        );
      }
    }
  }

  return runOwnerTransaction({
    connectionString,
    openDatabase: dependencies.openDatabase,
    streams: { stdout, stderr },
    work: async (tx) => {
      switch (command.kind) {
        case "channels list":
          return listChannels(tx, { tenantId: get("tenant") });
        case "channels set":
          return [
            {
              channelId: await configureWhatsAppChannel(tx, {
                tenantId: get("tenant") as string,
                companyId: get("company") as string,
                agentId: get("agent") as string,
                providerTarget: get("target") as string,
                mode: get("mode") as "test" | "production",
                label: get("label") as string,
                actor: get("actor") as string,
                active: !command.switches.has("inactive"),
              }),
            },
          ];
        case "outbound list":
          return listOutbound(tx, {
            tenantId: get("tenant"),
            status: get("status") as OutboundStatus | undefined,
            limit:
              get("limit") === undefined ? undefined : Number(get("limit")),
          });
        case "outbound show": {
          const row = await readOutbound(tx, get("id") as string, {
            tenantId: get("tenant"),
          });
          if (row === null) return [];
          // What a send attempted now would meet, read fresh. Informational:
          // only ops.begin_outbound_send's own check decides.
          const now = await readSendEligibility(
            tx,
            row.tenantId,
            row.conversationId,
          );
          return [
            { ...row, eligibleNow: now.eligible, ineligibleReason: now.reason },
          ];
        }
        case "outbound mark-indeterminate":
          await markOutboundIndeterminate(
            tx,
            get("tenant") as string,
            get("id") as string,
            get("operator") as string,
          );
          return [{ outboundMessageId: get("id"), status: "indeterminate" }];
        case "send":
          // Handled above, outside a single transaction: it is three.
          throw new Error("send does not run as one owner transaction");
      }
    },
  });
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runMessagingCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 2 }),
  });
}

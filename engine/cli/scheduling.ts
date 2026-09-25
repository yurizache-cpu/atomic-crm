// The owner's scheduling tool (Phase 3A).
//
//   npm run scheduling -- followups [--tenant <uuid>] [--status <status>] [--limit <n>]
//   npm run scheduling -- followup complete --tenant <uuid> --id <uuid> --actor <label>
//   npm run scheduling -- followup cancel --tenant <uuid> --id <uuid> --reason <code> --actor <label>
//   npm run scheduling -- bookings [--tenant <uuid>] [--status <status>] [--from <instant>] [--limit <n>]
//   npm run scheduling -- slots --tenant <uuid> --resource <uuid> --type <uuid>
//                        --from <instant> --until <instant> [--limit <n>]
//   npm run scheduling -- booking create --tenant <uuid> --resource <uuid> --type <uuid>
//                        --start <instant> --subject-ref <ref> --key <idempotency key> --actor <label>
//   npm run scheduling -- booking reschedule --tenant <uuid> --id <uuid> --start <instant>
//                        --key <idempotency key> --actor <label>
//   npm run scheduling -- booking cancel --tenant <uuid> --id <uuid> --reason <code> --actor <label>
//
// READ-ONLY BY DEFAULT. followups, bookings and slots run inside a read-only
// transaction. The tool changes state only through its explicit allowlist of
// acts (SCHEDULING_ACTS): completing or cancelling one follow-up, and
// creating, rescheduling or cancelling one booking. Each is one recorded,
// idempotent owner act (a repeat is harmless, a booking act is keyed), with a
// reason CODE where it closes something, never free text. No act sends a
// message, calls a model or a calendar, writes the CRM, trips or clears a stop,
// or changes configuration; there is no browser counterpart. Follow-ups become
// due only through the worker's governed job, never through this tool.
//
// TIME. An instant must carry its offset (2030-03-04T10:00:00-03:00 or ...Z):
// a local clock time without one is ambiguous and is refused, never guessed.
//
// OWNER ONLY. The one variable read is ADMIN_DATABASE_URL. OUTPUT: one JSON
// object per line, ids, instants, states and reason codes only: never a
// subject reference, an actor label, an idempotency key or a connection string.
// Exit 0, 2 on a usage error, 1 when the database or the domain refused.

import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  availableSlots,
  BOOKING_STATUSES,
  cancelBooking,
  createBooking,
  listBookings,
  rescheduleBooking,
  type BookingStatus,
} from "../domain/bookings.ts";
import {
  cancelFollowUp,
  completeFollowUp,
  isFollowUpStatus,
  listFollowUps,
  type FollowUpStatus,
} from "../domain/followUps.ts";
import type { SchedulingContext } from "../domain/schedulingCommon.ts";
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

export const SCHEDULING_SYNOPSIS =
  "npm run scheduling -- followups [--tenant <uuid>] [--status <status>] [--limit <n>] | followup complete --tenant <uuid> --id <uuid> --actor <label> | followup cancel --tenant <uuid> --id <uuid> --reason <code> --actor <label> | bookings [--tenant <uuid>] [--status <status>] [--from <instant>] [--limit <n>] | slots --tenant <uuid> --resource <uuid> --type <uuid> --from <instant> --until <instant> [--limit <n>] | booking create --tenant <uuid> --resource <uuid> --type <uuid> --start <instant> --subject-ref <ref> --key <key> --actor <label> | booking reschedule --tenant <uuid> --id <uuid> --start <instant> --key <key> --actor <label> | booking cancel --tenant <uuid> --id <uuid> --reason <code> --actor <label>";

/** The provenance every act records. */
export const SCHEDULING_SOURCE = "operator-cli";

const READ_ONLY_TRANSACTION = "set transaction read only";

type CommandName =
  | "followups"
  | "followup complete"
  | "followup cancel"
  | "bookings"
  | "slots"
  | "booking create"
  | "booking reschedule"
  | "booking cancel";

interface Grammar {
  readonly flags: ReadonlyMap<string, FlagArity>;
  readonly required: readonly string[];
  readonly readOnly: boolean;
}

const grammar = (
  readOnly: boolean,
  flags: readonly string[],
  required: readonly string[] = [],
): Grammar => ({
  flags: new Map(flags.map((name) => [name, "value" as FlagArity])),
  required,
  readOnly,
});

const COMMANDS: ReadonlyMap<CommandName, Grammar> = new Map([
  ["followups", grammar(true, ["tenant", "status", "limit"])],
  [
    "followup complete",
    grammar(false, ["tenant", "id", "actor"], ["tenant", "id", "actor"]),
  ],
  [
    "followup cancel",
    grammar(
      false,
      ["tenant", "id", "reason", "actor"],
      ["tenant", "id", "reason", "actor"],
    ),
  ],
  ["bookings", grammar(true, ["tenant", "status", "from", "limit"])],
  [
    "slots",
    grammar(
      true,
      ["tenant", "resource", "type", "from", "until", "limit"],
      ["tenant", "resource", "type", "from", "until"],
    ),
  ],
  [
    "booking create",
    grammar(
      false,
      ["tenant", "resource", "type", "start", "subject-ref", "key", "actor"],
      ["tenant", "resource", "type", "start", "subject-ref", "key", "actor"],
    ),
  ],
  [
    "booking reschedule",
    grammar(
      false,
      ["tenant", "id", "start", "key", "actor"],
      ["tenant", "id", "start", "key", "actor"],
    ),
  ],
  [
    "booking cancel",
    grammar(
      false,
      ["tenant", "id", "reason", "actor"],
      ["tenant", "id", "reason", "actor"],
    ),
  ],
]);

/** The only commands that change state, in order. */
export const SCHEDULING_ACTS: readonly string[] = Object.freeze(
  [...COMMANDS].filter(([, g]) => !g.readOnly).map(([name]) => name),
);

/** An ISO 8601 instant WITH its offset: a local time without one is refused. */
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const LIMIT = /^[1-9][0-9]{0,2}$/;

export type SchedulingCommand =
  | { readonly kind: "usage_error"; readonly message: string }
  | {
      readonly kind: CommandName;
      readonly values: ReadonlyMap<string, string>;
    };

/** Pure: syntax only. What a value means is the domain's and the database's. */
export function parseSchedulingArgs(
  argv: readonly string[],
): SchedulingCommand {
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
  for (const flag of ["start", "from", "until"]) {
    const value = values.get(flag);
    if (value !== undefined && !INSTANT.test(value)) {
      return {
        kind: "usage_error",
        message: `--${flag} must be an ISO 8601 instant with its offset (Z or ±hh:mm); a local time alone is ambiguous`,
      };
    }
  }
  const limit = values.get("limit");
  if (limit !== undefined && !LIMIT.test(limit)) {
    return { kind: "usage_error", message: "--limit is 1 to 999" };
  }
  const status = values.get("status");
  if (
    status !== undefined &&
    (name === "followups"
      ? !isFollowUpStatus(status)
      : !BOOKING_STATUSES.includes(status as BookingStatus))
  ) {
    return { kind: "usage_error", message: "--status is not a known state" };
  }
  return { kind: name, values };
}

export const isReadOnlyCommand = (name: CommandName): boolean =>
  COMMANDS.get(name)?.readOnly === true;

async function run(
  tx: Parameters<typeof listFollowUps>[0],
  command: Exclude<SchedulingCommand, { kind: "usage_error" }>,
): Promise<readonly object[]> {
  const get = (flag: string): string => command.values.get(flag) as string;
  const optional = (flag: string): string | undefined =>
    command.values.get(flag);
  const limit = optional("limit") ? Number(optional("limit")) : undefined;
  const context = (): SchedulingContext => ({
    tenantId: get("tenant"),
    source: SCHEDULING_SOURCE,
    actor: get("actor"),
  });
  switch (command.kind) {
    case "followups":
      return listFollowUps(tx, {
        tenantId: optional("tenant"),
        status: optional("status") as FollowUpStatus | undefined,
        limit,
      });
    case "bookings":
      return listBookings(tx, {
        tenantId: optional("tenant"),
        status: optional("status") as BookingStatus | undefined,
        from: optional("from") ? new Date(get("from")) : undefined,
        limit,
      });
    case "slots":
      return availableSlots(tx, get("tenant"), {
        resourceId: get("resource"),
        bookingTypeId: get("type"),
        from: new Date(get("from")),
        until: new Date(get("until")),
        limit,
      });
    case "followup complete":
      return [
        {
          result: await completeFollowUp(tx, context(), get("id")),
          followUpId: get("id"),
        },
      ];
    case "followup cancel":
      return [
        {
          result: await cancelFollowUp(tx, context(), get("id"), get("reason")),
          followUpId: get("id"),
        },
      ];
    case "booking create": {
      const booked = await createBooking(tx, context(), {
        resourceId: get("resource"),
        bookingTypeId: get("type"),
        startAt: new Date(get("start")),
        subject: { subjectRef: get("subject-ref") },
        idempotencyKey: get("key"),
      });
      return [
        { result: booked.created ? "booked" : "already_booked", ...booked },
      ];
    }
    case "booking reschedule": {
      const moved = await rescheduleBooking(
        tx,
        context(),
        get("id"),
        new Date(get("start")),
        get("key"),
      );
      return [
        {
          result: moved.created ? "rescheduled" : "already_rescheduled",
          ...moved,
        },
      ];
    }
    case "booking cancel":
      return [
        {
          result: await cancelBooking(tx, context(), get("id"), get("reason")),
          bookingId: get("id"),
        },
      ];
  }
}

export interface SchedulingCliDependencies {
  /** Only ADMIN_DATABASE_URL is ever read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

/** Runs one command and resolves to the process exit code. Never rejects on a database failure. */
export async function runSchedulingCli(
  argv: readonly string[],
  dependencies: SchedulingCliDependencies,
): Promise<number> {
  const { stdout, stderr } = dependencies;
  const command = parseSchedulingArgs(argv);
  if (command.kind === "usage_error") {
    stderr(usageLine(command.message, SCHEDULING_SYNOPSIS));
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
      if (isReadOnlyCommand(command.kind)) {
        await tx.query(READ_ONLY_TRANSACTION);
      }
      return run(tx, command);
    },
  });
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runSchedulingCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    // One connection: a command is one transaction.
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 1 }),
  });
}

// `npm run ops -- retention list | erase | sweep` (BASELINE Q8, owner decisions
// D6 and D7): the owner's view of the AI working-content retention ledger and
// the owner's two acts over it. Kept apart from operator.ts, which wires it in.
//
//   npm run ops -- retention list [--tenant <uuid>]
//   npm run ops -- retention erase --tenant <uuid> --task <uuid> --actor <label>
//   npm run ops -- retention sweep --actor <label> [--limit <n>]
//
// `list` prints ids, classes, instants and reasons: the ledger holds no content.
// `erase` redacts one health or person_text task's flow now, in its tenant only
// (D7). `sweep` redacts, bounded, the flows whose clock has ended and the
// worker has not reached (D6). Neither deletes anything; the worker's own
// retention job does the same at each flow's due instant without either.

import type { TxClient } from "../db/types.ts";
import {
  eraseTaskContent,
  listContentRetention,
  sweepContentRetention,
} from "../domain/contentRetention.ts";

export const RETENTION_SYNOPSIS =
  "retention list [--tenant <uuid>] | retention erase --tenant <uuid> --task <uuid> --actor <label> | retention sweep --actor <label> [--limit <n>]";

export const RETENTION_ERASE_FLAGS: readonly string[] = Object.freeze([
  "tenant",
  "task",
  "actor",
]);

const LIMIT_TEXT = /^[0-9]{1,4}$/;

export type RetentionReadCommand = {
  readonly kind: "retention list";
  readonly tenantId?: string;
};

export type RetentionActCommand =
  | {
      readonly kind: "retention erase";
      readonly tenantId: string;
      readonly taskId: string;
      readonly actor: string;
    }
  | {
      readonly kind: "retention sweep";
      readonly limit?: number;
      readonly actor: string;
    };

export type RetentionParse =
  | RetentionReadCommand
  | RetentionActCommand
  | { readonly kind: "usage_error"; readonly message: string };

/** Syntax only: whether the values are valid is the domain's answer, and the database's. */
export function buildRetentionCommand(
  name: "retention list" | "retention erase" | "retention sweep",
  values: ReadonlyMap<string, string>,
): RetentionParse {
  switch (name) {
    case "retention list":
      return { kind: name, tenantId: values.get("tenant") };
    case "retention erase":
      return {
        kind: name,
        tenantId: values.get("tenant") as string,
        taskId: values.get("task") as string,
        actor: values.get("actor") as string,
      };
    case "retention sweep": {
      const limitText = values.get("limit");
      if (limitText !== undefined && !LIMIT_TEXT.test(limitText)) {
        return {
          kind: "usage_error",
          message: "--limit must be a whole number",
        };
      }
      return {
        kind: name,
        limit: limitText === undefined ? undefined : Number(limitText),
        actor: values.get("actor") as string,
      };
    }
  }
}

export function runRetentionRead(
  tx: TxClient,
  command: RetentionReadCommand,
): Promise<readonly object[]> {
  return listContentRetention(tx, { tenantId: command.tenantId });
}

export async function runRetentionAct(
  tx: TxClient,
  command: RetentionActCommand,
): Promise<readonly object[]> {
  if (command.kind === "retention erase") {
    const erased = await eraseTaskContent(tx, {
      tenantId: command.tenantId,
      taskId: command.taskId,
      actor: command.actor,
    });
    return [{ result: erased.status, taskId: erased.taskId }];
  }
  const swept = await sweepContentRetention(tx, {
    limit: command.limit,
    actor: command.actor,
  });
  return [
    {
      result: "swept",
      redacted: swept.redacted,
      inProgress: swept.inProgress,
    },
  ];
}

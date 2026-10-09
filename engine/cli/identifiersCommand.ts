// `npm run ops -- identifiers list | erase | sweep` (ADR 0021 W5, decided
// 2026-10-04 by owner delegation): the owner's view of the WhatsApp sender
// numbers' retention ledger and the owner's two acts over it. Kept apart from
// operator.ts, which wires it in.
//
//   npm run ops -- identifiers list [--tenant <uuid>]
//   npm run ops -- identifiers erase --tenant <uuid> --number <digits>|--number-file <path> --actor <label>
//   npm run ops -- identifiers sweep --actor <label> [--limit <n>]
//
// `list` prints conversation ids, instants and reasons: the ledger holds no
// number. `erase` answers a person's request: their number leaves every
// conversation of the tenant now, with the AI working content of every
// protected flow it admitted (refused, nothing erased, while such a flow is in
// progress). The number is an input only: nothing prints it; `--number-file`
// reads it from a file (ADR 0026 §D), so it stays out of the shell's history.
// `sweep` erases,
// bounded, the numbers whose 12 months ended and the worker has not reached.
// Neither deletes anything; the worker's own job does the same at each due
// instant without either.

import type { TxClient } from "../db/types.ts";
import {
  eraseContactByNumber,
  listContactIdentifierRetention,
  sweepContactIdentifierRetention,
} from "../domain/contactIdentifiers.ts";

export const IDENTIFIERS_SYNOPSIS =
  "identifiers list [--tenant <uuid>] | identifiers erase --tenant <uuid> --number <digits>|--number-file <path> --actor <label> | identifiers sweep --actor <label> [--limit <n>]";

export const IDENTIFIERS_ERASE_FLAGS: readonly string[] = Object.freeze([
  "tenant",
  "number",
  "number-file",
  "actor",
]);

/** The erase's required flags: the number comes from exactly one of the two. */
export const IDENTIFIERS_ERASE_REQUIRED: readonly string[] = Object.freeze([
  "tenant",
  "actor",
]);

const LIMIT_TEXT = /^[0-9]{1,4}$/;

export type IdentifiersReadCommand = {
  readonly kind: "identifiers list";
  readonly tenantId?: string;
};

export type IdentifiersActCommand =
  | {
      readonly kind: "identifiers erase";
      readonly tenantId: string;
      /** Given inline, or read from `numberFile` before the transaction. */
      readonly number?: string;
      readonly numberFile?: string;
      readonly actor: string;
    }
  | {
      readonly kind: "identifiers sweep";
      readonly limit?: number;
      readonly actor: string;
    };

export type IdentifiersParse =
  | IdentifiersReadCommand
  | IdentifiersActCommand
  | { readonly kind: "usage_error"; readonly message: string };

/** Syntax only: whether the values are valid is the domain's answer, and the database's. */
export function buildIdentifiersCommand(
  name: "identifiers list" | "identifiers erase" | "identifiers sweep",
  values: ReadonlyMap<string, string>,
): IdentifiersParse {
  switch (name) {
    case "identifiers list":
      return { kind: name, tenantId: values.get("tenant") };
    case "identifiers erase": {
      const number = values.get("number");
      const numberFile = values.get("number-file");
      if ((number === undefined) === (numberFile === undefined)) {
        return {
          kind: "usage_error",
          message:
            "name the number with exactly one of --number and --number-file",
        };
      }
      return {
        kind: name,
        tenantId: values.get("tenant") as string,
        number,
        numberFile,
        actor: values.get("actor") as string,
      };
    }
    case "identifiers sweep": {
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

export function runIdentifiersRead(
  tx: TxClient,
  command: IdentifiersReadCommand,
): Promise<readonly object[]> {
  return listContactIdentifierRetention(tx, { tenantId: command.tenantId });
}

export async function runIdentifiersAct(
  tx: TxClient,
  command: IdentifiersActCommand,
): Promise<readonly object[]> {
  if (command.kind === "identifiers erase") {
    const erased = await eraseContactByNumber(tx, {
      tenantId: command.tenantId,
      number: command.number ?? "",
      actor: command.actor,
    });
    // Never the number: a count only.
    return [
      { result: "erased", conversationsErased: erased.conversationsErased },
    ];
  }
  const swept = await sweepContactIdentifierRetention(tx, {
    limit: command.limit,
    actor: command.actor,
  });
  return [{ result: "swept", erased: swept.erased }];
}

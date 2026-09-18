// The text rules every agent run capability shares.
//
// Extracted when Phase 2A added a second capability (`lead_triage`) beside
// `task_assessment`. Both build a prompt from the same bounded context that
// ops.claim_agent_run() returns, and both must refuse the same text a jsonb
// column cannot hold — so the rules live here once rather than in each
// capability, where the second copy would be the one that drifts.
//
// taskAssessment.ts re-exports the names it exported before this file existed,
// so nothing that imported them had to change.

import { z } from "zod";

/** Blank text is not an answer. The database applies the same `\S` test. */
export const HAS_NON_WHITESPACE = /\S/;

/** With the `u` flag a surrogate pair is one code point, so this matches only an unpaired half. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/**
 * Text Postgres cannot hold at all: U+0000, and a surrogate that is not half of
 * a pair. Both are legal in a JavaScript string and as a JSON escape, and jsonb
 * refuses both on INPUT ("unsupported Unicode escape sequence", "Unicode low
 * surrogate must follow a high surrogate"). Admitting them here would make the
 * statement that stores the result throw before ops.agent_run_result_valid()
 * runs, instead of recording an answered call as failed.
 */
const NUL = String.fromCharCode(0);

export const isStorableText = (text: string): boolean =>
  !text.includes(NUL) && !UNPAIRED_SURROGATE.test(text);

/**
 * One non-blank, storable string of at most `maxLength` UTF-16 code units. The
 * database counts code points, and a code point is one or two code units, so a
 * string within this limit is always within the database's.
 */
export const boundedText = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(HAS_NON_WHITESPACE)
    .refine(isStorableText);

/** Exactly what ops.claim_agent_run() returns, camelCased by the handler. */
export interface AgentRunPromptContext {
  readonly agent: {
    readonly name: string;
    readonly role: string;
    readonly description: string | null;
  };
  readonly task: {
    readonly type: string;
    readonly title: string;
    readonly description: string | null;
    readonly priority: number;
    readonly dueAt: string | null;
  };
}

export interface BuiltPrompt {
  readonly promptVersion: string;
  readonly instructions: string;
  readonly input: string;
}

export const TASK_DESCRIPTION_MAX_LENGTH = 4000;
export const AGENT_DESCRIPTION_MAX_LENGTH = 2000;
export const TRUNCATION_MARKER = "…[truncated]";

// The database already bounds these (ops.agents name/role <= 200 and ops.tasks
// title <= 300 after trimming, type <= 100). Capping here too costs nothing and
// keeps a padded value from growing the prompt past what the columns imply.
export const AGENT_LABEL_MAX_LENGTH = 200;
export const TASK_TITLE_MAX_LENGTH = 300;
export const TASK_TYPE_MAX_LENGTH = 100;

/**
 * Keeps the first `maxLength` code units and marks the cut. Never splits a
 * surrogate pair: half a character is not text, and JSON.stringify would
 * escape it into noise the model then has to read.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const lastKept = text.charCodeAt(maxLength - 1);
  const end =
    lastKept >= 0xd800 && lastKept <= 0xdbff ? maxLength - 1 : maxLength;
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

export const truncateNullable = (
  text: string | null,
  maxLength: number,
): string | null => (text === null ? null : truncateText(text, maxLength));

/**
 * The agent and task fields every capability's prompt document carries, picked
 * and truncated. Fields are PICKED, never spread: the object the handler passes
 * may be wider than the type (ids, tenant, timestamps), and none of that may
 * reach a provider.
 */
export function promptDocumentFields(context: AgentRunPromptContext): {
  readonly agent: Record<string, unknown>;
  readonly task: Record<string, unknown>;
} {
  return {
    agent: {
      name: truncateText(context.agent.name, AGENT_LABEL_MAX_LENGTH),
      role: truncateText(context.agent.role, AGENT_LABEL_MAX_LENGTH),
      description: truncateNullable(
        context.agent.description,
        AGENT_DESCRIPTION_MAX_LENGTH,
      ),
    },
    task: {
      type: truncateText(context.task.type, TASK_TYPE_MAX_LENGTH),
      title: truncateText(context.task.title, TASK_TITLE_MAX_LENGTH),
      description: truncateNullable(
        context.task.description,
        TASK_DESCRIPTION_MAX_LENGTH,
      ),
      priority: context.task.priority,
      due_at: context.task.dueAt,
    },
  };
}

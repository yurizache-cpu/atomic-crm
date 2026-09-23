// The operation catalogue (docs/PHASE_2C_BRIEF.md §8): the 15 read RPCs of the
// function-only schema company_os_api, each with its exact argument names,
// PostgreSQL types and DEFAULTs, the input a client may send, and the response
// contract. engine/domain/companyOsContracts.dbtest.ts compares the catalogue
// with pg_proc.
//
// No operation takes a tenant, company, actor, reviewer, source or causation
// argument: the identity gate derives them. Every uuid argument is a selector
// resolved inside the caller's tenant. The two browser acts (decide_review,
// trip_stop) are NOT here: their functions exist in no database until the S7
// prerequisite is closed and S8 lands.
//
// The inputs are strict, so a client cannot send a key the function does not
// take; PostgREST would refuse it anyway (PGRST202), and the contract says so
// before a request leaves.

import { z } from "zod";
import { AgentDetailSchema, AgentListSchema } from "./agents.ts";
import { OperatorContextSchema, OverviewSummarySchema } from "./context.ts";
import {
  CompanyOsContractError,
  CompanyOsInputError,
  type ContractIssue,
} from "./errors.ts";
import { EventCursorSchema, EventListSchema } from "./events.ts";
import {
  CommunicationStatusSummarySchema,
  SpendSummarySchema,
} from "./governance.ts";
import { PageLimitSchema, UuidSchema } from "./primitives.ts";
import {
  ReviewAdviceSchema,
  ReviewCursorSchema,
  ReviewDetailSchema,
  ReviewListSchema,
} from "./reviews.ts";
import {
  AgentRunDetailSchema,
  AgentRunListSchema,
  RunCursorSchema,
} from "./runs.ts";
import { ExecutionStopListSchema, StopCursorSchema } from "./stops.ts";
import { TaskCursorSchema, TaskDetailSchema, TaskListSchema } from "./tasks.ts";
import {
  AgentRunStatusSchema,
  EventSubjectTypeSchema,
  ReviewStatusSchema,
  TaskStatusSchema,
} from "./vocabulary.ts";

export const COMPANY_OS_API_SCHEMA = "company_os_api";

/** An argument's type as PostgreSQL's format_type() names it. */
export type OperationArgumentType = "uuid" | "text" | "integer" | "boolean";

/** A DEFAULT as the function declares it. */
export type OperationArgumentDefault = string | number | boolean | null;

export interface OperationArgument {
  readonly name: string;
  readonly type: OperationArgumentType;
  /** Whether a call may omit it, so that the function's own DEFAULT applies. */
  readonly optional: boolean;
  /** That DEFAULT; always null for a required argument. */
  readonly defaultValue: OperationArgumentDefault;
}

/** The only names a uuid argument may carry (brief §7.3). */
export const SELECTOR_ARGUMENTS = [
  "p_agent_id",
  "p_task_id",
  "p_run_id",
  "p_review_id",
  "p_subject_id",
  "p_target_id",
] as const;

/** An argument with no DEFAULT: every call names it. */
const required = (
  name: string,
  type: OperationArgumentType,
): OperationArgument =>
  Object.freeze({ name, type, optional: false, defaultValue: null });

/** An argument with a DEFAULT, exactly as the S2 migration declares it. */
const defaulted = (
  name: string,
  type: OperationArgumentType,
  defaultValue: OperationArgumentDefault,
): OperationArgument =>
  Object.freeze({ name, type, optional: true, defaultValue });

const operation = <I extends z.ZodType, R extends z.ZodType>(
  args: readonly OperationArgument[],
  input: I,
  response: R,
) => Object.freeze({ args: Object.freeze([...args]), input, response });

const NoInputSchema = z.strictObject({});

/**
 * An argument with a DEFAULT. Omitted, the DEFAULT applies; null, every read
 * treats it as that DEFAULT (ops.cos_limit, and the coalesce of p_status,
 * p_attention_only and p_include_cleared), and a null cursor is the first page.
 */
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullable().optional();

export const COMPANY_OS_OPERATIONS = Object.freeze({
  operator_context: operation([], NoInputSchema, OperatorContextSchema),
  overview: operation([], NoInputSchema, OverviewSummarySchema),
  list_agents: operation([], NoInputSchema, AgentListSchema),
  get_agent: operation(
    [required("p_agent_id", "uuid")],
    z.strictObject({ p_agent_id: UuidSchema }),
    AgentDetailSchema,
  ),
  list_tasks: operation(
    [
      defaulted("p_cursor", "text", null),
      defaulted("p_status", "text", null),
      defaulted("p_agent_id", "uuid", null),
      defaulted("p_limit", "integer", 50),
    ],
    z.strictObject({
      p_cursor: optional(TaskCursorSchema),
      p_status: optional(TaskStatusSchema),
      p_agent_id: optional(UuidSchema),
      p_limit: optional(PageLimitSchema),
    }),
    TaskListSchema,
  ),
  get_task: operation(
    [required("p_task_id", "uuid")],
    z.strictObject({ p_task_id: UuidSchema }),
    TaskDetailSchema,
  ),
  list_runs: operation(
    [
      defaulted("p_cursor", "text", null),
      defaulted("p_status", "text", null),
      defaulted("p_agent_id", "uuid", null),
      defaulted("p_attention_only", "boolean", false),
      defaulted("p_limit", "integer", 50),
    ],
    z.strictObject({
      p_cursor: optional(RunCursorSchema),
      p_status: optional(AgentRunStatusSchema),
      p_agent_id: optional(UuidSchema),
      p_attention_only: optional(z.boolean()),
      p_limit: optional(PageLimitSchema),
    }),
    AgentRunListSchema,
  ),
  get_run: operation(
    [required("p_run_id", "uuid")],
    z.strictObject({ p_run_id: UuidSchema }),
    AgentRunDetailSchema,
  ),
  list_reviews: operation(
    [
      defaulted("p_cursor", "text", null),
      defaulted("p_status", "text", "pending"),
      defaulted("p_limit", "integer", 50),
    ],
    z.strictObject({
      p_cursor: optional(ReviewCursorSchema),
      // Omitted or null: the pending tab.
      p_status: optional(ReviewStatusSchema),
      p_limit: optional(PageLimitSchema),
    }),
    ReviewListSchema,
  ),
  get_review: operation(
    [required("p_review_id", "uuid")],
    z.strictObject({ p_review_id: UuidSchema }),
    ReviewDetailSchema,
  ),
  // Explicit open only, never from a list; the response is memory-only.
  get_review_advice: operation(
    [required("p_review_id", "uuid")],
    z.strictObject({ p_review_id: UuidSchema }),
    ReviewAdviceSchema,
  ),
  list_events: operation(
    [
      defaulted("p_cursor", "text", null),
      defaulted("p_subject_type", "text", null),
      defaulted("p_subject_id", "uuid", null),
      defaulted("p_limit", "integer", 50),
    ],
    z
      .strictObject({
        p_cursor: optional(EventCursorSchema),
        p_subject_type: optional(EventSubjectTypeSchema),
        p_subject_id: optional(UuidSchema),
        p_limit: optional(PageLimitSchema),
      })
      .refine(
        (input) =>
          (input.p_subject_type == null) === (input.p_subject_id == null),
        { message: "a subject type and a subject id go together" },
      ),
    EventListSchema,
  ),
  list_stops: operation(
    [
      defaulted("p_include_cleared", "boolean", false),
      defaulted("p_cursor", "text", null),
      defaulted("p_limit", "integer", 50),
    ],
    z.strictObject({
      p_include_cleared: optional(z.boolean()),
      p_cursor: optional(StopCursorSchema),
      p_limit: optional(PageLimitSchema),
    }),
    ExecutionStopListSchema,
  ),
  spend_summary: operation([], NoInputSchema, SpendSummarySchema),
  communication_status: operation(
    [],
    NoInputSchema,
    CommunicationStatusSummarySchema,
  ),
});

export type CompanyOsOperation = keyof typeof COMPANY_OS_OPERATIONS;

export const COMPANY_OS_OPERATION_NAMES: readonly CompanyOsOperation[] =
  Object.freeze(Object.keys(COMPANY_OS_OPERATIONS) as CompanyOsOperation[]);

export type OperationInput<O extends CompanyOsOperation> = z.input<
  (typeof COMPANY_OS_OPERATIONS)[O]["input"]
>;

export type OperationResult<O extends CompanyOsOperation> = z.output<
  (typeof COMPANY_OS_OPERATIONS)[O]["response"]
>;

/**
 * What an issue path shows in place of a key the contract does not declare. A
 * record's key (a reason code, a status) is response data, like the value
 * under it, so a contract error never repeats it.
 */
export const UNDECLARED_KEY_SEGMENT = "<key>";

/** The parts of a zod (v4) definition the path walk below reads. */
interface SchemaDefinition {
  readonly type: string;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly valueType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly in?: z.ZodType;
  readonly out?: z.ZodType;
}

const definitionOf = (schema: z.ZodType): SchemaDefinition =>
  schema.def as unknown as SchemaDefinition;

/** The schemas a value at a node meets: wrappers, unions and pipes opened. */
const schemasAt = (schema: z.ZodType): z.ZodType[] => {
  const { innerType, options, in: input, out } = definitionOf(schema);
  if (innerType) return schemasAt(innerType);
  if (options) return options.flatMap(schemasAt);
  if (input && out) return [input, out].flatMap(schemasAt);
  return [schema];
};

/**
 * An issue path as the contract declares it: array positions and the object
 * keys a schema names stay; any other segment (a record's key, or whatever the
 * walk cannot place) becomes UNDECLARED_KEY_SEGMENT.
 */
const declaredPath = (
  schema: z.ZodType,
  path: readonly PropertyKey[],
): (string | number)[] => {
  let nodes = schemasAt(schema);
  return path.map((segment) => {
    if (typeof segment === "number") {
      nodes = nodes.flatMap((node) => {
        const { element } = definitionOf(node);
        return element ? schemasAt(element) : [];
      });
      return segment;
    }
    const key = typeof segment === "string" ? segment : undefined;
    const named = nodes.flatMap((node) => {
      const { shape } = definitionOf(node);
      return key !== undefined && shape && Object.hasOwn(shape, key)
        ? schemasAt(shape[key])
        : [];
    });
    if (key !== undefined && named.length > 0) {
      nodes = named;
      return key;
    }
    nodes = nodes.flatMap((node) => {
      const { type, valueType } = definitionOf(node);
      return type === "record" && valueType ? schemasAt(valueType) : [];
    });
    return UNDECLARED_KEY_SEGMENT;
  });
};

/** Where `data` broke `schema`: declared paths and zod issue codes only. */
const issuesOf = (
  schema: z.ZodType,
  error: z.ZodError,
): readonly ContractIssue[] =>
  error.issues.map((issue) =>
    Object.freeze({
      path: Object.freeze(declaredPath(schema, issue.path)),
      code: issue.code,
    }),
  );

/**
 * The arguments a client may send, checked before a request leaves. A refusal
 * is a CompanyOsInputError: the request never left, so it says nothing about
 * the server's answer.
 */
export const parseOperationInput = <O extends CompanyOsOperation>(
  operation: O,
  input: unknown,
): OperationInput<O> => {
  const schema = COMPANY_OS_OPERATIONS[operation].input;
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new CompanyOsInputError(operation, issuesOf(schema, result.error));
  }
  return result.data as OperationInput<O>;
};

/**
 * The same request with every argument its function reads as its DEFAULT left
 * out: an omitted argument, a null one (every read treats null as its DEFAULT)
 * and one equal to its declared DEFAULT ask the server the same thing. Keys
 * are sorted, so two equivalent inputs print the same. What the recorded
 * responses of the browser tests are keyed by (engine/domain/
 * companyOsRecordedResponses.dbtest.ts, src/company-os/testing/recorded.ts).
 */
export const withoutDefaultArguments = (
  operation: CompanyOsOperation,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const defaults = new Map(
    COMPANY_OS_OPERATIONS[operation].args.map((arg) => [
      arg.name,
      arg.optional ? arg.defaultValue : undefined,
    ]),
  );
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .filter((key) => {
        const value = input[key];
        return (
          value !== undefined && value !== null && value !== defaults.get(key)
        );
      })
      .map((key) => [key, input[key]]),
  );
};

/** A response, parsed with its contract; anything unexpected throws. */
export const parseOperationResult = <O extends CompanyOsOperation>(
  operation: O,
  data: unknown,
): OperationResult<O> => {
  const schema = COMPANY_OS_OPERATIONS[operation].response;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new CompanyOsContractError(operation, issuesOf(schema, result.error));
  }
  return result.data as OperationResult<O>;
};

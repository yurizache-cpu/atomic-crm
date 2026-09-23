// Tasks (docs/PHASE_2C_BRIEF.md §9): never the title or the description (the
// description IS the inbound body), and the lifecycle status is structural,
// not progress; the derived pipeline is what shows progress.
//
// The single outbound record is reachable only here (TaskDetail.outbound), with
// no recipient, body, draft or requested_by label, and the inbound summary
// carries no contact reference, message id, fingerprint or conversation id.

import { z } from "zod";
import {
  CURSOR_KINDS,
  ChannelLabelSchema,
  DottedNameSchema,
  ENVELOPE_SHAPE,
  NamedRefSchema,
  ReasonCodeSchema,
  TimestampSchema,
  UuidSchema,
  cursorSchema,
  envelopedPageSchema,
} from "./primitives.ts";
import { EventPageSchema } from "./events.ts";
import { ReviewSummarySchema } from "./reviews.ts";
import { AgentRunSummarySchema } from "./runs.ts";
import {
  AgentRunStatusSchema,
  ContactResolutionSchema,
  InboundSourceKindSchema,
  OutboundStatusSchema,
  ReviewStatusSchema,
  TaskStatusSchema,
} from "./vocabulary.ts";

const TASK_SUMMARY_SHAPE = {
  id: UuidSchema,
  type: DottedNameSchema,
  lifecycleStatus: TaskStatusSchema,
  priority: z.int().min(0).max(1000),
  dueAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  company: NamedRefSchema,
  department: NamedRefSchema.nullable(),
  assignedAgent: NamedRefSchema.nullable(),
  pipeline: z.strictObject({
    latestRun: z
      .strictObject({ id: UuidSchema, status: AgentRunStatusSchema })
      .nullable(),
    review: z
      .strictObject({ id: UuidSchema, status: ReviewStatusSchema })
      .nullable(),
    outbound: z
      .strictObject({ id: UuidSchema, status: OutboundStatusSchema })
      .nullable(),
  }),
} as const;

export const TaskSummarySchema = z.strictObject(TASK_SUMMARY_SHAPE);

/** list_tasks. */
export const TaskListSchema = envelopedPageSchema(
  CURSOR_KINDS.tasks,
  TaskSummarySchema,
);

/** The task's single outbound record (brief §9 OutboundSummary). */
export const OutboundSummarySchema = z.strictObject({
  id: UuidSchema,
  status: OutboundStatusSchema,
  reviewItemId: UuidSchema.nullable(),
  taskId: UuidSchema,
  channelId: UuidSchema.nullable(),
  blockedReason: ReasonCodeSchema.nullable(),
  errorClass: ReasonCodeSchema.nullable(),
  errorCode: z
    .string()
    .regex(/^[0-9]{1,10}$/)
    .nullable(),
  authorizedAt: TimestampSchema,
  sendingAt: TimestampSchema.nullable(),
  settledAt: TimestampSchema.nullable(),
  deliveredAt: TimestampSchema.nullable(),
  readAt: TimestampSchema.nullable(),
});

/** How the task's message arrived; never who sent it or what it said. */
export const InboundSummarySchema = z.strictObject({
  sourceKind: InboundSourceKindSchema,
  channelLabel: ChannelLabelSchema.nullable(),
  receivedAt: TimestampSchema,
  contactResolution: ContactResolutionSchema.nullable(),
  doNotContact: z.boolean(),
});

/** get_task. */
export const TaskDetailSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  ...TASK_SUMMARY_SHAPE,
  runs: z.array(AgentRunSummarySchema).max(20),
  review: ReviewSummarySchema.nullable(),
  outbound: OutboundSummarySchema.nullable(),
  inbound: InboundSummarySchema.nullable(),
  events: EventPageSchema,
});

export const TaskCursorSchema = cursorSchema(CURSOR_KINDS.tasks);

export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskList = z.infer<typeof TaskListSchema>;
export type OutboundSummary = z.infer<typeof OutboundSummarySchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

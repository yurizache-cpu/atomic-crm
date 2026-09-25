// The closed vocabularies of the Company OS operator API (docs/PHASE_2C_BRIEF.md
// §9), as the SQL projections emit them.
//
// A contract may import only zod (brief §6.2), so the lists the engine already
// pins to SQL are DUPLICATED here, never imported, and two tests keep the copies
// honest: engine/domain/companyOsContracts.test.ts proves each list with an
// engine counterpart equals it, and
// engine/domain/companyOsContractVocabulary.dbtest.ts proves every list equals
// what the live database bounds or emits: a check constraint, the service that
// takes it (the review decisions), the lead_triage output contract
// (ops.agent_run_result_valid, for the advice vocabularies and bounds) or the
// projection helper that produces it. The one exception is TENANT_STOP_SCOPES,
// which the unit test derives from EXECUTION_STOP_SCOPES (every scope but
// global). Order matters for neither test's meaning, but the copies keep the
// engine's order so a diff reads as one.
//
// String-literal tuples and `as const`, never an enum: the engine imports these
// files under Node's type stripping, which cannot erase an enum.

import { z } from "zod";

/** ops.tasks.status (engine/domain/taskStateMachine.ts TASK_STATUSES). */
export const TASK_STATUSES = [
  "queued",
  "assigned",
  "in_progress",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;

/** ops.agent_runs.status (engine/domain/agentRunStateMachine.ts). */
export const AGENT_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "indeterminate",
  "cancelled",
] as const;

/** ops.review_items.status (engine/domain/reviewQueue.ts REVIEW_STATUSES). */
export const REVIEW_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "needs_edit",
] as const;

/** The three a person may record (engine/domain/reviewQueue.ts REVIEW_DECISIONS). */
export const REVIEW_DECISIONS = ["accepted", "rejected", "needs_edit"] as const;

/** ops.outbound_messages.status (engine/domain/outboundMessages.ts). */
export const OUTBOUND_STATUSES = [
  "authorized",
  "blocked",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
  "indeterminate",
] as const;

/** ops.execution_stops.scope (engine/domain/executionStops.ts). */
export const EXECUTION_STOP_SCOPES = [
  "global",
  "tenant",
  "company",
  "department",
  "agent",
  "job_kind",
] as const;

/**
 * The scopes of a stop NAMING the tenant, the only stops a projection returns: a
 * global stop has no tenant, so it never leaves (brief §9, OD-7).
 */
export const TENANT_STOP_SCOPES = [
  "tenant",
  "company",
  "department",
  "agent",
  "job_kind",
] as const;

/** ops.execution_stops.origin, derived from who tripped the stop. */
export const STOP_ORIGINS = ["owner", "system"] as const;

/**
 * ops.agent_runs.error_category: the model taxonomy
 * (engine/models/errors.ts MODEL_ERROR_CATEGORIES) plus the three the runtime
 * records itself (job_failed, interrupted, refused).
 */
export const AGENT_RUN_ERROR_CATEGORIES = [
  "configuration",
  "authentication",
  "rate_limit",
  "timeout",
  "transport",
  "provider_5xx",
  "invalid_request",
  "invalid_response",
  "schema_validation",
  "cancelled",
  "unknown",
  "job_failed",
  "interrupted",
  "refused",
] as const;

/** Why a run needs a person (the CLI's ATTENTION_WHERE, brief §10). */
export const RUN_ATTENTION_REASONS = [
  "indeterminate_not_retried",
  "running_without_live_lease",
] as const;

/** ops.jobs.status. */
export const JOB_STATUSES = [
  "queued",
  "leased",
  "succeeded",
  "failed",
] as const;

/** ops.jobs.last_error_class (engine/worker/failures.ts FAILURE_CLASSES). */
export const JOB_FAILURE_CLASSES = [
  "transient",
  "permanent",
  "security",
  "unknown",
] as const;

/** The id-free steps projected from a run's own ops.job_events (brief §11). */
export const JOB_STEPS = [
  "job_leased",
  "job_deferred",
  "job_retry",
  "job_reaped",
] as const;

/** Agent availability (brief §10): inactive, then stopped, then available. */
export const AGENT_AVAILABILITIES = [
  "inactive",
  "stopped",
  "available",
] as const;

/** Agent activity (brief §10), in the order the projection decides it. */
export const AGENT_ACTIVITIES = [
  "working",
  "stale",
  "held",
  "queued",
  "idle",
] as const;

/** The organisational unit that makes an agent inactive. */
export const ORG_UNITS = ["agent", "department", "company"] as const;

/** ops.inbound_messages.source_kind. */
export const INBOUND_SOURCE_KINDS = ["synthetic", "whatsapp"] as const;

/** ops.inbound_messages.contact_resolution (the read-only CRM ContactPolicy). */
export const CONTACT_RESOLUTIONS = [
  "found",
  "not_found",
  "ambiguous",
  "unavailable",
] as const;

/** ops.communication_channels.mode (engine/domain/communicationChannels.ts). */
export const CHANNEL_MODES = ["test", "production"] as const;

/**
 * A tenant's own spend rows: its budget and any company budgets
 * (engine/domain/spendLimits.ts SPEND_LIMIT_SCOPES without the global one).
 */
export const TENANT_LIMIT_SCOPES = ["tenant", "company"] as const;

/** ops.spend_status().new_run_admission (engine/domain/spendLimits.ts NEW_RUN_ADMISSIONS). */
export const SPEND_ADMISSIONS = ["blocked", "conditional"] as const;

/** Overview admission: a tenant with no budget row is `unconfigured`. */
export const TENANT_ADMISSIONS = [
  "blocked",
  "conditional",
  "unconfigured",
] as const;

/** ops.events.subject_type. */
export const EVENT_SUBJECT_TYPES = [
  "company",
  "department",
  "agent",
  "task",
  "agent_run",
] as const;

/**
 * The pinned provenance labels an event's source may carry to the browser
 * (ops.cos_event_source). events.source is caller-supplied, so anything else
 * leaves as OTHER_EVENT_SOURCE.
 */
export const EVENT_SOURCES = [
  "agent-runtime",
  "agent-runtime-smoke",
  "company-os-ui",
  "lead-triage-demo",
  "operator-cli",
  "scheduling-demo",
  "seed",
  "whatsapp-gateway",
] as const;

export const OTHER_EVENT_SOURCE = "other";

/** The lead_triage advice vocabulary (engine/models/leadTriage.ts). */
export const LEAD_TRIAGE_OUTCOMES = [
  "triaged",
  "needs_input",
  "out_of_scope",
] as const;

export const LEAD_TRIAGE_INTENTS = [
  "book_appointment",
  "pricing",
  "information",
  "support",
  "other",
] as const;

export const LEAD_TRIAGE_PRIORITIES = ["low", "normal", "high"] as const;

export const LEAD_TRIAGE_FLAGS = [
  "possible_crisis",
  "minor",
  "out_of_scope",
  "already_a_patient",
  "spam",
  "unclear",
] as const;

export const TRIAGE_SUMMARY_MAX_LENGTH = 1000;
export const NEXT_ACTION_MAX_LENGTH = 300;
export const MAX_TRIAGE_FLAGS = 5;

/** Why the advice of a review is not shown (brief §13 item 3). */
export const ADVICE_WITHHELD_REASONS = [
  "capability_not_pinned",
  "origin_not_synthetic_or_test",
  "contract_invalid",
] as const;

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export const OutboundStatusSchema = z.enum(OUTBOUND_STATUSES);
export const TenantStopScopeSchema = z.enum(TENANT_STOP_SCOPES);
export const StopOriginSchema = z.enum(STOP_ORIGINS);
export const AgentRunErrorCategorySchema = z.enum(AGENT_RUN_ERROR_CATEGORIES);
export const RunAttentionSchema = z.enum(RUN_ATTENTION_REASONS);
export const JobStatusSchema = z.enum(JOB_STATUSES);
export const JobFailureClassSchema = z.enum(JOB_FAILURE_CLASSES);
export const JobStepSchema = z.enum(JOB_STEPS);
export const AgentAvailabilitySchema = z.enum(AGENT_AVAILABILITIES);
export const AgentActivitySchema = z.enum(AGENT_ACTIVITIES);
export const OrgUnitSchema = z.enum(ORG_UNITS);
export const InboundSourceKindSchema = z.enum(INBOUND_SOURCE_KINDS);
export const ContactResolutionSchema = z.enum(CONTACT_RESOLUTIONS);
export const ChannelModeSchema = z.enum(CHANNEL_MODES);
export const TenantLimitScopeSchema = z.enum(TENANT_LIMIT_SCOPES);
export const SpendAdmissionSchema = z.enum(SPEND_ADMISSIONS);
export const TenantAdmissionSchema = z.enum(TENANT_ADMISSIONS);
export const EventSubjectTypeSchema = z.enum(EVENT_SUBJECT_TYPES);
export const EventSourceSchema = z.enum([...EVENT_SOURCES, OTHER_EVENT_SOURCE]);
export const AdviceWithheldReasonSchema = z.enum(ADVICE_WITHHELD_REASONS);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export type OutboundStatus = z.infer<typeof OutboundStatusSchema>;
export type TenantStopScope = z.infer<typeof TenantStopScopeSchema>;
export type EventSubjectType = z.infer<typeof EventSubjectTypeSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;

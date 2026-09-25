// Valid, synthetic responses for every company_os_api operation, shaped as the
// SQL projections build them (supabase/migrations/20260922120000_company_os_read_surface.sql),
// for the contract unit tests. Every optional object is present at least once,
// so a test that walks a sample reaches every nested object a schema declares.
//
// The driver-backed suite (companyOsContracts.dbtest.ts) is what proves the
// real projections match the contracts; these samples only exercise the
// contracts themselves. All data is synthetic office-operations text.

import type { CompanyOsOperation } from "../../../contracts/company-os-api/index.ts";

/** A deterministic synthetic uuid (version 4 layout, lower case). */
export const sampleId = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const AT = "2026-09-22T10:00:00.000000Z";
const LATER = "2026-09-22T10:05:30.123456Z";

const money = (micros: string, usd: string) => ({ micros, usd });

const ENVELOPE = { v: 1, asOf: AT } as const;

const COMPANY = { id: sampleId(10), name: "Clinic A" };
const DEPARTMENT = { id: sampleId(11), name: "Intake" };
const AGENT = { id: sampleId(12), name: "Lead Triage" };
const TENANT_STOP = { id: sampleId(40), scope: "agent", origin: "owner" };

export const RUN = {
  id: sampleId(20),
  companyId: COMPANY.id,
  taskId: sampleId(30),
  agentId: AGENT.id,
  retryOfRunId: sampleId(21),
  capability: "lead_triage",
  modelRoute: "standard",
  status: "succeeded",
  errorCategory: null,
  errorCode: null,
  provider: "fake",
  model: "fake-model-1",
  responseModel: "fake-model-1",
  inputTokens: 120,
  outputTokens: 60,
  totalTokens: 180,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  latencyMs: 42,
  jobAttempt: 1,
  reservedCost: money("30545", "0.030545"),
  estimatedCost: money("300", "0.000300"),
  chargedCost: money("300", "0.000300"),
  createdAt: AT,
  startedAt: AT,
  completedAt: LATER,
  attention: null,
  stopRef: { id: TENANT_STOP.id },
  spendLimitRef: { id: sampleId(50), scope: "company" },
};

const AGENT_SUMMARY = {
  id: AGENT.id,
  slug: "lead-triage",
  name: AGENT.name,
  company: COMPANY,
  department: DEPARTMENT,
  availability: "stopped",
  activity: "working",
  attentionCount: 1,
  lastRunAt: AT,
  evidence: {
    workingRunIds: [sampleId(20)],
    heldRunIds: [],
    queuedRunIds: [],
    staleRunIds: [sampleId(22)],
    attentionRunIds: [sampleId(22)],
    stop: TENANT_STOP,
    inactiveUnit: null,
  },
};

export const EVENT = {
  id: sampleId(60),
  type: "communication.outbound_authorized",
  source: "operator-cli",
  subjectType: "task",
  subjectId: sampleId(30),
  causationId: sampleId(61),
  createdAt: AT,
  facts: { outbound_message_id: sampleId(70), review_item_id: sampleId(80) },
  factsWithheld: false,
};

const TASK_SUMMARY = {
  id: sampleId(30),
  type: "lead_triage",
  lifecycleStatus: "assigned",
  priority: 100,
  dueAt: LATER,
  createdAt: AT,
  company: COMPANY,
  department: DEPARTMENT,
  assignedAgent: AGENT,
  pipeline: {
    latestRun: { id: RUN.id, status: "succeeded" },
    review: { id: sampleId(80), status: "accepted" },
    outbound: { id: sampleId(70), status: "failed" },
  },
};

export const REVIEW_SUMMARY = {
  id: sampleId(80),
  taskId: sampleId(30),
  agentRunId: RUN.id,
  capability: "lead_triage",
  status: "accepted",
  doNotContact: false,
  reviewedAt: LATER,
  createdAt: AT,
  hasNote: true,
  outboundStatus: "failed",
};

const STOP = {
  id: TENANT_STOP.id,
  scope: "agent",
  jobKind: null,
  origin: "owner",
  target: {
    companyId: COMPANY.id,
    departmentId: null,
    agentId: AGENT.id,
    name: AGENT.name,
  },
  trippedAt: AT,
  reason: "Synthetic pause",
  clearedAt: LATER,
  clearedReason: "Drill over",
};

const SPEND_ROW = {
  scope: "company",
  companyId: COMPANY.id,
  timezone: "UTC",
  dailyLimit: money("1000000", "1.000000"),
  charged: money("1000300", "1.000300"),
  settled: money("300", "0.000300"),
  estimated: money("300", "0.000300"),
  remaining: money("-300", "-0.000300"),
  runningRuns: 1,
  unknownCostRuns: 0,
  refusedRuns: 2,
  settledExhausted: false,
  newRunAdmission: "blocked",
};

/** One or more valid responses per operation. */
export const CONTRACT_SAMPLES: {
  readonly [O in CompanyOsOperation]: readonly Record<string, unknown>[];
} = {
  operator_context: [
    {
      ...ENVELOPE,
      principal: { id: sampleId(1) },
      tenant: { id: sampleId(2), name: "Synthetic Tenant" },
      role: "tenant_operator",
      dataPolicy: "synthetic_or_test_only",
      allowedActions: {
        decideReview: true,
        tripStop: true,
        viewAdvice: true,
      },
      serverTime: LATER,
    },
  ],
  overview: [
    {
      ...ENVELOPE,
      agents: {
        total: 4,
        working: 1,
        held: 1,
        queued: 0,
        stale: 0,
        stopped: 2,
        inactive: 1,
      },
      runs: {
        todayByStatus: { pending: 1, running: 2 },
        workingNow: 1,
        needingAttention: 1,
      },
      reviews: { pending: 1, oldestPendingAt: AT },
      stops: { tenantScopedActive: 2 },
      admission: { tenantAdmission: "unconfigured" },
      outbound: {
        todayByStatus: { failed: 1 },
        indeterminateOpen: 0,
        acceptedWithoutSend: 1,
      },
      platform: { globalAdmissionBlocked: true },
      decisionIntelligence: {
        mode: "shadow",
        currentPolicyVersion: "decision_shadow.v2",
        groups: [
          {
            policyVersion: "decision_shadow.v2",
            provider: { kind: "fake", id: "fake-rules", version: "2" },
            evaluations: 7,
            recommendations: 4,
            abstained: 1,
            pending: 0,
            indeterminate: 1,
            invalid: 1,
            failed: 0,
            refused: 0,
            withHumanDecision: 4,
            comparable: 3,
            agreements: 2,
            disagreements: 1,
            byRecommendation: {
              accept: 2,
              needs_edit: 1,
              reject: 1,
              abstain: 1,
            },
            byHumanOutcome: {
              pending: 3,
              accepted: 2,
              rejected: 1,
              needs_edit: 1,
            },
          },
        ],
      },
      operationalHealth: {
        windowHours: 24,
        queue: {
          ready: 2,
          scheduled: 1,
          running: 1,
          expiredLeases: 1,
          succeededInWindow: 6,
          failedInWindow: 1,
          oldestReadyAt: AT,
        },
        queueByKind: [
          {
            kind: "agent_run.execute",
            ready: 2,
            scheduled: 1,
            running: 1,
            expiredLeases: 1,
            succeededInWindow: 4,
            failedInWindow: 1,
          },
          {
            kind: "decision.shadow_evaluate",
            ready: 0,
            scheduled: 0,
            running: 0,
            expiredLeases: 0,
            succeededInWindow: 2,
            failedInWindow: 0,
          },
        ],
        agentRuns: {
          inWindowByStatus: { succeeded: 6, indeterminate: 1 },
          latency: {
            sampleSize: 6,
            p50Ms: 820,
            p95Ms: null,
            minSamplesP50: 5,
            minSamplesP95: 20,
          },
        },
        decisions: {
          inWindow: {
            completed: 2,
            abstained: 1,
            invalid: 0,
            failed: 0,
            indeterminate: 1,
            refused: 0,
          },
          pendingNow: 0,
        },
        outbound: { inWindowByStatus: { sent: 1, indeterminate: 1 } },
        spend: {
          chargedToday: { micros: "1200", usd: "0.001200" },
          chargedInWindow: { micros: "1500", usd: "0.001500" },
          chargedLast7Days: { micros: "4200", usd: "0.004200" },
          reservedInFlight: { micros: "300", usd: "0.000300" },
        },
      },
      // Phase 3A: a tenant with no scheduling rows reads an empty, local-only
      // agenda (the populated one is src/company-os/testing/recorded/agenda.json).
      agenda: {
        timezone: "UTC",
        timezoneConfigured: false,
        today: "2026-09-22",
        bookings: {
          todayBooked: 0,
          next7DaysBooked: 0,
          cancelledInWindow: 0,
          rescheduledInWindow: 0,
          conflicts: 0,
          today: [],
          upcoming: [],
          changes: [],
        },
        followUps: {
          due: 0,
          overdue: 0,
          dueToday: 0,
          awaitingProcessing: 0,
          scheduledNext7Days: 0,
          closedRecently: 0,
          needingAction: [],
          scheduled: [],
          recentlyClosed: [],
        },
        availability: [],
        calendar: {
          state: "local_only",
          upcomingSyncs: {
            pending: 0,
            running: 0,
            synced: 0,
            failed: 0,
            indeterminate: 0,
            skipped: 0,
          },
        },
      },
    },
  ],
  list_agents: [{ ...ENVELOPE, items: [AGENT_SUMMARY] }],
  get_agent: [{ ...ENVELOPE, agent: AGENT_SUMMARY, recentRuns: [RUN] }],
  list_tasks: [
    {
      ...ENVELOPE,
      items: [TASK_SUMMARY],
      nextCursor: `tk1:${TASK_SUMMARY.id}`,
    },
  ],
  get_task: [
    {
      ...ENVELOPE,
      ...TASK_SUMMARY,
      runs: [RUN],
      review: REVIEW_SUMMARY,
      outbound: {
        id: sampleId(70),
        status: "failed",
        reviewItemId: REVIEW_SUMMARY.id,
        taskId: TASK_SUMMARY.id,
        channelId: sampleId(90),
        blockedReason: null,
        errorClass: "provider_error",
        errorCode: "131047",
        authorizedAt: AT,
        sendingAt: AT,
        settledAt: LATER,
        deliveredAt: null,
        readAt: null,
      },
      inbound: {
        sourceKind: "whatsapp",
        channelLabel: "Synthetic test line",
        receivedAt: AT,
        contactResolution: "not_found",
        doNotContact: true,
      },
      events: { items: [EVENT], nextCursor: `ev1:${EVENT.id}` },
    },
  ],
  list_runs: [{ ...ENVELOPE, items: [RUN], nextCursor: null }],
  get_run: [
    {
      ...ENVELOPE,
      ...RUN,
      retriedByRunIds: [sampleId(23)],
      job: {
        status: "leased",
        attempts: 1,
        availableAt: AT,
        leaseLive: true,
        lastErrorClass: "transient",
      },
      jobSteps: [{ step: "job_leased", attempt: 1, at: AT }],
      coveringStop: TENANT_STOP,
    },
  ],
  list_reviews: [{ ...ENVELOPE, items: [REVIEW_SUMMARY], nextCursor: null }],
  get_review: [
    {
      ...ENVELOPE,
      ...REVIEW_SUMMARY,
      decisionNote: "Call back tomorrow",
      allowedDecisions: [],
      shadowDecision: {
        status: "completed",
        mode: "shadow",
        policyVersion: "decision_shadow.v2",
        recommendation: "accept",
        confidence: 0.82,
        caution: "low",
        reasonCodes: ["triage_complete", "intent_information"],
        policy: {
          outcome: "recommendation_available",
          humanReviewRequired: true,
        },
        provider: { kind: "fake", id: "fake-rules", version: "2" },
        refusal: null,
        requestedAt: AT,
        settledAt: AT,
      },
    },
    {
      ...ENVELOPE,
      ...REVIEW_SUMMARY,
      status: "pending",
      reviewedAt: null,
      hasNote: false,
      outboundStatus: null,
      doNotContact: true,
      decisionNote: null,
      allowedDecisions: ["rejected", "needs_edit"],
      shadowDecision: { status: "unavailable" },
    },
  ],
  get_review_advice: [
    {
      ...ENVELOPE,
      reviewId: REVIEW_SUMMARY.id,
      capability: "lead_triage",
      outcome: "triaged",
      intent: "book_appointment",
      priority: "normal",
      needsHumanReview: false,
      flags: ["unclear"],
      summary: "A synthetic person asks about a first appointment.",
      recommendedNextAction: "Offer two synthetic slots.",
    },
    {
      ...ENVELOPE,
      reviewId: REVIEW_SUMMARY.id,
      withheld: "origin_not_synthetic_or_test",
    },
  ],
  list_events: [
    {
      ...ENVELOPE,
      items: [
        EVENT,
        {
          ...EVENT,
          id: sampleId(62),
          type: "custom.thing_happened",
          source: "other",
          causationId: null,
          facts: {},
          factsWithheld: true,
        },
      ],
      nextCursor: null,
    },
  ],
  list_stops: [{ ...ENVELOPE, items: [STOP], nextCursor: `st1:${STOP.id}` }],
  spend_summary: [
    {
      ...ENVELOPE,
      windowStart: "2026-09-22T00:00:00.000000Z",
      tenantRows: [
        {
          ...SPEND_ROW,
          scope: "tenant",
          companyId: null,
          newRunAdmission: "conditional",
        },
        SPEND_ROW,
      ],
      today: {
        byAgent: [
          { agent: AGENT, runs: 3, charged: money("61383", "0.061383") },
        ],
        byModel: [
          {
            provider: "fake",
            model: "fake-model-1",
            runs: 3,
            charged: money("0", "0.000000"),
          },
        ],
      },
      platform: { globalAdmissionBlocked: false },
    },
  ],
  communication_status: [
    {
      ...ENVELOPE,
      channels: [
        {
          id: sampleId(90),
          label: "Synthetic test line",
          mode: "test",
          active: true,
          agent: AGENT,
          updatedAt: AT,
        },
      ],
      inbound: { admittedToday: 6, refusedTodayByReason: { empty_body: 1 } },
      conversationsActive24h: 1,
      outbound: {
        byStatus: { failed: 1 },
        blockedByReason: { contact_not_found: 1 },
        indeterminateOpen: 0,
        acceptedWithoutSend: 0,
      },
      note: "Unrouted deliveries are never stored.",
    },
  ],
};

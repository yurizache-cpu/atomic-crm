// THE registry. One file, one list, reviewed as a whole.
//
// Adding a handler here is the moment a new capability enters the runtime, so
// it is deliberately a code change in a file whose entire content is the list —
// not a plugin directory, not a config value, not a database row.
//
// The list is a function of its dependencies because the agent run handler
// needs a model router, and the router is built from the process environment by
// main.ts. A handler's KIND never depends on them.

import {
  AGENT_RUN_EXECUTE_KIND,
  createAgentRunExecuteHandler,
} from "../handlers/agentRunExecute.ts";
import {
  DECISION_SHADOW_EVALUATE_KIND,
  createDecisionShadowEvaluateHandler,
} from "../handlers/decisionShadowEvaluate.ts";
import {
  CALENDAR_CANCEL_KIND,
  CALENDAR_CREATE_KIND,
  CALENDAR_UPDATE_KIND,
  createCalendarSyncHandlers,
} from "../handlers/calendarSync.ts";
import { FOLLOW_UP_DUE_KIND, followUpDue } from "../handlers/followUpDue.ts";
import {
  CONTENT_RETENTION_DUE_KIND,
  contentRetentionDue,
} from "../handlers/contentRetentionDue.ts";
import {
  CONTACT_IDENTIFIER_RETENTION_DUE_KIND,
  contactIdentifierRetentionDue,
} from "../handlers/contactIdentifierRetentionDue.ts";
import {
  UNCONFIGURED_CALENDAR_PORT,
  type CalendarPort,
} from "../calendar/calendarPort.ts";
import {
  POSTMARK_LEDGER_RETENTION_KIND,
  postmarkLedgerRetention,
} from "../handlers/postmarkLedgerRetention.ts";
import {
  UNCONFIGURED_DECISION_PORT,
  type DecisionPort,
} from "../decision/decisionPort.ts";
import type { ModelRouter } from "../models/router.ts";
import {
  createStructuredDecisionEvaluateHandler,
  STRUCTURED_DECISION_EVALUATE_KIND,
} from "../handlers/structuredDecisionEvaluate.ts";
import { UNCONFIGURED_DECISION_GATEWAY } from "../decision/structured/gatewayFromEnv.ts";
import {
  UNCONFIGURED_REPLY_TRANSPORT,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import {
  createOutboundReplySendHandler,
  OUTBOUND_REPLY_SEND_KIND,
} from "../handlers/outboundReplySend.ts";
import type { StructuredDecisionGateway } from "../decision/structured/types.ts";
import { createRegistry, type HandlerRegistry } from "./handlerRegistry.ts";
import { assertRegistryClassified } from "./jobKinds.ts";

export interface HandlerRegistryDependencies {
  readonly modelRouter: ModelRouter;
  /**
   * Phase 2D.1: the shadow decision provider, and whether a settled triage
   * requests a shadow decision. Absent: no provider, and no request.
   */
  readonly decisionPort?: DecisionPort;
  readonly requestsShadowDecisions?: boolean;
  /**
   * Phase 3A.2: the calendar a connected company's bookings are mirrored to.
   * Absent: none, and a calendar job settles failed without calling anything.
   */
  readonly calendarPort?: CalendarPort;
  /**
   * ADR 0022: the structured decision gateway (Jev), and whether a settled run
   * requests its structured decisions. Absent: none, and no request.
   */
  readonly structuredDecisionGateway?: StructuredDecisionGateway;
  readonly requestsStructuredDecisions?: boolean;
  /**
   * ADR 0026 §B: the transport policy sends are carried with. Absent: none, and
   * a reply job waits in the queue until its text is out of date, then the
   * database blocks it for a person.
   */
  readonly replyTransport?: ReplyTransport;
}

export function createHandlerRegistry(
  dependencies: HandlerRegistryDependencies,
): HandlerRegistry {
  const registry = createRegistry([
    postmarkLedgerRetention,
    createAgentRunExecuteHandler({
      modelRouter: dependencies.modelRouter,
      requestsShadowDecisions: dependencies.requestsShadowDecisions === true,
      requestsStructuredDecisions:
        dependencies.requestsStructuredDecisions === true,
    }),
    createDecisionShadowEvaluateHandler({
      decisionPort: dependencies.decisionPort ?? UNCONFIGURED_DECISION_PORT,
    }),
    followUpDue,
    contentRetentionDue,
    contactIdentifierRetentionDue,
    ...createCalendarSyncHandlers({
      calendarPort: dependencies.calendarPort ?? UNCONFIGURED_CALENDAR_PORT,
    }),
    createStructuredDecisionEvaluateHandler({
      gateway:
        dependencies.structuredDecisionGateway ?? UNCONFIGURED_DECISION_GATEWAY,
    }),
    createOutboundReplySendHandler({
      replyTransport:
        dependencies.replyTransport ?? UNCONFIGURED_REPLY_TRANSPORT,
    }),
  ]);
  // Every kind here is external, governed or internal, with the matching shape
  // (ADR 0017 §6, Phase 3A.1): the kill switch holds the external and the
  // governed ones, and never the internal ones.
  assertRegistryClassified(registry);
  return registry;
}

/**
 * Every kind the list above registers, for the test that compares it with the
 * database's allowlist of kinds a task may request. Written out rather than
 * derived so that reading it needs no router;
 * engine/handlers/agentRunExecute.test.ts pins it to the registry's own keys.
 */
export const REGISTERED_HANDLER_KINDS: readonly string[] = Object.freeze([
  POSTMARK_LEDGER_RETENTION_KIND,
  AGENT_RUN_EXECUTE_KIND,
  DECISION_SHADOW_EVALUATE_KIND,
  FOLLOW_UP_DUE_KIND,
  CONTENT_RETENTION_DUE_KIND,
  CONTACT_IDENTIFIER_RETENTION_DUE_KIND,
  CALENDAR_CREATE_KIND,
  CALENDAR_UPDATE_KIND,
  CALENDAR_CANCEL_KIND,
  STRUCTURED_DECISION_EVALUATE_KIND,
  OUTBOUND_REPLY_SEND_KIND,
]);

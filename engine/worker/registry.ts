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
  POSTMARK_LEDGER_RETENTION_KIND,
  postmarkLedgerRetention,
} from "../handlers/postmarkLedgerRetention.ts";
import type { ModelRouter } from "../models/router.ts";
import { createRegistry, type HandlerRegistry } from "./handlerRegistry.ts";

export interface HandlerRegistryDependencies {
  readonly modelRouter: ModelRouter;
}

export function createHandlerRegistry(
  dependencies: HandlerRegistryDependencies,
): HandlerRegistry {
  return createRegistry([
    postmarkLedgerRetention,
    createAgentRunExecuteHandler({ modelRouter: dependencies.modelRouter }),
  ]);
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
]);

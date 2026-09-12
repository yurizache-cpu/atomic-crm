// THE registry. One file, one list, reviewed as a whole.
//
// Adding a handler here is the moment a new capability enters the runtime, so
// it is deliberately a code change in a file whose entire content is the list —
// not a plugin directory, not a config value, not a database row.

import { postmarkLedgerRetention } from "../handlers/postmarkLedgerRetention.ts";
import { createRegistry, type HandlerRegistry } from "./handlerRegistry.ts";

export const handlerRegistry: HandlerRegistry = createRegistry([
  postmarkLedgerRetention,
]);

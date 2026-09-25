import { UUID_PATTERN } from "../../../contracts/company-os-api/index.ts";

// Where a record opens inside the Company OS. Every path is a constant below
// /company-os; the only data in a link is a uuid the contract already checked
// and this module checks again, so no link a projection yields can leave the
// module's own router (docs/PHASE_2C_BRIEF.md §6.2: no data-built href).

export const COMPANY_OS_ROOT = "/company-os";

export const RECORD_PATHS = {
  task: `${COMPANY_OS_ROOT}/tasks`,
  run: `${COMPANY_OS_ROOT}/runs`,
  review: `${COMPANY_OS_ROOT}/reviews`,
  agent: `${COMPANY_OS_ROOT}/agents`,
  taskChain: `${COMPANY_OS_ROOT}/activity/task`,
  runChain: `${COMPANY_OS_ROOT}/activity/run`,
} as const;

export type RecordKind = keyof typeof RECORD_PATHS;

/** The router path of a record, or null when `id` is not a uuid. */
export const recordPath = (kind: RecordKind, id: string): string | null =>
  UUID_PATTERN.test(id) ? `${RECORD_PATHS[kind]}/${id}` : null;

/** The screens a count links to, with their fixed filters. */
export const LIST_PATHS = {
  overview: COMPANY_OS_ROOT,
  agents: `${COMPANY_OS_ROOT}/agents`,
  runs: `${COMPANY_OS_ROOT}/runs`,
  tasks: `${COMPANY_OS_ROOT}/tasks`,
  reviews: `${COMPANY_OS_ROOT}/reviews`,
  stops: `${COMPANY_OS_ROOT}/stops`,
  costs: `${COMPANY_OS_ROOT}/costs`,
  activity: `${COMPANY_OS_ROOT}/activity`,
  health: `${COMPANY_OS_ROOT}/health`,
  agenda: `${COMPANY_OS_ROOT}/agenda`,
  communications: `${COMPANY_OS_ROOT}/communications`,
} as const;

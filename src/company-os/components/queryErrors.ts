import {
  CompanyOsApiError,
  CompanyOsContractError,
  CompanyOsInputError,
} from "../../../contracts/company-os-api/index.ts";
import { CompanyOsGenerationError } from "../session/generation";

// What a screen says when a read fails. The text is this module's own: never
// the server's message, never a value from the response (a response that broke
// its contract is not shown at all, docs/PHASE_2C_BRIEF.md §6.2).
//
// Three failures are told apart, because they mean different things: a
// RESPONSE that broke its contract (the server answered something unexpected),
// a REQUEST the browser refused to send (an argument outside its input
// contract, so the server was never asked), and a refusal the server gave.

export const CONTRACT_ERROR_TEXT =
  "The response did not match its contract, so it is not shown.";

export const INPUT_ERROR_TEXT =
  "The request was not sent: an argument did not match its contract.";

/** What a missing record reads as, whether the server or the route says so. */
export const NOT_FOUND_TEXT = "Not found.";

export const ACCESS_RECHECK_TEXT = "Access is being checked again.";

const API_ERROR_TEXT: Readonly<Record<CompanyOsApiError["code"], string>> = {
  OS400: "The request was refused. Restart from the first page.",
  OS401: "The session ended. Checking access again.",
  OS403: ACCESS_RECHECK_TEXT,
  OS404: NOT_FOUND_TEXT,
  OS409: ACCESS_RECHECK_TEXT,
  OS429: "The request could not be completed yet. Retry.",
  OS500: "The server could not answer this read.",
};

export const errorTextOf = (error: unknown): string => {
  if (error instanceof CompanyOsContractError) return CONTRACT_ERROR_TEXT;
  if (error instanceof CompanyOsInputError) return INPUT_ERROR_TEXT;
  if (error instanceof CompanyOsGenerationError) return ACCESS_RECHECK_TEXT;
  if (error instanceof CompanyOsApiError) return API_ERROR_TEXT[error.code];
  return API_ERROR_TEXT.OS500;
};

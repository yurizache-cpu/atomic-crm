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
  "A resposta não veio no formato esperado, por isso não é mostrada.";

export const INPUT_ERROR_TEXT =
  "O pedido não foi enviado: um dado não estava no formato esperado.";

/** What a missing record reads as, whether the server or the route says so. */
export const NOT_FOUND_TEXT = "Não encontrado.";

export const ACCESS_RECHECK_TEXT = "Seu acesso está sendo verificado de novo.";

const API_ERROR_TEXT: Readonly<Record<CompanyOsApiError["code"], string>> = {
  OS400: "O pedido foi recusado. Volte para a primeira página.",
  OS401: "A sessão terminou. Verificando o acesso de novo.",
  OS403: ACCESS_RECHECK_TEXT,
  OS404: NOT_FOUND_TEXT,
  OS409: ACCESS_RECHECK_TEXT,
  OS429: "O pedido ainda não pôde ser concluído. Tente de novo.",
  OS500: "Não foi possível carregar esta área.",
};

export const errorTextOf = (error: unknown): string => {
  if (error instanceof CompanyOsContractError) return CONTRACT_ERROR_TEXT;
  if (error instanceof CompanyOsInputError) return INPUT_ERROR_TEXT;
  if (error instanceof CompanyOsGenerationError) return ACCESS_RECHECK_TEXT;
  if (error instanceof CompanyOsApiError) return API_ERROR_TEXT[error.code];
  return API_ERROR_TEXT.OS500;
};

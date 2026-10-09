import type {
  ConversationHolder,
  FIXED_MESSAGE_KEYS,
  ReplyDeliveryState,
  ReplyUnavailableReason,
  ReviewAuthor,
} from "../../../../contracts/company-os-api/index.ts";
import { clockTime } from "../../format/ptBR";

type FixedMessageKey = (typeof FIXED_MESSAGE_KEYS)[number];

// The fixed sentences of the browser inbox (ADR 0026 §E, SI-87), in Brazilian
// Portuguese for the owner, kept apart from copy.ts (past its size ceiling).
// One place, so a test can pin them and a review sees every change.
//
// A person's reply is the one send the browser may cause, and only as the
// member's own text: no sentence here offers a draft, presents a decision as
// a send, or names a control that would end a pause or undo a send.

export const INBOX_TITLE = "Fila de atendimento";

export const INBOX_DESCRIPTION =
  "Conversas que aguardam uma pessoa, das mais antigas para as mais novas. Abra uma para ler e responder.";

export const INBOX_NOT_AVAILABLE =
  "A fila de atendimento ainda não está disponível neste banco de dados.";

export const CONVERSATION_TITLE = "Conversa";

export const BACK_TO_INBOX = "← Voltar à fila de atendimento";

export const TASK_LINK = "Ver a tarefa";

export const CONVERSATION_NOTE =
  "O texto aparece só enquanto esta página está aberta e não é guardado no navegador.";

export const NO_FIRST_NAME = "Contato sem nome no CRM";

export const HOLDER_LABEL: Readonly<Record<ConversationHolder, string>> = {
  person: "Com uma pessoa da equipe",
  agent: "Com a IA",
};

export const WINDOW_CLOSED_TEXT =
  "Janela de 24 h encerrada: respostas não podem sair";

/** The contact's 24-hour window, as the answer's own clock reads it. */
export const windowText = (
  windowEndsAt: string | null,
  asOf: string,
): string =>
  windowEndsAt === null || windowEndsAt <= asOf
    ? WINDOW_CLOSED_TEXT
    : `Janela de 24 h até ${clockTime(windowEndsAt)}`;

export const OPT_OUT_OPEN_NOTE =
  "O contato pediu para parar de receber mensagens.";

/** Why the conversation is not shown (neutral: the list may still name it). */
export const CONVERSATION_WITHHELD = {
  not_test:
    "Esta conversa não é de teste: o texto não é exibido e ela não pode ser respondida aqui.",
  erased:
    "O número deste contato foi apagado: o texto não é exibido e a conversa não pode ser respondida aqui.",
} as const;

export const CONVERSATION_NOT_WAITING =
  "Esta conversa não está mais na fila de atendimento.";

export const TURNS_TITLE = "Mensagens";

export const NO_TURNS = "Nenhuma mensagem para mostrar.";

export const EARLIER_TURNS_NOTE = "Mostrando as 50 mensagens mais recentes.";

export const INBOUND_LABEL = "Contato";

export const PRIVACY_NOTICE_NOTE = "Com o aviso de privacidade.";

const AUTHOR_LABEL: Readonly<Record<ReviewAuthor, string>> = {
  agent: "IA",
  fixed: "Texto fixo",
  person: "Pessoa da equipe",
};

export const FIXED_KEY_LABEL: Readonly<Record<FixedMessageKey, string>> = {
  safety: "aviso de segurança (CVV)",
  safety_followup: "aviso de segurança (CVV)",
  human_handoff_ack: "pedido de atendimento",
  sensitive_only_prospect: "assunto sensível",
  sensitive_only_client: "assunto sensível",
  clarification: "pedido de esclarecimento",
  out_of_scope: "fora do escopo",
  service_unavailable: "serviço indisponível",
  opt_out_ack: "pedido para parar",
};

/** Who wrote a reply, and whether a published fixed text left on its own. */
export const authorLabel = (
  author: ReviewAuthor,
  fixedKey: FixedMessageKey | null,
  automatic: boolean,
): string => {
  const base = `${AUTHOR_LABEL[author]}${automatic ? " publicado, automático" : ""}`;
  return fixedKey === null ? base : `${base}: ${FIXED_KEY_LABEL[fixedKey]}`;
};

export const DELIVERY_LABEL: Readonly<Record<ReplyDeliveryState, string>> = {
  queued: "Na fila de envio",
  held: "Retida por uma pausa",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  uncertain: "Envio incerto",
  failed: "Não enviada",
  blocked: "Não enviada",
};

/**
 * Why a reply did not leave, or cannot leave now: one map for the turns and
 * for the reply act's refusal. A code with no text here is shown by its words.
 */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  newer_message: "o contato escreveu de novo",
  outside_service_window: "a janela de 24 h fechou",
  service_window_closed: "a janela de 24 h fechou",
  opt_out_open: "o contato pediu para parar",
  opted_out_since: "o contato pediu para parar",
  do_not_contact: "o contato não deve ser contatado",
  transport_not_configured: "nenhum envio está ligado agora",
  execution_stopped: "uma pausa está ativa",
  execution_interrupted: "o envio foi interrompido",
  interrupted: "o envio foi interrompido",
  contact_erased: "o número foi apagado",
  job_failed: "o envio não pôde ser concluído",
  send_failed: "o envio falhou",
  contact_not_found: "o número não está no CRM",
  contact_unresolved: "o número não pôde ser conferido no CRM",
  contact_ambiguous: "mais de um contato do CRM tem este número",
  consent_unknown: "o CRM não registra o consentimento",
  crm_unavailable: "o CRM não respondeu",
  channel_inactive: "o canal está desativado",
  q8_production_channel: "o canal não é de teste",
  conversation_not_found: "a conversa não foi encontrada",
  content_redacted: "o conteúdo foi apagado pela retenção",
  fixed_text_expired: "o texto fixo passou do prazo",
  provider_rejected: "o WhatsApp recusou o envio",
  timeout: "o WhatsApp não respondeu a tempo",
  network_error: "a conexão com o WhatsApp falhou",
  rate_limited: "o WhatsApp limitou os envios",
  access_token_invalid: "a credencial do WhatsApp não é válida",
  invalid_request: "o WhatsApp recusou o pedido",
  provider_unknown_error: "o WhatsApp respondeu com um erro desconhecido",
  unexpected_status: "o WhatsApp respondeu de forma inesperada",
  malformed_success: "o WhatsApp respondeu de forma inesperada",
  response_too_large: "o WhatsApp respondeu de forma inesperada",
};

export const reasonText = (code: string): string =>
  REASON_TEXT[code] ?? code.replaceAll("_", " ");

const REFUSED_CONTENT: Readonly<Record<string, string>> = {
  unsupported_content: "áudio, imagem ou outro formato",
  empty_body: "mensagem vazia",
  body_too_long: "texto longo demais",
  admission_refused: "mensagem recusada",
};

/** A message the transport refused: its reason only, never its content. */
export const refusedMarker = (reason: string): string =>
  `[mensagem não exibida: ${REFUSED_CONTENT[reason] ?? "formato não suportado"}]`;

export const HIDDEN_MARKER = {
  withheld: "[mensagem não exibida: não é de teste]",
  erased: "[mensagem apagada pela retenção]",
} as const;

// The reply (SI-87): the member's own text, confirmed, then queued.

export const REPLY_GROUP_LABEL = "Responder ao contato";

export const REPLY_LABEL = "Sua resposta";

export const REPLY_HINT =
  "Escreva a resposta com suas palavras. Ela sai como texto simples, pelo WhatsApp da clínica.";

/** The composer's count, in code points, against the one bound. */
export const replyCounter = (count: number): string =>
  `${count.toLocaleString("pt-BR")} de 2.000 caracteres`;

export const REPLY_INVALID_TEXT =
  "Use de 1 a 2.000 caracteres, sem caracteres de controle.";

export const REPLY_BUTTON = "Enviar resposta";

export const REPLY_CONFIRM_TITLE = "Enviar esta resposta ao contato?";

export const REPLY_CONFIRM_BODY =
  "Ela entra na fila e sai pelo WhatsApp da clínica. Depois de enviada, não volta.";

export const REPLY_CONFIRM_BUTTON = "Enviar";

export const CANCEL_BUTTON = "Cancelar";

export const REPLY_PENDING_TEXT = "Registrando sua resposta…";

export const CHANGED_WHILE_OPEN =
  "O contato escreveu de novo enquanto você confirmava. Leia a mensagem nova antes de enviar.";

/** Why a reply cannot be asked for now, as the server computed it. */
export const REPLY_UNAVAILABLE_TEXT: Readonly<
  Record<ReplyUnavailableReason, string>
> = {
  not_held:
    "A conversa está com a IA. Só uma conversa que está com uma pessoa pode ser respondida aqui.",
  window_closed:
    "A janela de 24 h fechou: uma resposta só pode sair depois que o contato escrever de novo.",
  opt_out_open:
    "O contato pediu para parar de receber mensagens: resolva o pedido pelo terminal.",
  nothing_to_answer: "Não há mensagem do contato para responder.",
  content_erased:
    "A mensagem do contato foi apagada pela retenção; responda quando ele escrever de novo.",
  reply_limit:
    "Cinco respostas já respondem a esta mensagem. Espere o contato escrever de novo.",
  do_not_contact:
    "O contato não deve ser contatado: nenhuma resposta pode sair.",
};

// The second factor the reply asks for (ADR 0026 §E: verified within the hour).

export const STEP_UP_TEXT =
  "Para enviar, confirme o código do seu aplicativo autenticador. A confirmação vale por uma hora.";

export const STEP_UP_NEW_FACTOR_NOTE =
  "Se você configurou o aplicativo nesta mesma sessão, saia e entre de novo antes de enviar.";

export const STEP_UP_DONE = "Código confirmado. Envie a resposta de novo.";

export const NO_FACTOR =
  "Esta conta não tem um aplicativo autenticador. Saia e entre de novo para configurá-lo.";

export const STEP_UP_SIGN_OUT =
  "O código foi aceito, mas o envio ainda pede a confirmação. Saia e entre de novo para enviar.";

/** What the member is told once a reply act settles. */
export const REPLY_OUTCOME_TEXT = {
  queued: "Resposta na fila de envio.",
  recorded: "Resposta na fila de envio.",
  already_recorded:
    "Esta resposta já estava registrada. Nada foi enviado de novo.",
  second_factor_required:
    "Confirme o código do aplicativo autenticador para enviar. Nada foi enviado.",
  withheld: "Esta conversa não pode ser respondida aqui. Nada foi enviado.",
  not_held: "A conversa não está mais com uma pessoa. Nada foi enviado.",
  not_waiting: "Esta conversa saiu da fila. Nada foi enviado.",
  stale:
    "O contato escreveu de novo. Leia a mensagem nova antes de responder. Nada foi enviado.",
  nothing_to_answer:
    "Não há mensagem do contato para responder. Nada foi enviado.",
  content_erased:
    "A mensagem do contato foi apagada pela retenção; responda quando ele escrever de novo. Nada foi enviado.",
  reply_limit:
    "Cinco respostas já respondem a esta mensagem. Espere o contato escrever de novo. Nada foi enviado.",
  busy: "Outra mensagem desta conversa está saindo agora. Tente de novo em alguns segundos. Nada foi enviado.",
  not_allowed: "Você não tem acesso a esta conversa agora. Nada foi enviado.",
  not_found: "Conversa não encontrada. Nada foi enviado.",
  refused: `${REPLY_INVALID_TEXT} Nada foi enviado.`,
  unknown:
    "Não foi possível confirmar se a resposta foi registrada. Confira a conversa antes de tentar de novo.",
} as const;

export const notSendableText = (reason: string | null): string =>
  `Esta resposta não pode sair agora: ${reasonText(reason ?? "do_not_contact")}. Nada foi enviado.`;

// The release (SI-87): the conversation goes back to the agent.

export const RELEASE_GROUP_LABEL = "Devolver à IA";

export const RELEASE_BUTTON = "Devolver à IA";

export const RELEASE_CONFIRM_TITLE = "Devolver esta conversa à IA?";

export const RELEASE_CONFIRM_BODY =
  "A IA volta a responder as próximas mensagens do contato, inclusive uma que a triagem ainda não leu. Respostas suas já na fila ainda saem.";

export const RELEASE_CONFIRM_BUTTON = "Devolver";

export const RELEASE_CHANGED_WHILE_OPEN =
  "O contato escreveu de novo enquanto você confirmava. Leia a mensagem nova antes de devolver.";

export const OPT_OUT_OPEN_RELEASE =
  "O contato pediu para parar de receber mensagens: resolva pelo terminal antes de devolver a conversa.";

/** What the member is told once a release settles. */
export const RELEASE_OUTCOME_TEXT = {
  released: "Conversa devolvida à IA.",
  already_with_agent: "A conversa já estava com a IA.",
  withheld: "Esta conversa não pode ser devolvida aqui.",
  not_waiting: "Esta conversa saiu da fila. Nada foi devolvido.",
  stale: "O contato escreveu de novo. Leia antes de devolver.",
  opt_out_open:
    "O contato pediu para parar. Resolva o pedido pelo terminal antes de devolver.",
  busy: "Outra mensagem desta conversa está saindo agora. Tente de novo em alguns segundos.",
  not_allowed: "Você não tem acesso a esta conversa agora.",
  not_found: "Conversa não encontrada.",
  refused: "Não foi possível devolver: atualize a conversa e tente de novo.",
  unknown:
    "Não foi possível confirmar se a conversa foi devolvida. Confira a conversa antes de tentar de novo.",
} as const;

// The fixed sentences the screens show (docs/PHASE_2C_BRIEF.md §7.5, §10,
// §12), in Brazilian Portuguese for the owner. One place, so a test can pin
// them and a review sees every change.
//
// No sentence here, and no label anywhere in the module, says or implies that
// a message, draft or reply was approved for sending: recording a review
// decision is never a send (REVIEW ACCEPTANCE ≠ SEND, SI-45, SI-58).

export const REVIEW_DECISIONS_NOTE =
  "Abra uma análise aguardando revisão para registrar sua decisão.";

export const REVIEW_NOT_A_SEND_NOTE =
  "Registrar uma decisão nunca aprova nem envia uma resposta.";

export const REPLY_DRAFT_NOTE =
  "O rascunho de resposta não faz parte desta análise: ele aparece em “Mensagem e resposta”.";

// ADR 0023 §L: what the assistant read and the text the send would carry, for
// a review of synthetic or test data. Accepting still sends nothing.
export const CONVERSATION_TITLE = "Mensagem e resposta";

export const CONVERSATION_NOTE =
  "O que o assistente leu, depois do filtro, e o texto que o envio levaria. Aceitar não envia: o envio é um passo separado.";

export const CONVERSATION_UNAVAILABLE =
  "Indisponível: só revisões com dados sintéticos ou de teste mostram a mensagem e a resposta.";

export const CONVERSATION_NEWER_MESSAGE =
  "O contato escreveu de novo depois desta mensagem. Esta resposta não será enviada: decida a revisão da mensagem mais recente.";

// ADR 0026 §A: a person replied to this message; this draft is not sent.
export const CONVERSATION_ANSWERED_BY_PERSON =
  "Uma pessoa já respondeu esta mensagem. Esta resposta não será enviada.";

/** "Quem respondeu" for a reply a person wrote (ADR 0026 §A). */
export const PERSON_AUTHOR_LABEL = "Uma pessoa escreveu a resposta";

export const CONVERSATION_NO_SCREENING =
  "Esta mensagem não passou pelo filtro da recepção; o texto original não é mostrado.";

export const CONVERSATION_REDACTED = "Apagado pela retenção.";

export const CONVERSATION_NO_DRAFT = "Sem rascunho de resposta.";

export const SCREENING_CLASS_LABELS = {
  administrative: "Administrativa",
  mixed: "Mista: uma parte foi omitida",
  sensitive_only: "Só assunto sensível",
  safety: "Risco à vida ou à segurança",
  unknown: "Não reconhecida",
} as const;

/** Why nothing of the message was read, by its class. */
export const SCREENING_NOTHING_READ = {
  administrative: CONVERSATION_REDACTED,
  mixed: CONVERSATION_REDACTED,
  sensitive_only: "Só assunto sensível: o modelo não leu nada desta mensagem.",
  safety: "Risco à vida ou à segurança: o modelo não leu nada desta mensagem.",
  unknown: "Nada foi reconhecido: o modelo não leu nada desta mensagem.",
} as const;

export const SCREENING_DISPOSITION_LABELS = {
  model: "O modelo de IA escreveu a resposta",
  fixed_reply: "Texto fixo",
  held_for_person: "Uma pessoa está com a conversa",
} as const;

export const FIXED_MESSAGE_LABELS = {
  safety: "Segurança",
  safety_followup: "Segurança (nova mensagem de crise)",
  human_handoff_ack: "Passagem para uma pessoa",
  sensitive_only_prospect: "Assunto sensível (lead)",
  sensitive_only_client: "Assunto sensível (cliente)",
  clarification: "Pedido de esclarecimento",
  out_of_scope: "Fora do escopo",
  service_unavailable: "Serviço indisponível",
  opt_out_ack: "Confirmação de descadastro",
} as const;

export const NEEDS_EDIT_TEXT =
  "registrada; nesta fase não há próximo passo para ajuste";

// The one act (S7.1): a decision on an open review, confirmed, never a send.
export const DECISION_ACTIONS = [
  { decision: "accepted", label: "Aceitar" },
  { decision: "needs_edit", label: "Precisa de ajuste" },
  { decision: "rejected", label: "Rejeitar" },
] as const;

export const DECISION_CONFIRM_TITLE = {
  accepted: "Aceitar esta análise?",
  needs_edit: "Marcar como “Precisa de ajuste”?",
  rejected: "Rejeitar esta análise?",
} as const;

export const DECISION_RECORDS_TEXT = "Esta ação registra sua decisão.";

export const NO_MESSAGE_SENT_TEXT = "Nenhuma mensagem será enviada.";

export const NO_MESSAGE_WAS_SENT_TEXT = "Nenhuma mensagem foi enviada.";

export const DECISION_ALREADY_RECORDED_TEXT = "Esta decisão já foi registrada.";

export const DECISION_NOT_ALLOWED_TEXT =
  "Você não tem mais permissão para decidir esta análise.";

export const DECISION_NOT_FOUND_TEXT = "Esta análise não foi encontrada.";

export const DECISION_REFUSED_TEXT = "Não foi possível registrar esta decisão.";

export const DECISION_UNKNOWN_TEXT =
  "Não foi possível confirmar se a decisão foi registrada. Atualizamos o estado da análise para verificar.";

export const DO_NOT_CONTACT_ACCEPT_NOTE =
  "Aceitar não está disponível: este contato pediu para não ser contatado.";

export const STOP_CLEAR_NOTE = "Encerrar uma pausa é um ato do operador.";

export const STOP_JOB_KIND_NOTE =
  "Uma pausa por tipo de trabalho desta empresa aparece apenas para leitura.";

export const STOP_PLATFORM_NOTE =
  "Aparecem só as pausas desta empresa; uma pausa da plataforma aparece apenas como o bloqueio de novas execuções na Visão geral e em Custos.";

export const STOP_EVENTS_LABEL = "Pausas não geram eventos";

// The second act (S7.2): interrupt the execution of the tenant or one unit,
// confirmed. It only ever adds a stop: nothing here clears one.
export const TRIP_ACTION_LABEL = "Interromper execução";

export const TRIP_CONFIRM_LABEL = "Confirmar interrupção";

export const TRIP_CONFIRM_TITLE = {
  tenant: "Interromper a execução de toda a empresa?",
  company: "Interromper a execução desta empresa?",
  department: "Interromper a execução deste departamento?",
  agent: "Interromper a execução deste agente?",
} as const;

export const TRIP_BLOCKS_TEXT =
  "Novas execuções ficarão bloqueadas até que a interrupção seja removida por uma operação administrativa.";

export const TRIP_PANEL_NOTE =
  "Interromper impede novas execuções do alvo escolhido; uma execução já iniciada não é interrompida.";

export const TRIP_RUNNING_LABEL = "Em execução";

export const TRIP_STOPPED_LABEL = "Execução interrompida";

export const TRIP_COVERED_LABEL = "Interrompida por uma pausa mais ampla";

export const TRIP_STATE_UNKNOWN_LABEL = "Situação desconhecida";

export const TRIP_STOPPED_TEXT = "Execução interrompida.";

export const TRIP_ALREADY_STOPPED_TEXT =
  "Esta execução já estava interrompida.";

export const TRIP_NOT_ALLOWED_TEXT =
  "Você não tem permissão para interromper esta execução.";

export const TRIP_NOT_FOUND_TEXT = "Este alvo não foi encontrado.";

export const TRIP_BUSY_TEXT =
  "O pedido ainda não pôde ser concluído. Tente de novo.";

export const TRIP_REFUSED_TEXT = "Não foi possível interromper esta execução.";

export const TRIP_NOT_CONFIRMED_TEXT =
  "Não foi possível confirmar a interrupção: nenhuma pausa ativa foi encontrada para este alvo. Você pode tentar de novo.";

export const TRIP_UNKNOWN_TEXT =
  "Não foi possível confirmar se a execução foi interrompida. Atualize a página para verificar antes de tentar de novo.";

/** How a stop tripped from this screen shows its server-fixed reason. */
export const TRIP_REASON_TEXT =
  "Interrupção pedida pelo responsável no Company OS";

// Phase 2D.1: the shadow decision on a review. Advisory only: it performs
// nothing, and the person's decision stays required.
export const SHADOW_TITLE = "Inteligência de decisão";

export const SHADOW_BADGE = "Modo sombra";

export const SHADOW_NOTE =
  "Esta recomendação não executa nenhuma ação e não substitui sua decisão.";

export const SHADOW_POLICY_REQUIRED = "Revisão humana obrigatória";

export const SHADOW_RECOMMENDATION_LABELS = {
  accept: "Aceitar",
  needs_edit: "Precisa de ajuste",
  reject: "Rejeitar",
  abstain: "Sem recomendação",
} as const;

export const SHADOW_STATE_TEXT = {
  none: "Nenhuma avaliação foi feita para esta revisão.",
  unavailable:
    "Indisponível: só revisões com dados sintéticos ou de teste são avaliadas.",
  pending: "Avaliação em andamento. Nenhuma recomendação ainda.",
  indeterminate:
    "O resultado da avaliação é incerto. Nenhuma recomendação foi registrada.",
  invalid:
    "A resposta do motor de decisão foi recusada por não seguir o formato. Nenhuma recomendação foi registrada.",
  failed:
    "O motor de decisão não estava disponível. Nenhuma recomendação foi registrada.",
  refused_stopped:
    "Não avaliada: uma pausa estava ativa quando a avaliação foi pedida.",
  refused_not_eligible:
    "Não avaliada: fora do escopo de dados sintéticos ou de teste.",
  refused_policy_retired:
    "Não avaliada: pedida sob uma versão de política já substituída.",
} as const;

/**
 * lead_triage_reasons.v1 (Phase 2D.2), as the owner reads them. The codes
 * themselves stay under the technical details.
 */
export const SHADOW_REASON_LABELS = {
  triage_complete: "Triagem completa",
  intent_book_appointment: "Quer agendar",
  intent_pricing: "Pergunta sobre valores",
  intent_information: "Pede informações",
  flag_possible_crisis: "Possível situação de crise",
  flag_minor: "Possível menor de idade",
  flag_spam: "Possível spam",
  contact_do_not_contact: "Contato pediu para não ser contatado",
  outcome_out_of_scope: "Fora do escopo do atendimento",
  outcome_needs_input: "Faltam informações",
  insufficient_signal: "Sinais insuficientes",
} as const;

/** A code outside the current vocabulary: stored history (policy v1). */
export const SHADOW_REASON_UNKNOWN = "Motivo de uma versão anterior";

// ADR 0022: the structured decisions on a review (the decision model, Jev
// today), in shadow mode. Advisory only: they perform nothing, and the
// person's decision stays required.
export const STRUCTURED_TITLE = "Decisões estruturadas";

export const STRUCTURED_NOTE =
  "O que o modelo de decisão responderia sobre esta demanda. Não executa nenhuma ação e não substitui sua decisão.";

export const STRUCTURED_EMPTY =
  "Nenhuma decisão estruturada foi pedida para esta revisão.";

export const STRUCTURED_BLOCK_TITLES = {
  businessRoute: "Roteamento da demanda",
  leadIntelligence: "Sinais do contato",
  modelRoute: "Modelo para esta tarefa",
} as const;

export const STRUCTURED_INTENT_LABELS = {
  new_lead: "Primeiro contato",
  pricing_question: "Pergunta sobre valores",
  scheduling: "Quer agendar",
  rescheduling: "Quer remarcar",
  cancellation: "Quer cancelar",
  existing_client_admin: "Pedido administrativo de cliente",
  payment_question: "Pagamento",
  follow_up: "Continuação de conversa",
  unknown: "Não identificada",
} as const;

/** The two routes every business decision may name besides a department. */
export const STRUCTURED_SPECIAL_DEPARTMENTS: Readonly<Record<string, string>> =
  {
    human_review: "Revisão humana",
    no_action: "Nenhuma ação",
  };

export const STRUCTURED_CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  lead_triage: "Triagem de contato",
  none: "Nenhuma (uma pessoa cuida)",
};

export const STRUCTURED_LEVEL_LABELS = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
} as const;

export const STRUCTURED_OBJECTION_LABELS = {
  price: "Preço ou forma de pagamento",
  schedule: "Horários",
  modality: "Formato (sessões online)",
  trust_or_fit: "Confiança ou adequação",
  none: "Nenhuma aparente",
  unknown: "Não dá para saber",
} as const;

export const STRUCTURED_NEXT_ACTION_LABELS = {
  offer_slots: "Oferecer horários",
  share_pricing_information: "Enviar valores e pacotes",
  answer_question: "Responder a dúvida primeiro",
  follow_up_later: "Retomar mais tarde",
  human_review: "Uma pessoa decide o próximo passo",
} as const;

export const STRUCTURED_STATE_TEXT = {
  none: "Não pedida para esta revisão.",
  pending: "Em andamento. Nenhuma resposta ainda.",
  indeterminate: "O resultado é incerto. Nenhuma resposta foi registrada.",
  invalid:
    "A resposta foi recusada (fora do formato ou de outro modelo). Nenhuma resposta foi registrada.",
  failed: "O modelo de decisão não respondeu. Nenhuma resposta foi registrada.",
} as const;

export const STRUCTURED_REFUSAL_TEXT = {
  stopped: "Não pedida: uma pausa estava ativa.",
  not_eligible: "Não pedida: fora do escopo.",
  data_not_authorized: "Não pedida: os dados não são sintéticos nem de teste.",
  model_route_unavailable:
    "Não pedida: nenhum modelo de decisão autorizado e com preço.",
  spend_ceiling_unconfigured: "Não pedida: falta o teto global de gastos.",
  budget_unconfigured: "Não pedida: falta o orçamento.",
  budget_exhausted: "Não pedida: o orçamento do dia acabou.",
} as const;

// Phase 2D.3: the shadow calibration view (Decisões → Inteligência).
export const DECISION_INTELLIGENCE_TAB = "Inteligência";

/**
 * Neutral on purpose (owner review 2026-09-24): the decisions compared are the
 * recorded ones, which in a synthetic demo are fixtures, not the owner's own.
 */
export const DECISION_INTELLIGENCE_DESCRIPTION =
  "Inteligência de decisão: recomendações do motor comparadas com decisões registradas.";

export const DECISION_INTELLIGENCE_EXPLANATION =
  "Estes números comparam recomendações do motor com decisões humanas. Eles não representam uma medida de acurácia clínica ou verdade objetiva.";

export const DECISION_INTELLIGENCE_CARDS = {
  evaluations: "Avaliações em sombra",
  withHumanDecision: "Com decisão humana",
  agreements: "Concordâncias",
  disagreements: "Discordâncias",
  abstained: "Sem recomendação",
  indeterminate: "Indeterminadas",
} as const;

export const DECISION_INTELLIGENCE_EMPTY =
  "Nenhuma avaliação em sombra foi registrada ainda.";

export const DECISION_INTELLIGENCE_SMALL_SAMPLE =
  "Amostra pequena demais para uma taxa.";

export const DECISION_INTELLIGENCE_DISTRIBUTION_HIDDEN =
  "A distribuição aparece quando houver ao menos 5 avaliações.";

/**
 * The `authorized` outbound state: recorded by an operator's CLI send request,
 * never by a review decision (REVIEW ACCEPTANCE is not a send, §7.5).
 */
export const OUTBOUND_AUTHORIZED_TEXT =
  "envio autorizado por um pedido de envio do operador";

export const ACCEPTED_WITHOUT_SEND_LABEL =
  "Decisões aceitas sem envio registrado";

export const OVERVIEW_PROOF_NOTE =
  "Quando uma lista ainda não filtra exatamente o que um número conta, o número diz isso ao lado: a lista mostra todos os registros contados, entre outros.";

export const PLATFORM_ADMISSION_LABEL =
  "Novas execuções bloqueadas pela plataforma";

export const LIFECYCLE_STATUS_LABEL = "Situação estrutural";

export const LIFECYCLE_STATUS_NOTE =
  "A situação estrutural não é progresso: as etapas mostram até onde o trabalho chegou.";

export const STATE_UNKNOWN_NOTE =
  "Situação desconhecida: a última resposta tem mais de dois ciclos de atualização. Ela volta a aparecer quando chegar uma resposta nova.";

export const ABSENT_STEP_TEXT =
  "Ausente: nenhum registro durável comprova esta etapa.";

export const NOT_LOADED_STEP_TEXT =
  "Ainda não carregado: há registros mais antigos. Carregue mais para ver se algum comprova esta etapa.";

/** get_task carries a task's 20 most recent runs, never more (brief §8 row 6). */
export const TASK_RUNS_LIMIT = 20;

export const TASK_RUNS_CAPPED_NOTE = `Só as ${TASK_RUNS_LIMIT} execuções mais recentes desta tarefa aparecem aqui; as mais antigas estão em Execuções.`;

export const JOB_STEPS_NOTE =
  "As etapas vêm do próprio trabalho da execução, não do feed de atividade; não trazem identificador.";

export const COMMUNICATIONS_SCOPE_NOTE =
  "Apenas contagens e nomes de canais: nenhuma mensagem, contato ou conversa é listada, e nada pode ser alterado ou enviado daqui.";

export const MONEY_NOTE =
  "Todo valor é o calculado pelo servidor; esta tela não faz contas.";

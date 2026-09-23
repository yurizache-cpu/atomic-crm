// The fixed sentences the read-only screens show (docs/PHASE_2C_BRIEF.md §7.5,
// §10, §12), in Brazilian Portuguese for the owner. One place, so a test can
// pin them and a review sees every change.
//
// No sentence here, and no label anywhere in the module, says or implies that
// a message, draft or reply was approved for sending: recording a review
// decision is never a send (REVIEW ACCEPTANCE ≠ SEND, SI-45, SI-58).

export const REVIEW_DECISIONS_CLI_NOTE =
  "A decisão ainda é registrada pelo operador nesta fase.";

export const REVIEW_NOT_A_SEND_NOTE =
  "Registrar uma decisão nunca aprova nem envia uma resposta.";

export const REPLY_DRAFT_NOTE = "O rascunho de resposta nunca é mostrado aqui.";

export const NEEDS_EDIT_TEXT =
  "registrada; nesta fase não há próximo passo para ajuste";

export const ALLOWED_DECISIONS_NOTE =
  "Apenas informativo: são as decisões que o servidor aceitaria para esta revisão.";

export const STOP_CLEAR_NOTE = "Encerrar uma pausa é um ato do operador.";

export const STOP_JOB_KIND_NOTE =
  "Uma pausa por tipo de trabalho desta empresa aparece apenas para leitura.";

export const STOP_PLATFORM_NOTE =
  "Aparecem só as pausas desta empresa; uma pausa da plataforma aparece apenas como o bloqueio de novas execuções na Visão geral e em Custos.";

export const STOP_EVENTS_LABEL = "Pausas não geram eventos";

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

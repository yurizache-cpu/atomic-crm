// How a Brazilian lead asks for a person on WhatsApp (ADR 0023 §C, pack
// health_pt_br.v4), matched against the whole message, folded (lower case, no
// accents), with each line break read as the end of a clause.
//
// A request for a person never reaches a model: the database gives the
// contact the handoff text and moves the conversation to a person
// (ops.record_inbound_screening). So these patterns can only send LESS to a
// model. Their cost is a handoff nobody asked for, which takes a booking or a
// payment question away from the receptionist, so they are written for
// precision first. A request they miss is not lost: an administrative message
// still reaches the model, and the reply is reviewed by a person.
//
// The rules that keep them precise, each learned from a judged corpus
// (engine/frontDesk/testSupport/personRequestCorpus.json):
// - An imperative counts only where a clause starts ("me liga quando puder"):
//   "minha mãe me liga todo dia" has a subject first, and quoted speech after
//   a colon or a quote mark ("minha mãe fala: me liga") is not a clause start.
// - Whom the contact asks for comes from a closed list of the people a front
//   desk has (an attendant, the reception, the team, a manager), or from the
//   names the tenant configures (`handoffNames`). "gente" (us, folks) and
//   "atendimento" (the appointment) are not people here.
// - The professional counts only when the contact asks to talk to them, not
//   when the clause is about the session ("posso falar com a psicóloga na
//   sessão?", "por vídeo", "sobre o meu casamento"), or about someone else's
//   ("a psicóloga da minha filha").
// - Asking whether anyone is there counts only when the clause ends there
//   ("tem alguém aí?"), not when it goes on ("tem alguém aí que atende casal?").
// - A configured name next to a relationship is someone else ("meu filho
//   Rafael", "o Bruno, meu marido"), anywhere in the message.
// - Being called counts; being notified does not ("me dá um toque quando o
//   Pix cair"). A transfer counts only of the contact ("me transfere"), never
//   of money ("tem como transferir hoje?").
// A question ABOUT the assistant ("você é robô?") is not a request.

/** A clause start: the message's start, punctuation (not a colon), an emoji, a greeting. */
const START =
  "(?:^|[.!?,;]+ *|[^\\x00-\\x7f\\u00ab\\u00bb\\u2018\\u2019\\u201c\\u201d]+ *|\\b(?:oi+|ola|alo|ei|opa|e ai|eai|bom dia|boa tarde|boa noite|moca|moco|entao|ah|olha|mas|aff|af|q saco|que saco|ta dificil hein|oxe|bah|vixe|nossa|socorro|pelo amor de deus|por favor|pfv|pf|opcao \\d+) )";

/** Not quoted speech: nothing quoted or announced by a colon just before. */
const UNQUOTED =
  "(?<![:'\"\\u00ab\\u2018\\u201c] ?)(?<![:'\"\\u00ab\\u2018\\u201c] ?(?:eu |o |a )?)";

/** Words that may come before the request in the same clause. */
const LEAD_IN =
  "(?:(?:por favor|por gentileza|pf|pfv|pfvr|e|pode|podem|poderia|poderiam|podia|consegue|conseguem|(?:vc|voce|vcs|voces) (?:pode|podem|poderia|poderiam|consegue|conseguem|tem como)|da pra|da p|daria pra|dava pra|tem como|teria como|seria possivel|sera que|sera q|rola de|existe a possibilidade de|tem a possibilidade de|eu|entao|ai|so) )*";

/** Courtesy, laughter or nothing after a request, then the clause ends. */
const END =
  "(?:,? (?:por favor|por fav\\w*|pfv|pf|pfvr|pls|pelo amor de deus|agora|urgente|ja|logo|ai|nao|ne|pessoalmente|por aqui|kk+|rs+|haha+))*(?=\\W*$|[.!?,;:]|\\s*[^\\x00-\\x7f])";

/** Admin topics a request may name ("falar com alguém sobre o pagamento"). */
const ADMIN_TOPIC =
  "(?:o |a |os |as |meu |minha )?(?:pagamento|boleto|pix|cartao|horario|horarios|valor|valores|preco|reembolso|nota|recibo|agendamento|agenda|sessao|consulta|pacote|link|cancelamento|remarcacao|comprovante|plano|convenio)";

/** What makes "alguém" or "uma pessoa" someone other than the team. */
const NOT_STAFF = `(?: (?:da minha|do meu|da familia|de casa|aqui de casa|la de casa|do rh|do banco|do trabalho|da empresa|da escola|antes,? (?:minha|meu)|que|q|mais|pra cuidar|pra me ajudar com|pra conversar|pra desabafar|pra me ouvir)\\b|,? por isso\\b| sobre (?!${ADMIN_TOPIC}\\b))`;

/** Where a manager, the finance team or the team is someone else's. */
const ELSEWHERE =
  "(?! d[oa] (?:banco|cartao|loja|empresa|trabalho|escola|condominio|plano|convenio|salao|firma|meu|minha)\\b)";

/** Who a front desk has, in the forms a lead writes them. */
const STAFF = `(?:(?:(?:o|a|um|uma|1|algum|alguma|outro|outra|o mesmo|a mesma|qualquer) )?(?:atendentes?|atendemte|humano|humana|ser humano|recepcao|recepcionista|secretaria|equipe${ELSEWHERE}(?: da clinica| de vcs| de voces)?|pessoal(?: ai)? (?:da clinica|de vcs|de voces|do atendimento|da recepcao)|povo (?:da clinica|de vcs|de voces)|financeiro${ELSEWHERE}|gerente${ELSEWHERE}|supervisor${ELSEWHERE}|supervisora${ELSEWHERE}|chefe (?:de vcs|de voces)|responsavel(?=${END}| pel[oa] (?:clinica|atendimento|agenda|financeiro|cobranca))|dono da clinica|dona da clinica|suporte|operador|operadora|atendimento humano|(?:moca|moco|menina|mocinha|rapaz) (?:que|q) (?:tava |estava )?me (?:atendeu|atendendo)|(?:moca|moco|menina|mocinha|rapaz) d[ao] (?:recepcao|financeiro|atendimento|clinica|agenda))\\b|(?:seu|teu|sua|tua) (?:chefe|supervisor|supervisora|gerente)\\b|(?:uma|alguma|outra|qualquer) pessoa\\b(?!${NOT_STAFF})|alguem\\b(?!${NOT_STAFF})|algm|alguen|qualquer um|um de (?:vcs|voces)|algum de (?:vcs|voces)|alguem de (?:vcs|voces)|quem (?:manda|resolve|decide|entende|cuida da agenda|cuida dos agendamentos))(?: (?:real|de verdade|de vdd|de carne e osso|humano|humana|vivo|viva|ai|da clinica|da equipe|da recepcao|do atendimento|de vcs|de voces))*`;

/** The professional, as a contact may ask to talk to them; never someone else's. */
const PROFESSIONAL =
  "(?:(?:o|a) )?(?:propri[oa] )?(?:psicologo|psicologa|psi|terapeuta|doutora|doutor|dra|dr|profissional)\\b(?! d[oa] (?:minha|meu|escola|empresa|trabalho|posto|convenio|plano)\\b)";

/** A clause about the session, a process or a booking, not a request to talk now. */
const ABOUT_THE_SESSION = `(?![^.?!]*\\b(?:na sessao|nas sessoes|na primeira|na consulta|durante a sessao|por video|por audio|em ingles|sobre (?!${ADMIN_TOPIC}\\b)|ou (?:ja|eu|so|da|posso|e)|antes ou|pra (?:desmarcar|remarcar|confirmar|cancelar|marcar|agendar))\\b)`;

/** What the assistant is, as a lead refuses it. */
const ASSISTANT =
  "(?:robo|robos|robozinho|bot|bots|chatbot|ia|maquina|maquinas|programa|inteligencia artificial|assistente virtual|atendimento automatico|respostas? automaticas?|mensagens? automaticas?|msgs? automaticas?|respostas? prontas?|automacao|questionario automatico)";

/** A refusal followed by a compliment is a joke ("odeio IA, mas você é ótima"). */
const NO_COMPLIMENT = "(?![^.?!]{0,30}\\bmas (?:vc|voce|ate|ta|e|eh)\\b)";

/** A question asked out of curiosity ("só robô atende? pergunto por curiosidade"). */
const NO_CURIOSITY =
  "(?![\\s\\S]*\\b(?:curiosidade|pergunto pq|pergunto porque|achei o bot|ajudou mais)\\b)";

/** Wanting, needing or being able to, first person. */
const WANT =
  "(?:quero|queria|qro|kero|qero|qeria|qria|quero muito|queria muito|quero mt|queria mt|queria so|so queria|preciso|precizo|precisava|preciso muito|preciso urgente|preciso urgentemente|preciso mesmo|necessito|gostaria de|gostaria muito de|desejo|posso|podia|poderia|da pra|tem como|teria como|consigo|prefiro|preferia|vou querer|to querendo|tou querendo|estou querendo|to precisando|tou precisando|estou precisando|to tentando|tou tentando|estou tentando|deixa eu|me deixa|vim|existe a possibilidade de|tem a possibilidade de)(?: poder)?";

/** Talking something through. */
const TALK =
  "(?:falar|conversar|tirar (?:essa |uma |umas |a |as |minhas )?duvidas?|bater um papo|trocar uma ideia|dar uma palavrinha|ligar)";

/** What a contact may do with the team only (never with a name or the professional). */
const TALK_TO_STAFF =
  "(?:falar|conversar|tirar(?: (?:essa |uma |umas |a |as |minhas )?duvidas?)?|bater um papo|trocar uma ideia|dar uma palavrinha|ligar|resolver(?: isso)?|tratar(?: isso)?|ver isso|fazer uma (?:chamada|ligacao|videochamada))";

/** Adverbs between talking and its object. */
const HOW =
  "(?: (?:urgente|urgentemente|rapidinho|rapido|direto|diretamente|pessoalmente|so|antes|mesmo|agora|ja|hoje|um pouco|por telefone|por ligacao|ao vivo))*";

/** "com" as leads write it. */
const WITH = "(?:com|cm|c|c\\/|cum|pra|para|p\\/)";

/** Not when the speaker is checking with someone first ("deixa eu falar com o Bruno e te falo"). */
const NOT_CHECKING =
  "(?! e (?:te|ja|depois|volto|aviso|confirmo|retorno|falo|vejo)\\b)";

/** Asking to be called: a phone call, which only a person can make. */
const CALL_ME =
  "(?:me liga|me ligue|me liguem|me ligar|me ligarem|liga (?:aqui |ai )?(?:pra|p|pro|para) mim|liga aqui|ligar (?:pra|p|para) mim|me telefona|me telefone|me telefonar|me (?:da|de|dar) uma (?:ligada|ligadinha)|da uma (?:ligada|ligadinha) (?:pra|p) mim|me retorna por (?:ligacao|telefone)|me chama (?:no|por) telefone|me (?:da|de|dar) um toque por telefone)";

/** A person reaching the contact. */
const CONTACTS =
  "(?:me (?:liga|ligar|ligue|ligasse|ligassem|retorna|retornar|retorne|retornasse|retornassem|chama|chamar|chame|chamasse|chamassem|responde|responder|responda|respondesse|respondessem|(?:explicar|explicasse|explique|explica) por (?:ligacao|telefone)|dar um retorno|de um retorno)|(?:fala|falar|falasse|fale|falassem) comigo|falar cmg|entrar em contato|entrasse em contato|entre em contato|entrassem em contato|olhar meu caso|ver meu caso)\\b(?! de\\b)";

/** A person attending the contact. */
const ATTENDS = "me (?:atende|atender|atenda|atendesse)";

/** Asking someone to have a person reach the contact. */
const ASK_SOMEONE =
  "(?:pede (?:pro|pra|para|a|o)|peca (?:pro|pra|para)|pedir (?:pro|pra|para)|fala (?:pro|pra|para)|diz (?:pro|pra|para)|avisa (?:pro|pra|para))";

const pattern = (source: string): RegExp => new RegExp(source);

/** Patterns that need no tenant data. */
export const PERSON_REQUEST_PT_BR: readonly RegExp[] = Object.freeze([
  // "quero falar com uma pessoa", "preciso urgente falar com a recepção",
  // "tô precisando falar com alguém", "preciso resolver isso com uma pessoa".
  pattern(
    `${UNQUOTED}\\b${WANT}(?: eu)?(?: [a-z]+ e)? ${TALK_TO_STAFF}${HOW} ${WITH} ${STAFF}${NOT_CHECKING}`,
  ),
  // "quero falar com a psicóloga antes de marcar", "posso falar com a dra?";
  // never "posso falar com a psicóloga na sessão?".
  pattern(
    `${UNQUOTED}\\b${WANT}(?: eu)?(?: [a-z]+ e)? ${TALK}${HOW} ${WITH} ${PROFESSIONAL}${NOT_CHECKING}${ABOUT_THE_SESSION}`,
  ),
  // "como faço pra falar com um atendente?", "como eu falo com a psicóloga?".
  pattern(
    `\\bcomo (?:eu )?(?:faco|faz|posso|consigo) (?:pra|para) (?:falar|conversar) (?:com|c) (?:${STAFF}|${PROFESSIONAL})`,
  ),
  pattern(`\\bcomo (?:eu )?falo (?:com|c) (?:${STAFF}|${PROFESSIONAL})`),
  // "falar c atendente", "pfv falar c alguem": the bare request.
  pattern(
    `${START}${LEAD_IN}(?:falar|conversar)${HOW} ${WITH} (?:${STAFF}|(?:pessoa|humano|gente)${END})`,
  ),
  // "gostaria de ser atendida por uma pessoa", "ser contatada por alguém da equipe".
  pattern(`\\bser (?:atendid|contatad)[oa]s? (?:por|pel[oa]) ${STAFF}`),
  // "quero falar por telefone com vocês", "prefiro falar ao vivo com vcs".
  pattern(
    `\\b(?:falar|conversar) (?:por telefone|por ligacao|ao vivo|pessoalmente) (?:com|c) (?:vcs|voces)\\b|\\b(?:falar|conversar) (?:com|c) (?:vcs|voces) (?:por telefone|por ligacao|ao vivo|pessoalmente)\\b`,
  ),
  // "quero um atendente", "quero alguém da equipe", "prefiro mil vezes uma pessoa".
  pattern(
    `${UNQUOTED}\\b(?:quero|queria|qro|kero|prefiro(?: mil vezes)?|preciso de|so quero|eu quero e|quero e) ${STAFF}(?:${END}| (?:pra|para) (?:remarcar|marcar|agendar|resolver|me atender|me responder)\\b)`,
  ),
  pattern(
    `\\b(?:quero|queria|prefiro|preciso|eu quero e|quero e) (?:falar com )?gente(?: me atendendo| msm| mesmo)?${END}`,
  ),
  // "prefiro esperar um atendente", "tô esperando um atendente há horas".
  pattern(
    `\\b(?:prefiro|vou|quero|posso) (?:esperar|aguardar) ${STAFF}|\\b(?:eu )?(?:espero|aguardo|to esperando|tou esperando|estou esperando|aguardando) (?:um |uma |o |a |algum |alguma )?(?:atendente|humano|humana|alguem|pessoa|recepcionista|secretaria|atendimento humano)\\b(?!${NOT_STAFF})`,
  ),
  // "quero que um atendente me responda", "preciso que alguém me ligue",
  // "gostaria muito que alguém entrasse em contato", "pede pra psicóloga
  // entrar em contato comigo", "pede pra ela me chamar".
  pattern(
    `${UNQUOTED}\\b(?:quero (?:que|q)|queria (?:que|q)|preciso (?:que|q)|gostaria(?: muito)? (?:que|q)|espero (?:que|q)|manda) ${STAFF} ${CONTACTS}`,
  ),
  pattern(
    `\\b${ASK_SOMEONE} (?:${STAFF}|${PROFESSIONAL}|ela|ele) (?:${CONTACTS}|me (?:dar|de) um toque)`,
  ),
  pattern(
    `${UNQUOTED}\\b(?:quero|queria|preciso|gostaria(?: muito)?) (?:que|q) (?:(?:vcs|voces) )?me (?:liguem|ligue|ligasse|ligassem|telefonem|retornem|retornassem|chamem)\\b`,
  ),
  // "manda um atendente aqui", "bota alguém pra falar comigo".
  pattern(
    `${START}${LEAD_IN}(?:manda|bota|coloca|chama) (?:um |uma |algum |alguma )?(?:atendente|alguem|pessoa|humano)(?: aqui| pra falar comigo| pra me atender| pra me responder)`,
  ),
  // "alguém pode me atender?", "algum atendente poderia me chamar?", "alguém
  // real pode responder?", "será que alguém consegue me ligar ainda hoje?";
  // never "alguém atende sábado?".
  pattern(
    `\\b${STAFF} (?:pode|poderia|podia|consegue|conseguiria|possa) (?:${CONTACTS}|(?:${ATTENDS}|responder|atender|me ajudar)${END})`,
  ),
  pattern(
    `${START}${LEAD_IN}${STAFF} (?:${CONTACTS}|${ATTENDS})${END}`,
  ),
  pattern(
    `\\bse (?:vcs|voces|alguem) (?:puder|puderem|pudesse|pudessem) me (?:ligar|retornar|chamar)\\b`,
  ),
  // "me atende alguém por favor", "me responde alguém".
  pattern(`${START}${LEAD_IN}me (?:atende|responde|liga) ${STAFF}`),
  // "me passa pra um atendente", "vc consegue me passar pra alguém?", "passa
  // meu contato pra equipe", "me coloca com a psicóloga", "me põe em contato".
  pattern(
    `${START}${LEAD_IN}(?:me )?(?:passa|passe|passar|repassa|repasse|repassar|transfere|transfira|transferir|encaminha|encaminhe|encaminhar|coloca|coloque|colocar|poe|bota|joga|conecta|conecte|direciona|direcione|redireciona|redirecione)(?: (?:meu atendimento|meu contato|minha conversa|meu caso|minha mensagem|minha msg))? (?:pra|pro|para|p\\/|p|com|em contato com|em contato c|a) (?:${STAFF}|${PROFESSIONAL})`,
  ),
  pattern(
    `${START}${LEAD_IN}me (?:poe|coloca|coloque|bota) em contato${END}`,
  ),
  // "chama um humano", "chama alguém da recepção", "chama a doutora".
  pattern(
    `${START}${UNQUOTED}${LEAD_IN}(?:chama|chame|chamar|chamem)(?: ai| la| pra mim)? (?:${STAFF}|${PROFESSIONAL})`,
  ),
  // "me passa o contato de alguém", "me dá o número da recepção".
  pattern(
    `${START}${LEAD_IN}(?:me )?(?:passa|passar|manda|mandar|envia|enviar|da|de|dar) (?:o )?(?:contato|numero|telefone|whats) (?:de|do|da) ${STAFF}`,
  ),
  // "me transfere", "pode me transferir?"; never a transfer of money.
  pattern(
    `${START}${LEAD_IN}me (?:transfere|transfira|transferir)(?:,? (?:por favor|pfv|pf|pfvr|ai|logo))*(?=\\W*$|[.!?,;:]|\\s*[^\\x00-\\x7f])`,
  ),
  pattern(
    `\\bquero ser (?:transferid[oa]|encaminhad[oa]) (?:pra|para|a) ${STAFF}`,
  ),
  // "me liga quando puder", "pode me ligar?", "liga aí pra mim"; never "minha
  // mãe me liga", "minha mãe fala: me liga" or "me liga não".
  pattern(`${START}${UNQUOTED}${LEAD_IN}${CALL_ME}\\b(?! (?:nao|n)\\b)`),
  pattern(
    `\\b(?:tem como|da pra|podem|poderiam|(?:vcs|voces) podem) (?:vcs |voces )?me (?:ligar|ligarem|ligue|liguem|retornar|retornarem)\\b`,
  ),
  pattern(
    `\\b(?:aguardo|no aguardo de|quero|queria|gostaria de|prefiro) (?:uma )?ligacao\\b|\\bmarcar uma (?:ligacao|chamada) com ${STAFF}`,
  ),
  pattern(
    `\\b(?:aguardo|solicito|quero|queria|gostaria de)(?: o| um)? (?:contato|retorno|uma ligacao|ligacao)(?: direto)? (?:de|com|da|do) ${STAFF}`,
  ),
  pattern(
    `(?<!\\bnao )\\b(?:queria|quero|posso|da pra eu|tem como eu) ligar(?: ai| pra vcs| pra voces| pra clinica| pra recepcao)?${END}`,
  ),
  pattern(`\\b(?:por telefone|por ligacao) comigo\\b`),
  // "tem alguém aí?", "tem humano aí?", "tem algum humano por aí?", "tem
  // alguém que possa me ajudar?"; never "tem alguém aqui em casa".
  pattern(
    `${START}(?:e |mas )?(?:(?:isso aqui|aqui|vcs|voces) )?(?:(?:nao |n )?(?:tem|ta tendo|teria) )(?:alguem|algm|alguen|algum ser humano|alguma pessoa|algum atendente|algum humano|um humano|humano|uma pessoa|atendente|um vivente|ser humano)(?: (?:vivo|viva|de verdade|de vdd|de carne e osso|real|humano|humana|ai|ae|por ai|online|ai pra mim|trabalhando(?: ai)?|disponivel|nesse numero|neste numero|me atendendo|atendendo|respondendo|lendo(?: isso| essas mensagens| aqui)?|le essas mensagens|pra (?:me )?(?:atender|responder|falar|conversar)|pra eu falar|do atendimento|da equipe|da clinica|da recepcao|do financeiro|q nao seja (?:bot|robo|ia|maquina)|que nao seja (?:bot|robo|ia|maquina)|pra falar comigo|(?:que|q) possa me (?:ajudar|atender)))*${END}`,
  ),
  pattern(
    `${START}(?:e |mas )?(?:(?:isso aqui|aqui|vcs|voces) )?(?:tem gente (?:trabalhando(?: ai)?|ai|de verdade|real)${END}|(?:nao|n) tem gente nao\\b)`,
  ),
  // "alguém aí?", "algueeem??", "alguém de carne e osso pfvr".
  pattern(
    `${START}(?:e |mas )?(?:alguem|algue+m+|algm|alguen)(?: (?:ai|ae|por ai|vivo|real|de verdade|de vdd|de carne e osso|online|me atendendo|lendo isso|le essas mensagens))*${END}`,
  ),
  // "ninguém pra me atender?", "ninguém vai me atender?".
  pattern(
    `${START}(?:e |mas )?(?:(?:nao |n )?(?:tem )?)(?:ninguem|ngm) (?:pra (?:me )?(?:atender|responder)|me atendendo|respondendo|atendendo|vai me atender|vai me responder|me atende|me responde|atende (?:aqui|ai|nessa clinica)|responde (?:aqui|ai|nessa clinica))(?: (?:aqui|ai|nao))*${END}`,
  ),
  pattern(
    `${START}${UNQUOTED}(?:cade|kd) (?:vcs|voces|o pessoal|a equipe|o povo(?: da clinica)?|${STAFF})(?: (?:da clinica|de vcs|gente))?${END}`,
  ),
  // "a moça que me atendeu tá aí?", "a secretária tá aí?", "secretaria aí?".
  pattern(
    `${START}(?:a |o )?(?:moca|moco|menina|rapaz|atendente|pessoa) (?:que|q) (?:me )?(?:atendeu|tava me atendendo|estava me atendendo|falou comigo)(?: (?:ontem|antes|hoje))? (?:ta|esta) (?:ai|online)${END}`,
  ),
  pattern(
    `${START}(?:a |o )?(?:secretaria|recepcao|recepcionista|atendente)(?: (?:ta|esta))? (?:ai|online)(?=\\s*\\?)`,
  ),
  // "vcs têm atendente humano?", "é só robô que atende aqui?".
  pattern(
    `\\btem (?:um |algum )?(?:atendimento|atendente) (?:com |de |por )?(?:gente|pessoa|humano|humana)(?: de verdade| real)?${END}${NO_CURIOSITY}`,
  ),
  pattern(
    `\\b(?:e|eh) (?:so|somente|apenas) ${ASSISTANT} (?:(?:que|q) (?:atende|responde)(?: aqui)?|aqui)${END}${NO_CURIOSITY}`,
  ),
  pattern(
    `\\b(?:so|somente|apenas) (?:tem|existe) ${ASSISTANT}(?: aqui)?${END}${NO_CURIOSITY}`,
  ),
  // "... está disponível pra conversar comigo?".
  pattern(
    `\\b(?:disponivel|livre) (?:pra|para) (?:falar|conversar) (?:comigo|cmg)${END}`,
  ),
  // "atendimento humano", "estou precisando de atendimento humano", "quero
  // suporte humano", "tô precisando de um atendimento de verdade".
  pattern(
    `(?:${START}|\\b${WANT} |\\bpreciso de |\\bprecisando de |\\bquero )(?:um |uma |o )?(?:atendimento|suporte|ajuda|contato|resposta)(?: de| com| por)?(?: um| uma| alguma)? (?:humano|humana|atendente|pessoa de verdade|pessoa real)\\b`,
  ),
  pattern(
    `\\b(?:${WANT}|preciso de|precisando de) (?:um |uma |o )?(?:atendimento|suporte|ajuda) de verdade\\b`,
  ),
  pattern(
    `\\batendimento (?:de|com) (?:uma )?(?:gente|pessoa),? nao (?:de|do|desse|com|com o) ${ASSISTANT}\\b`,
  ),
  // A message that is only the word: "ATENDENTE", "humanoooo", "pfv atendente";
  // or a clause of it with courtesy: "... HUMANO PFV".
  pattern(
    `^\\W*(?:(?:pfv|pf|por favor) )?(?:um |uma |o |a )?(?:atendent\\w*|atendemte|human[oa]+|recepcao|secretaria|alguem|algm|operador\\w*|pessoa de verdade|pessoa real|atendimento humano)(?:,? (?:por fav\\w*|pf|pfv|pfvr|pls|please|agora|urgente|ja))*(?=\\W*$|\\s*[^\\x00-\\x7f])`,
  ),
  pattern(
    `^\\W*(?:uma )?pessoa(?:,? (?:por fav\\w*|pf|pfv|pfvr|pls|please))+\\W*$`,
  ),
  pattern(
    `[.!?]+ *(?:atendent\\w*|human[oa]+)(?:,? (?:por fav\\w*|pf|pfv|pfvr|agora|urgente))+(?=\\W*$|[.!?,;]|\\s*[^\\x00-\\x7f])`,
  ),
  // "só falo com humano", "só converso com pessoa".
  pattern(
    `\\b(?:so|somente) (?:falo|converso|quero falar|quero conversar|atendo) ${WITH} (?:${STAFF}|pessoa|gente|humano)\\b`,
  ),
  // Refusing the assistant: "não quero falar com robô", "não aguento mais
  // falar com bot", "não vim aqui pra falar com máquina", "não quero falar
  // sobre isso com o atendimento automático".
  pattern(
    `\\b(?:nao|n) (?:quero|vou|to a ?fim de|tou a ?fim de|estou a ?fim de|vim aqui|vim|confio em|aguento|suporto)(?: mais)?(?: (?:ficar|pra|para))?(?: (?:falar|falando|conversar|conversando|responder|respondendo|escrever|escrevendo|ser atendid[oa]|tratar|resolver))?(?: (?:com|pra|para|por|a|o))? (?:o |a |um |uma |esse |essa |esse tipo de |nenhum |nenhuma )?${ASSISTANT}\\b(?! (?:de|do|da|no|na|em)\\b)${NO_COMPLIMENT}`,
  ),
  pattern(
    `${UNQUOTED}\\b(?:nao|n) (?:quero|vou) (?:mais )?(?:falar|conversar)(?: [a-z]+){0,6} (?:com|c) (?:o |a |esse |essa )?${ASSISTANT}\\b${NO_COMPLIMENT}`,
  ),
  pattern(
    `${START}${UNQUOTED}(?:nao|n) (?:quero|vou) (?:mais )?(?:falar|conversar) (?:com|c) (?:vc|voce)\\b[^.?!]{0,12}\\b(?:quero|cade|me passa|chama)\\b`,
  ),
  pattern(
    `\\bnao com (?:o |a |um |uma |esse |essa )?(?:${ASSISTANT}|sistema|assistente)\\b`,
  ),
  pattern(
    `\\b(?:odeio|detesto|chega de|chega desse|chega dessa|cansei de|cansado de|cansada de|para de|pare de|parem de|desisto (?:desse|dessa|do|da)|me tira (?:desse|dessa|do|da)) (?:falar com |conversar com |responder |ficar respondendo )?(?:o |a |esse |essa |esses |essas )?${ASSISTANT}\\b(?! (?:de|do|da|no|na|em|q|que)\\b)${NO_COMPLIMENT}`,
  ),
  pattern(
    `\\b(?:para|pare|parem) de (?:me )?(?:responder|mandar|enviar)(?: (?:vc|voce))?(?: (?:mensagem|mensagens|respostas?|msgs?))? ?automatic`,
  ),
  pattern(
    `${START}(?:o |a |esse |essa )?(?:robo|bot|ia|maquina|programa) nao (?:entende|resolve|ajuda|serve)\\b`,
  ),
  pattern(
    `${START}(?:sem|sai|fora|xo|chega de) (?:esse |essa |o |a )?(?:robo|robozinho|bot|ia)${END}`,
  ),
  pattern(
    `${START}(?:robo|bot|ia|maquina|automatico) nao,? (?:por favor|pfv|pf)?${END}`,
  ),
  pattern(
    `\\bse for(?: (?:robo|bot|ia|maquina))?,? nem (?:continuo|respondo)\\b`,
  ),
]);

/** Who makes a configured name someone else's. */
const RELATIONSHIP =
  "(?:meu|minha|meus|minhas|marido|esposa|esposo|mulher|filho|filha|irma|irmao|mae|pai|prima|primo|avo|tia|tio|neta|neto|sogra|sogro|cunhada|cunhado|namorado|namorada|noivo|noiva|amiga|amigo|chefe|gerente|colega|socia|socio|vizinha|vizinho|psiquiatra|cardiologista|medico|medica|pediatra|professora|professor|coordenadora|coordenador|manicure|contador|contadora)";

/** Wanting, for a name: also "tenho que" ("tenho que falar com a Carla urgente"). */
const WANT_NAMED = `(?:${WANT}|tenho que|tenho q)`;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A configured name as leads write it: folded, with or without its title. */
function nameAlternatives(names: readonly string[]): string | null {
  const forms = new Set<string>();
  for (const raw of names) {
    const folded = raw
      .normalize("NFD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
    if (!/^[a-z][a-z .'-]{0,59}$/u.test(folded)) continue;
    forms.add(escapeRegExp(folded).replace(/\\\./gu, "\\.?"));
    const bare = folded.replace(/^(?:dr|dra|doutor|doutora)\.? /u, "");
    if (bare !== folded && bare !== "") forms.add(escapeRegExp(bare));
  }
  if (forms.size === 0) return null;
  return [...forms].sort((a, b) => b.length - a.length).join("|");
}

/**
 * Patterns for the people a tenant's contacts may ask for by name (the
 * operating policy's `handoffNames`), built per screening. Empty without
 * names, so a tenant that names no one gets only the patterns above.
 */
export function namedPersonRequests(names: readonly string[]): RegExp[] {
  const alternatives = nameAlternatives(names);
  if (alternatives === null) return [];
  const BARE = `(?:(?:dr|dra|doutor|doutora)\\.? )?(?:${alternatives})\\b`;
  const NAME = `(?:(?:o|a) )?${BARE}(?![^.?!]{0,25}\\b(?:(?:meu|minha) ${RELATIONSHIP}|(?:ele|ela) (?:e|eh) (?:meu|minha|a minha|o meu)|(?:q|que) (?:e|eh) (?:a |o )?(?:meu|minha))\\b)(?!,? \\(?(?:(?:o|a) )?(?:${RELATIONSHIP})\\b)(?! (?:d[oa] (?:meu|minha)\\b|o (?:comprovante|link|recibo|boleto|pix|valor|horario|numero|contato)\\b|tb\\b|tambem\\b|como\\b|na sessao\\b|no link\\b))`;
  // Anywhere in the message, a name next to a relationship is someone
  // else's, and a message that names a relative "chama <name>" is naming.
  const GUARD = `^(?![\\s\\S]*\\b${RELATIONSHIP}(?: (?:o|a))? ${BARE})(?![\\s\\S]*\\b${RELATIONSHIP}\\b[\\s\\S]*\\b(?:se chama|chama|nome e) ${BARE})[\\s\\S]*?`;
  const named = (source: string): RegExp => pattern(`${GUARD}${source}`);
  return [
    // "quero falar com o Rafael", "tenho que falar com a Carla urgente", "eu
    // só falo com o Dr. Paulo"; never "deixa eu falar com o Bruno e te falo".
    named(
      `${UNQUOTED}\\b${WANT_NAMED}(?: eu)?(?: [a-z]+ e)? ${TALK}${HOW} ${WITH} ${NAME}${NOT_CHECKING}${ABOUT_THE_SESSION}`,
    ),
    named(`\\b(?:so|somente) (?:falo|converso) ${WITH} ${NAME}`),
    // "preciso da Marina urgente", "quero a resposta da Marina".
    named(`\\b(?:preciso|quero|queria) (?:d[ao]|de) ${BARE}`),
    named(
      `\\b(?:aguardo|solicito|quero|queria|gostaria de)(?: um| o| a)? (?:contato|retorno|uma ligacao|ligacao|resposta)(?: direto)? (?:de|com|da|do) ${NAME}`,
    ),
    // "passa pro Rafael", "me passa a Marina", "passa a Carla aí", "chama a
    // Marina", "cadê a Marina?", "bota a Carla na conversa", "pq tô falando
    // com bot? quero a Marina".
    named(
      `${START}${LEAD_IN}(?:me )?(?:passa|passe|passar|repassa|repasse|encaminha|encaminhe|encaminhar|poe|joga|conecta|redireciona)(?: (?:meu atendimento|meu contato|minha conversa|meu caso|minha mensagem|minha msg))? (?:pra|pro|para|com|em contato com) ${NAME}`,
    ),
    named(
      `${START}${LEAD_IN}me (?:coloca|coloque|poe|bota) em contato (?:com|c) ${NAME}`,
    ),
    named(`${START}${LEAD_IN}me (?:passa|passe) ${NAME}`),
    named(`${START}${LEAD_IN}(?:passa|passe) ${NAME}(?: (?:ai|aqui))?${END}`),
    named(`${START}${LEAD_IN}(?:bota|coloca|poe) ${NAME} na conversa\\b`),
    named(
      `${START}${UNQUOTED}${LEAD_IN}(?:chama|chame|chamar)(?: ai| la)? ${NAME}`,
    ),
    named(`${START}${UNQUOTED}(?:cade|kd) ${NAME}`),
    named(
      `${START}${LEAD_IN}(?:me )?(?:passa|passar|manda|mandar|envia|enviar|da|de|dar) (?:o )?(?:contato|numero|telefone|whats) (?:de|do|da) ${BARE}`,
    ),
    named(`\\b${ASSISTANT}\\b[^.]{0,60}\\bquero ${NAME}${END}`),
    // "a Marina tá aí?", "a Carla tá?", "Rafael, você tá aí?", "responde aí,
    // Rafael", "Marina, me responde".
    named(
      `${START}${NAME}(?: ou ${NAME})?,?(?:(?: (?:vc|voce))?(?: (?:ta|esta|estao|tao|ja ta|ja esta))? (?:ai|online|por ai)| (?:ta|esta|tai)(?: disponivel)?)${END}`,
    ),
    named(`${START}(?:me )?(?:responde|atende) ai,? ${NAME}`),
    named(`${START}${NAME},? ${CONTACTS}${END}`),
    // "a Marina pode me ligar?", "tem como a Carla me chamar?", "o Bruno pode
    // falar comigo?", "a Marina pode me atender?"; never "a Marina pode me
    // atender na terça?".
    named(
      `\\b(?:(?:tem como|da pra|sera q|sera que) ${NAME}|${NAME} (?:pode|poderia|podia|consegue)) (?:${CONTACTS}|${ATTENDS}${END})`,
    ),
    // "quero que a Marina me ligue", "pede pro Bruno me retornar", "diz pra
    // Dra. Helena que preciso falar com ela".
    named(
      `${UNQUOTED}\\b(?:quero (?:que|q)|queria (?:que|q)|preciso (?:que|q)|gostaria(?: muito)? (?:que|q)|espero (?:que|q)|manda) ${NAME} ${CONTACTS}`,
    ),
    named(`\\b${ASK_SOMEONE} ${NAME} (?:${CONTACTS}|me (?:dar|de) um toque)`),
    named(
      `\\b(?:diz|fala|avisa) (?:pro|pra|para) ${NAME} (?:que|q) (?:preciso|quero|queria) (?:falar|conversar)`,
    ),
  ];
}

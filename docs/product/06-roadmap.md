# Roadmap de implementação

Cada fase fecha um pequeno ciclo de valor e não começa com integração externa. A Fase 0 está concluída com documentação; as fases seguintes exigem aprovação humana.

## Phase 0 — Auditoria e preparação

- **Objetivo:** validar a fundação, riscos e direção de fork.
- **Entrega:** documentos de produto, inventário técnico, recomendação de domínio e segurança.
- **Definition of done:** sem mudança funcional; comandos de validação registrados, inclusive bloqueios.

## Phase 1 — Fundação segura de domínio

- **Objetivo:** permitir dados comerciais reais com controle de acesso defensável.
- **Features:** RLS/grants/storage privados, signup/roles revisados, consentimento comercial mínimo, `lead_profiles`, oportunidades, motivos de perda e localization/branding base.
- **Schema:** tabelas/índices mínimos e views-summary atualizadas no schema declarativo.
- **Dependências:** decisão de usuário/tenant, hospedagem Supabase e política de privacidade.
- **Riscos:** quebrar bootstrap/Auth; migração de permissões; confundir CRM com clínico.
- **Testes:** migration/reset, RLS matriz de papéis, storage, cadastro/edição e importação mínima.
- **Done:** usuário autorizado vê somente o escopo permitido e pode cadastrar/fechar um lead sem campo clínico.

## Phase 2 — Pipeline de aquisição clínica

- **Objetivo:** tornar o fluxo de lead até paciente visível e configurável.
- **Features:** pipeline proposto, estado operacional, transições validadas, timestamps, eventos append-only, próxima ação e fila de follow-up manual.
- **Schema:** `business_events`, `follow_ups`, campos de projeção; adaptação de `deals` ou nova UI de oportunidades.
- **Dependências:** Phase 1 e definição final de estágios/ações pela clínica.
- **Riscos:** Kanban excessivo, estado duplicado e gravação de eventos fora de transação.
- **Testes:** transições permitidas, reativação, perda com motivo, idempotência e aging.
- **Done:** operador identifica, atualiza e acompanha cada lead sem chamar silêncio de perda.

## Phase 3 — Dashboard e analytics de cohort

- **Objetivo:** responder Health → Funnel → Attention sem agregação pesada no frontend.
- **Features:** funil, cohorts, tempos de conversão, motivos de perda, atenção e filtros por fonte/campanha.
- **Schema:** views/RPCs, índices e opcionalmente tabela de custos manuais.
- **Dependências:** eventos consistentes da Phase 2.
- **Riscos:** métrica ambígua, cohort versus caixa confundidos, números aparentando precisão sem dados.
- **Testes:** fixtures determinísticas, fórmulas, timezone e performance de queries.
- **Done:** painel explica definicões e fornece uma ação comercial prioritária.

## Phase 4 — Sistema de follow-up

- **Objetivo:** reduzir esquecimento sem automatizar pressão.
- **Features:** cadências configuráveis, templates, snooze/maturação, conclusão e reativação manual.
- **Schema:** políticas de cadência, outcomes, preferências de contato; sem disparo automático inicial.
- **Dependências:** pipeline e consentimento.
- **Riscos:** mensagens em momento inadequado e falsa classificação de perda.
- **Testes:** geração de tarefas, timezone, duplicidade, opt-out e prioridade.
- **Done:** fila confiável de hoje e histórico de ação.

## Phase 5 — Ingestão de landing page

- **Objetivo:** fechar o buraco entre triagem, clique e lead comercial.
- **Features:** endpoint/adaptador de captura autenticado, UTM/GCLID, deduplicação, consentimento e sinal comercial mínimo.
- **Schema:** atribuições, chaves de idempotência e registro de origem.
- **Dependências:** privacy review da landing page e contrato de payload.
- **Riscos:** replicar saúde no CRM, abuso de endpoint e duplicatas.
- **Testes:** assinatura, payload inválido, retry, duplicação e dados nulos.
- **Done:** uma captura real cria/atualiza lead e atribuição sem dado clínico.

## Phase 6 — Integração de WhatsApp

- **Objetivo:** registrar sinais e apoiar follow-up com consentimento.
- **Features:** adaptador do provedor, eventos de conversa/resposta, templates aprovados e opt-out.
- **Schema:** referências externas e log mínimo de entrega; não espelhar conversas clínicas completas.
- **Dependências:** fornecedor, contrato/DPA, consentimento e Phase 4.
- **Riscos:** LGPD, bloqueio de conta, conteúdo sensível e automação invasiva.
- **Done:** eventos confiáveis e reversíveis; envio somente após aprovação explícita.

## Phase 7 — Google Ads / GA4

- **Objetivo:** ligar custo e qualidade comercial por campanha.
- **Features:** importação de custo, reconciliação de UTM/GCLID, dashboard de qualidade e conversões downstream somente se legal/técnico.
- **Dependências:** captura consistente e política de atribuição aprovada.
- **Riscos:** discrepância de plataforma, consentimento/cookies e atribuição enganosa.
- **Done:** CPL, CAC e ROAS apresentam fonte, janela e qualidade dos dados.

## Phase 8 — Esteira de produtos

- **Objetivo:** preservar valor comercial de leads que não seguem para psicoterapia.
- **Features:** catálogo, interesse, oferta, compra e reativação segmentada; sem e-commerce inicialmente.
- **Dependências:** ofertas reais, comunicação e privacidade.
- **Done:** produto e psicoterapia coexistem sem corromper o funil principal.

## Phase 9 — Camada de inteligência

- **Objetivo:** gerar briefing explicável, não administrar agentes.
- **Features:** resumo semanal, anomalias, gargalos e sugestões priorizadas com links para evidências.
- **Dependências:** qualidade de eventos, métricas testadas e controles de acesso maduros.
- **Riscos:** recomendação opaca, vazamento via prompt e automação indevida.
- **Done:** toda afirmação aponta para dados, período e regra; humano mantém a decisão.

## Primeiro milestone implementável

**Phase 1a: hardening de acesso e fundação mínima de lead/oportunidade.** Antes de redesenhar pipeline, corrigir RLS/grants/storage, desligar anexos públicos e criar apenas os campos/tabelas necessários para `acquired_at`, atribuição, estágio, próxima ação e motivo de perda. Isso torna o primeiro dado real seguro e evita retrabalho em analytics.

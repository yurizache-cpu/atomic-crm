# Arquitetura de dados proposta

## Princípios

- O schema declarativo em `supabase/schemas/` deve continuar sendo a fonte de verdade; migrations são geradas a partir dele e revisadas. Hoje há uma exceção a reconciliar: a criação/configuração pública do bucket `attachments` aparece na migration inicial, mas não em `07_storage.sql`.
- PostgreSQL/Supabase é o sistema de registro para operação e analytics inicial.
- Dados comerciais estruturados são preferíveis a notas livres; notas continuam opcionais e curtas.
- Nenhuma tabela do CRM armazena prontuário ou resposta clínica de triagem.
- Toda escrita de integração é autenticada, validada, idempotente e rastreável.

## Reuso versus extensão

| Recurso atual | Uso proposto | Limite |
| --- | --- | --- |
| `contacts` | identidade e canais de contato | evitar `background` para dados de saúde; adicionar apenas campos comerciais justificados. |
| `deals` | candidato a projeção/UI da oportunidade | não usar `description`, `category` e `stage` como único histórico/fonte de analytics. |
| `tasks` | transição temporária ou base de UX de follow-up | não contém cadência, status de espera, resultado ou idempotência de canal. |
| `contact_notes` | registro comercial manual mínimo | não substitui evento; anexos não devem ser usados para informação clínica. |
| `tags` | segmentação flexível | não representam estágio, motivo ou métrica crítica. |
| `configuration` | preferências leves de UI | não guardar catálogo complexo nem políticas de segurança em JSONB. |
| summary/activity views | referência de padrão SQL | criar views analíticas específicas e com `security_invoker`. |

## Schema alvo da Fase 1–3

Não criar tudo de uma vez. A sequência recomendada é `lead_profiles`, `opportunities`, `loss_reasons`, `business_events` e `follow_ups`; depois `appointments`, ofertas e receita conforme a tela que os consome.

### `lead_profiles`

Chave primária e FK única para `contacts`. Campos sugeridos: `contact_id`, `acquired_at`, `source`, `medium`, `commercial_consent_at`, `commercial_consent_source`, `last_interaction_at`, `created_at`, `updated_at`. Atribuição detalhada fica fora para não alargar a tabela de contatos.

### `opportunities`

`id`, `contact_id`, `owner_sales_id`, `pipeline_key`, `stage_key`, `stage_entered_at`, `engagement_status`, `next_action_type`, `next_action_at`, `lost_reason_id`, `lost_note`, `opened_at`, `won_at`, `lost_at`, `created_at`, `updated_at`. Um índice parcial assegura uma oportunidade aberta por contato/pipeline quando essa regra for adotada.

### `acquisition_attributions`

`id`, `opportunity_id`, `is_primary`, dados de UTM/Ads, `landing_page`, `gclid`, `acquired_at`, `captured_at`, `source_system`, `raw_reference` e `created_at`. Campos nullable; índice em `(acquired_at)`, em campanha primária e, quando aplicável, GCLID único parcial. Não expor GCLID em listas comuns.

### `business_events`

`id` UUID, `opportunity_id`, `contact_id`, `event_type`, `occurred_at`, `recorded_at`, `source`, `actor_sales_id`, `idempotency_key`, `schema_version`, `payload` JSONB mínimo. Restringir o tipo por check/enum; índice `(opportunity_id, occurred_at)`, `(event_type, occurred_at)` e unicidade parcial `(source, idempotency_key)`.

O payload não recebe texto clínico. Exemplos seguros: ID externo, canal, valor monetário em centavos, código de motivo e identificador de agendamento. Mudanças de estágio manuais devem inserir evento e atualizar a projeção na mesma transação/RPC.

### `follow_ups`

`id`, `opportunity_id`, `owner_sales_id`, `channel`, `action_type`, `due_at`, `completed_at`, `outcome`, `created_at`, `updated_at`. Índice parcial em `(owner_sales_id, due_at)` para pendentes. A lista “atenção” consulta esta tabela e a oportunidade, em vez de deduzir tarefas de texto.

### `appointments`, `offers`, `offer_outcomes`, `revenue_events`

`appointments` guarda somente identificador externo opcional, datas comercialmente relevantes e resultado (`scheduled`, `paid`, `attended`, `no_show`, `cancelled`). `offers` é catálogo com tipo, ativo, moeda e preço de referência; não hardcode R$97 nem contratos. `offer_outcomes` liga oportunidade, oferta, decisão e valor. `revenue_events` registra fatos financeiros de contrato/recebimento/estorno sem integrar um meio de pagamento nesta etapa.

## Views e analytics

Criar views de leitura com `security_invoker = on` e grants mínimos, em vez de carregar todos os registros no browser.

1. `opportunity_current_summary`: oportunidade, identidade mínima, estágio, última interação, próxima ação, aging e atribuição primária.
2. `funnel_cohort_daily`: cohort por `date_trunc('day', acquired_at)`, fonte/campanha e contagens distintas por evento.
3. `campaign_quality_summary`: investimento importado posteriormente + leads, agendamentos, comparecimentos, pacientes e receita atribuída.
4. `attention_queue`: follow-ups vencidos/hoje, leads sem contato e leads em maturação, ordenados por regra explícita.

Começar por views normais e índices medidos. Materialized views só entram se `EXPLAIN ANALYZE` demonstrar necessidade e após definir refresh, permissões e tolerância de atraso. Para o volume inicial, uma RPC com agregação parametrizada por período pode ser mais simples que materialização.

## Cohort e atribuição

O cohort é definido por `lead_profiles.acquired_at`, não pelo mês de recebimento. Eventos e receita mantêm seus próprios timestamps. Assim, receita em setembro gerada por lead adquirido em agosto aparece no cohort de agosto e, separadamente, no caixa de setembro.

A primeira versão usa atribuição primária de último clique/captura, explicitamente rotulada. O modelo 1:N permite introduzir outras regras no futuro sem reescrever fatos históricos. Não substituir valores originais de UTM/Ads; registrar normalização e fonte de captura.

## Ingestão e boundaries

Landing page, agenda, WhatsApp, Ads e pagamentos entram por adaptadores de aplicação/Edge Function, nunca por acesso direto de fornecedor às tabelas internas. Cada adaptador valida assinatura/origem, traduz o payload para um comando de domínio, usa chave de idempotência e grava evento + projeção em transação. Expor apenas contratos de entrada mínimos, por exemplo `LeadCapture`, `ConversationSignal`, `AppointmentSignal` e `RevenueSignal`.

Esse boundary torna possível trocar fornecedor de WhatsApp, agenda ou mídia e facilita simulações de teste. Integrações futuras não recebem service-role key no frontend.

## Operação do schema

Para qualquer mudança: reconciliar primeiro a declaração do bucket com o schema declarativo; depois editar schema declarativo → iniciar Supabase local → gerar migration via `npx supabase db diff --local -f ...` → revisar → aplicar → verificar diff limpo → testar RLS e consultas → somente depois promover. Funções em `02_functions.sql` devem manter o formato do `pg_dump`, conforme `AGENTS.md`.

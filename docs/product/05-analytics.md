# Analytics do funil comercial

## Regras de medição

- Unidade de aquisição: oportunidade/lead com `acquired_at` conhecido; exibir “não atribuído” separadamente, nunca misturado a zero.
- Período de cohort: data de aquisição; período de caixa: data de `revenue_event.occurred_at`.
- Cada métrica informa denominador, filtro de estágio/evento, timezone (America/Sao_Paulo) e janela de maturação.
- Contar oportunidades distintas para conversão; não contar múltiplos eventos de resposta como múltiplos leads.
- Eventos posteriores podem ocorrer fora do período de aquisição e continuam pertencendo ao cohort original.

## Funil padrão

`lead_acquired → contact_started → lead_replied/conversation_active → initial_session_scheduled → initial_session_paid → initial_session_attended → continuity_offered → continuity_accepted → patient_activated`

No-show, cancelamento, recusa e perda são ramificações de resultado, não denominadores silenciosamente removidos. Mostrar também a população em maturação e a pendência de follow-up.

## Métricas

| Métrica | Definição/fórmula | Dados necessários | Armadilhas |
| --- | --- | --- | --- |
| Leads | oportunidades com `lead_acquired` no período/cohort | evento, `acquired_at` | deduplicar contato/captura; separar orgânico e não atribuído. |
| Investimento | custo de mídia no período da plataforma | tabela futura de custo por campanha/dia | não atribuir gasto do mês como se fosse receita do cohort sem rotulagem. |
| CPL | investimento / leads atribuídos | custo + lead | campanha sem custo conhecido deve ficar N/D. |
| Contato iniciado | leads com `contact_started` | evento | clique de WhatsApp não prova conversa. |
| Taxa de resposta | leads com `lead_replied` / leads com `contact_started` | eventos | definir o que conta como resposta humana e a janela. |
| Taxa de agendamento | oportunidades agendadas / leads ou conversas, conforme card | evento de agendamento | declarar o denominador; não alternar entre leads e respondidos. |
| Custo por agendamento | investimento / agendamentos | custo + evento | cohort de aquisição deve ser a visão principal. |
| Taxa de pagamento | sessões pagas / sessões agendadas | evento | pagamento pode ser tardio; congelar janela ou mostrar maturação. |
| Comparecimento | sessões atendidas / sessões pagas ou agendadas | eventos | publicar ambos se houver pagamento sem presença. |
| No-show | no-shows / sessões com resultado concluído | evento | não classificar agendamento futuro como no-show. |
| Continuidade | contratos de continuidade / sessões atendidas | oferta/eventos | oferta pode não existir para sessão recente; mostrar “ainda não ofertada”. |
| CAC paciente | investimento atribuído / pacientes ativados | custos + `patient_activated` | escolher modelo de atribuição e não misturar cohort com mês de caixa. |
| Receita contratada | soma de eventos de contrato aceitos | `revenue_events` | não é dinheiro recebido; pode cancelar/estornar. |
| Receita recebida | soma de recebimentos líquidos | `revenue_events` | excluir estornos ou mostrá-los separados. |
| ROAS | receita atribuída / investimento atribuído | custos + receita | informar janela e modelo de atribuição. |
| Tempo até agendamento | mediana de `scheduled_at - acquired_at` | eventos | média é sensível a cauda longa; mostrar mediana e p90. |
| Tempo até paciente | mediana de `patient_activated_at - acquired_at` | eventos | não excluir leads ainda maturando sem explicar censura. |
| Aging | dias desde estágio ou última interação | projeção + eventos | usar timezone e não persistir contador duplicado. |
| Cobertura de follow-up | oportunidades abertas com próxima ação futura / oportunidades elegíveis | follow-ups | não considerar “maturação intencional” como atraso. |
| Motivos de perda | distribuição por `loss_reason` | oportunidade/evento | destacar `unknown`; não interpretar causalidade como certeza. |

## Camadas de dashboard

1. **Health:** leads, investimento/CPL, pacientes, CAC, receita contratada/recebida e tendência versus período comparável.
2. **Funnel:** barras de coorte para cada evento, conversões entre etapas e tempo mediano. Seleção por período, fonte/campanha e cohort.
3. **Attention:** follow-ups vencidos/hoje, sem interação além da regra, maturação para revisão e no-shows/pendências de pagamento. Cada item abre a oportunidade com ação sugerida, não uma métrica decorativa.

Não exibir vinte cards. Dados insuficientes devem aparecer como “N/D” com explicação, não como zero.

## Implementação eficiente

As primeiras consultas devem ser views SQL ou RPCs parametrizadas com agregação no banco; não o `DealsChart` atual, que baixa deals e soma no navegador. Índices devem seguir os filtros reais: `occurred_at`, `acquired_at`, `event_type`, oportunidade, campanha primária e follow-ups pendentes. Medir com `EXPLAIN ANALYZE` e só então materializar.

Testes determinísticos devem cobrir: lead de agosto convertido em setembro; reativação; múltiplas respostas; no-show; pagamento posterior; custo ausente; receita contratada versus recebida; e campos de atribuição nulos.

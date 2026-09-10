# Visão de produto — Clinical Growth CRM

## Problema

Hoje a clínica conhece o clique final da triagem/WhatsApp como conversão de mídia, mas não enxerga de forma confiável o que acontece depois: mensagem real, resposta, agendamento, pagamento, comparecimento, continuidade e receita. Isso esconde gargalos e leva a decisões de aquisição orientadas a clique, não a pacientes adquiridos.

O Clinical Growth CRM transforma sinais dispersos de aquisição e relacionamento em uma visão comercial única. Ele não diagnostica, não trata e não armazena prontuário.

## Usuário e contexto

O usuário principal é um psicólogo clínico independente, com capacidade de agenda para crescer e necessidade de reduzir trabalho operacional. A comunicação é majoritariamente dirigida a homens, cujo ciclo de decisão pode ser lento, com silêncio, retomada e maturação. A ausência de resposta não deve ser inferida como perda.

## Resultado desejado

Em poucos minutos, ao abrir o CRM, o usuário deve conseguir responder:

1. Quantos leads chegaram e de quais campanhas?
2. Onde caem entre contato, agendamento, pagamento, comparecimento e continuidade?
3. Quem precisa de atenção hoje, sem pressionar quem ainda está maturando?
4. Qual cohort gera pacientes e receita, não somente cliques?
5. Quais motivos de perda merecem mudança na oferta, comunicação ou aquisição?

## Objetivos

- Unificar o pipeline comercial de lead até paciente ativo.
- Preservar aquisição/UTM/GCLID e separar data de aquisição de datas de conversão.
- Tornar follow-up, aging e reativação visíveis e acionáveis.
- Medir eficiência por etapa, campanha, período e cohort de aquisição.
- Reduzir a carga cognitiva por meio de uma tela matinal: **Health → Funnel → Attention**.
- Criar dados confiáveis para automações, integrações e IA futuras.

## Não objetivos nesta fase

- prontuário, anamnese, diagnóstico, evolução terapêutica ou documentos clínicos;
- automação agressiva de mensagens;
- integração direta com WhatsApp, Google Ads/GA4, pagamentos ou agenda;
- e-commerce, cobrança ou esteira de produtos implementada;
- agentes autônomos, previsão opaca ou arquitetura distribuída;
- reescrita visual geral do Atomic CRM.

## Princípios de produto

1. **Comercial, não clínico.** Registrar somente o mínimo para aquisição e relacionamento comercial.
2. **Silêncio não é perda.** Estágio é progresso comercial; maturação, aguardando resposta e follow-up são estados operacionais paralelos.
3. **Evento antes de palpite.** Datas e eventos registrados são superiores a inferências de UI para análise futura.
4. **Uma ação clara.** Priorizar a próxima ação e sua data em vez de pedir que o usuário procure em várias telas.
5. **Configuração, não hardcode.** Ofertas, preços de referência, estágios, motivos de perda e cadências devem ser administráveis.
6. **Cohort, não apenas caixa do mês.** Receita é atribuída também à data de aquisição do lead.
7. **Privacidade por padrão.** Dados sensíveis não entram no CRM; acesso e armazenamento seguem menor privilégio.
8. **Postgres primeiro.** Views, funções, índices e jobs simples resolvem o volume inicial antes de qualquer serviço adicional.

## Métricas norteadoras

- leads adquiridos e CPL;
- contatos reais e taxa de primeira resposta;
- agendamentos, pagamentos e comparecimentos da sessão inicial;
- no-show, continuidade ofertada/contratada e pacientes ativos;
- CAC por paciente, receita contratada, receita recebida e ROAS;
- tempo até primeira resposta, agendamento e ativação;
- leads em maturação, atrasados e sem interação recente;
- qualidade por campanha e cohort de aquisição.

Definições, fórmulas e armadilhas estão em [05-analytics.md](05-analytics.md).

## MVP recomendado

O primeiro produto utilizável não é uma integração nem um dashboard completo. É:

1. acesso seguro de operador único;
2. lead comercial com atribuição e consentimento mínimo;
3. pipeline configurável com uma oportunidade por lead;
4. próximos passos/follow-ups e motivos de perda configuráveis;
5. eventos e timestamps determinísticos;
6. lista de atenção de hoje;
7. funil básico por cohort de aquisição.

## Evolução

Após dados confiáveis, a evolução pode incluir ingestão de landing page, agenda, WhatsApp, mídia, esteira de produtos e uma camada de inteligência que produz resumo semanal e alertas explicáveis. IA só entra como consumo de dados governados, nunca como uma segunda interface para administrar.

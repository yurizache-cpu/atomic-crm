# Segurança e privacidade

## Escopo e premissa

Este é um CRM comercial de clínica de psicologia no Brasil, não um prontuário. Nome, telefone, e-mail, identificadores de campanha, mensagens e informações sobre interesse podem ser dados pessoais. Respostas de triagem, sintomas, intensidade de sofrimento, diagnósticos, documentos e conteúdo terapêutico podem constituir dados pessoais sensíveis de saúde. O fato de o sistema não ter sido chamado de prontuário não reduz a obrigação de proteção.

Esta análise aponta controles técnicos e operacionais; não substitui avaliação jurídica, DPO/encarregado, DPIA/RIPD e definição da base legal aplicável.

## Classificação e minimização

| Classe | Pode entrar no CRM comercial? | Exemplos |
| --- | --- | --- |
| Identificação/contato | Sim, se necessário | nome, telefone/WhatsApp, e-mail, data de entrada. |
| Comercial | Sim, se necessário | estágio, origem, campanha, follow-up, oferta, motivo de perda, valor contratado. |
| Telemetria de aquisição | Sim, minimizada | UTM, GCLID, landing page, timestamps, IDs de campanha/anúncio. |
| Saúde/clínico | Não | respostas abertas de triagem, sintomas, intensidade, anamnese, hipótese, sessão, diagnóstico. |
| Anexos e comunicações completas | Não por padrão | e-mails, PDFs, screenshots, áudio e exports que possam trazer conteúdo clínico. |

Separar a landing page/triagem clínica de CRM: o CRM recebe um sinal comercial de elegibilidade/intenção e dados de contato estritamente necessários. O sistema de triagem, se houver dado de saúde, precisa de armazenamento separado, acesso clínico exclusivo, retenção própria e fluxo de referência que não replique conteúdo sensível.

## MUST FIX BEFORE PRODUCTION

1. **Substituir RLS permissivo.** As políticas atuais usam `using (true)` para todos autenticados. Definir papéis e escopo no banco: por exemplo, clínica/tenant, administrador, operador e integração; `select/update/delete` devem verificar associação e dono quando apropriado. Cobrir tabelas, views, RPCs, storage e eventos.
2. **Revogar grants excessivos.** Remover `ALL` e privilégios-padrão para `anon`; conceder somente operações necessárias. `anon` deve, no máximo, ler um endpoint/bootstrap mínimo e nunca registros comerciais. Revisar grants de funções individualmente.
3. **Tornar anexos privados ou desabilitá-los.** O bucket `attachments` atual é público e as URLs são públicas. Sua configuração de bucket está somente na migration inicial, enquanto `07_storage.sql` contém apenas policies; reconciliar essa divergência com o schema declarativo. Desabilitar anexos na Fase 1 ou migrar para bucket privado com prefixo por tenant/registro, políticas de owner/role, URLs assinadas de curta duração, allowlist de MIME/tamanho e antivírus/validação quando aplicável.
4. **Bloquear dado clínico na UX e ingestão.** Remover/renomear campos genéricos que convidam a narrativa clínica (`background`, notas e upload) da experiência comercial; incluir instrução visível e validação de payload da landing page.
5. **Fechar onboarding e contas.** Em produção, desabilitar signup aberto após o primeiro administrador ou adotar convite administrativo com domínio/allowlist apropriado. Validar RLS também na criação de perfil e em SSO.
6. **Segredos e ambiente.** Confirmar que não existe segredo de produção em arquivos rastreados; configurar secret scanning, rotação, secrets somente em Supabase/CI, acesso mínimo e procedimento de incidente. Os arquivos locais rastreados devem conter apenas valores de desenvolvimento/E2E descartáveis.
7. **Backups, recuperação e incidentes.** Definir RPO/RTO, responsável, periodicidade, teste de restore, inventário de acessos e procedimento de vazamento antes de operar com dados reais.
8. **Teste de segurança.** Criar testes de RLS positivos/negativos, storage, Edge Functions, exportação e acesso entre papéis antes de liberar produção.

## SHOULD FIX

- restringir CORS de Edge Functions a origens da clínica quando possível; manter validação de token mesmo com `verify_jwt = false` e testar caminhos de erro;
- registrar auditoria imutável de leitura/alteração/exportação de registros comerciais sem colocar conteúdo sensível nos logs;
- aplicar rate limit e proteção anti-abuso a captura pública e autenticação;
- mascarar contato e identificadores de anúncio em logs/erros; nunca logar JWT, payload inteiro de webhook ou URLs de anexos;
- criar política de retenção por categoria, rotina de exclusão/anonimização e exportação do titular; apagar também objetos de storage e derivados analíticos;
- documentar base legal, aviso de privacidade, consentimento de comunicação quando necessário e registro de origem;
- revisar MCP antes de habilitar: limitar ferramentas, escopo, aprovação para escrita, logs e revogação de tokens;
- desligar telemetria upstream por precaução institucional, embora o código declare enviar apenas domínio. A prop `disableTelemetry` precisa ser usada e a telemetria do admin-kit também deve ser revisada.

## LATER

- DLP/classificação assistida para impedir texto clínico em campos comerciais;
- criptografia de campo para identificadores que realmente a justifiquem, com gestão de chaves e busca compatível;
- integração SIEM e alertas de comportamento anômalo;
- política de legal hold e automação de expurgo;
- revisão independente/pentest antes de ampliar o acesso a equipe ou integrações.

## Acesso, logs e funções

O frontend pode ocultar menus, mas a política no Postgres é a autoridade. Edge Functions devem executar como service role apenas para operação específica, validar identidade/role antes da ação e não oferecer SQL genérico a usuários sem limites. O webhook de e-mail merece revisão adicional: comunicações recebidas podem carregar conteúdo de saúde e anexos; ele não deve ser habilitado por padrão.

`business_events` deve registrar metadados de operação — tipo, quem, quando, origem e IDs — e não o corpo de mensagens. Logs técnicos devem ter redaction e retenção curta. Exports precisam de autorização explícita, escopo pequeno, registro de auditoria e expiração.

## Checklist de produção

- [ ] RIPD/DPIA e base legal revisados com responsável jurídico/privacidade.
- [ ] RLS/grants/storage revisados em ambiente de staging por testes automatizados.
- [ ] Sign-up público, anexos públicos, inbound e MCP desabilitados ou protegidos conforme decisão.
- [ ] Secrets, SMTP, backups e restore testados; nenhum segredo real em Git.
- [ ] Aviso de privacidade, canal de direitos do titular, retenção e exclusão operacionalizados.
- [ ] Monitoramento, logs redigidos e plano de incidente aprovados.

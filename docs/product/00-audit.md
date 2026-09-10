# Auditoria técnica — Fase 0

Data da auditoria: 2026-09-10. Este documento descreve o estado do checkout em `a863e2a084fae8c7adf7a2efc547ad7ce38e699b`, antes de qualquer mudança funcional do fork.

## Veredito

**Recomendação: B — extensão mínima e deliberada do Atomic CRM.**

O Atomic CRM é uma base adequada para o CRM comercial da clínica: já entrega autenticação, contatos, tarefas, notas, kanban, importação, APIs REST e uma estrutura de Supabase que pode crescer sem microserviços. Não é adequado como prontuário e não deve receber informação clínica. A extensão deve criar um domínio comercial explícito, uma camada de analytics no PostgreSQL e uma postura de segurança mais restritiva antes de dados reais.

Não recomendo reconstrução: ela descartaria recursos úteis e testados sem resolver o risco principal, que é a modelagem e o acesso aos dados. Também não basta somente configurar estágios: atribuição, cohort, eventos e follow-up exigem schema e queries próprios.

## Arquitetura observada

| Camada | Estado atual |
| --- | --- |
| Frontend | SPA React 19, TypeScript, Vite 7, React Router 7, React Query, React Hook Form, `ra-core`, Tailwind 4, Radix/shadcn. |
| Domínio de UI | `src/components/atomic-crm/`: contacts, companies, deals, tasks, notes, tags, activity, dashboard, settings, sales e login. |
| Backend | Supabase: PostgreSQL, PostgREST, Auth, Storage e Edge Functions Deno. |
| Dados | `ra-supabase-core` com views `contacts_summary`, `companies_summary`, `activity_log` e `init_state`. FakeRest emula parte disso para demo. |
| Configuração | Defaults no `<CRM>` e configuração administrativa persistida no singleton `configuration.config` (JSONB). |
| Testes | Vitest para UI e Edge Functions; Playwright para fluxos desktop e mobile. CI executa lint, typecheck, build e E2E. |
| Entrega | GitHub Actions em `main`; build estático e implantação Supabase condicionada a secrets. |

O diretório `src/components/admin` é uma dependência mutável do shadcn-admin-kit e `src/components/ui` contém shadcn/ui. O código de domínio deve ficar fora desses diretórios; alterá-los amplia o custo de atualizar o fork.

## Modelo de dados atual

As tabelas de negócio são `contacts`, `companies`, `deals`, `tasks`, `contact_notes`, `deal_notes`, `tags`, `sales`, `configuration` e `favicons_excluded_domains`.

- `contacts` já contém identidade, e-mail/telefone em JSONB, tags, `first_seen`, `last_seen`, status e responsável.
- `deals` já possui nome, contatos em array, estágio configurável, categoria, valor, proprietário, datas de criação/atualização, previsão e arquivamento. É o melhor ponto de partida para uma oportunidade comercial, mas não é suficiente para o ciclo da clínica sem campos/tabelas complementares.
- `tasks` já modela uma ação com vencimento e conclusão ligada a um contato; atende o primeiro nível de follow-up.
- notas e anexos suportam histórico livre, mas texto e anexos não são um local seguro para informações de saúde.
- `sales` é o perfil local vinculado a `auth.users`; o primeiro usuário se torna administrador por trigger.

Há foreign keys convencionais para empresas, contatos, notas, tarefas e responsáveis. Relações de contatos em deals e tags em contacts são arrays, uma decisão aceitável para o CRM genérico, mas que não deve ser repetida para fatos analíticos.

As views reduzem round-trips para listas e a `activity_log` agrega apenas criação de empresas, contatos, deals e notas. Ela **não** é um log de transições de funil, nem é append-only. O dashboard atual agrega contagens, tarefas, contatos quentes, feed e um gráfico de deals em seis meses no cliente; não mede aquisição, cohort ou CAC.

## Autenticação, autorização e API

Supabase Auth provê login, signup, SSO/OAuth e recuperação. Um trigger replica atributos para `sales`; o frontend usa o flag `administrator` para esconder recursos de usuários comuns. As Edge Functions `users`, `update_password`, `merge_contacts` e `delete_note_attachments` usam middleware próprio para autenticar; `postmark` é webhook; `mcp` oferece leitura/escrita por OAuth e SQL validado.

O PostgREST expõe as tabelas e views `public`; o provider mapeia `contacts` e `companies` para suas views-summary. O cliente recebe somente URL e publishable key do Supabase, como esperado.

### Risco crítico: RLS não aplica menor privilégio

Embora todas as tabelas tenham RLS habilitado, as políticas permitem `select`, `insert`, `update` e `delete` para qualquer usuário autenticado com `using (true)`/`with check (true)`. Além disso, `06_grants.sql` concede `ALL` em tabelas, views, sequences e privilégios padrão ao papel `anon`. RLS evita o uso direto para `anon` na maior parte das tabelas, mas os grants são excessivos e tornam o modelo difícil de auditar.

Em uma clínica de um usuário esse risco pode parecer pequeno, mas torna qualquer conta autenticada uma conta com acesso amplo a todos os leads e notas. A autorização visual do frontend não é uma fronteira de segurança.

### Risco crítico: anexos publicamente acessíveis

A migration inicial cria `storage.buckets('attachments')` com `public = true`; o provider chama `getPublicUrl`, e as políticas de storage se limitam ao bucket, sem prefixo, proprietário ou escopo de registro. Links de anexos podem ser acessados sem autenticação. Além disso, `supabase/schemas/07_storage.sql` declara apenas as policies e não a configuração do bucket: o estado `public` está somente na migration histórica, uma lacuna no princípio declarado de schema como fonte de verdade. Não habilitar nem transportar anexos contendo conteúdo de triagem, conversa, documento de saúde ou pagamento antes de substituir e reconciliar esse desenho.

### Outros achados

- `verify_jwt = false` em funções é aceitável apenas porque as funções sensíveis implementam middleware próprio; isso exige testes de autorização e revisão cuidadosa para cada função nova.
- CORS das funções permite qualquer origem. Com bearer token é menos grave que uma função pública, mas em produção deve ser reduzido às origens autorizadas quando não houver necessidade de integração pública.
- arquivos de ambiente de desenvolvimento/E2E, a chave de assinatura local e `supabase/functions/.env` são rastreados. Eles podem ser apropriados para local/E2E, mas nenhum segredo de produção pode compartilhar esse padrão. Aplicar secret scanning, rotação documentada e variáveis somente no provedor de deploy.
- o bucket e as notas tornam fácil introduzir dado clínico por engano. É necessária uma regra de produto, UX e treinamento; uma política SQL não classifica texto livre.
- `init_state` precisa continuar expondo somente a informação mínima necessária antes do login; ele não deve abrir nenhuma outra view pública.
- há backup/restore, retenção, exportação e trilha de auditoria incompletos para uma operação clínica. Supabase oferece mecanismos de plataforma, mas a política operacional não está versionada neste projeto.

## Módulos: KEEP / ADAPT / REMOVE / DEFER

| Módulo | Decisão | Justificativa |
| --- | --- | --- |
| Contacts | **ADAPT** | Reusar identidade e comunicação; exibir só dados comerciais e acrescentar lead/acquisition de forma normalizada. |
| Deals / Kanban | **ADAPT** | Reusar UI de pipeline inicialmente, mas separar estágio canônico de status operacional e registrar transições. |
| Tasks | **KEEP + ADAPT** | Base do follow-up manual; acrescentar contexto, próxima ação e priorização. |
| Notes / Activity | **ADAPT** | Manter notas comerciais curtas; proibir dados clínicos e separar eventos estruturados de texto livre. |
| Tags | **KEEP** | Úteis para segmentação simples, sem transformá-las em fatos críticos. |
| Dashboard | **REPLACE GRADUALMENTE** | O atual é genérico e calcula parte da análise no cliente; substituí-lo por Health → Funnel → Attention. |
| Companies | **DEFER / ocultar da navegação** | Pouco valor para clínica individual. Não apagar: deals e importação dependem dele. Avaliar remoção somente após migração explícita. |
| Sales | **KEEP** | Serve a responsável e perfis de acesso; simplificar para proprietário único enquanto necessário. |
| Import/export | **ADAPT** | Necessário para legado, com mapeamento, deduplicação, consentimento e bloqueio de conteúdo clínico. |
| Inbound email/Postmark | **DEFER** | Possível captura futura, mas aumenta exposição de comunicações sensíveis. |
| MCP | **DEFER / desabilitar em produção inicialmente** | Dá acesso por linguagem natural e escrita; só habilitar com escopo, aprovação e auditoria maduros. |
| WhatsApp, Ads, pagamentos, IA, e-commerce | **DEFER** | Não há integração segura nem requisito de Fase 0 para implementá-los. |

## Qualidade, testes e CI

O recorte da aplicação contém 29 arquivos de teste unitário (componentes/modelos e Edge Functions) e quatro specs E2E Playwright. Há ainda 33 testes `.mjs` do harness em `.claude`, totalizando 66 arquivos de teste identificados no repositório. A configuração separa projetos Vitest para app/browser, hooks do harness e funções. A CI em GitHub Actions executa lint, typecheck, build, testes unitários e E2E em Chromium desktop/mobile.

Há cobertura útil de formulários, filtros, importação e parser de e-mail, mas não há testes para o futuro modelo de funil, cohort, cálculo de receita, RLS por papel/tenant, privacidade, retenção ou idempotência de ingestão. Essas lacunas devem ser fechadas por fase, não ao fim do projeto.

## Validação do ambiente desta auditoria

| Procedimento | Resultado | Evidência / bloqueio |
| --- | --- | --- |
| Clone | OK | `origin` aponta para `https://github.com/yurizache-cpu/atomic-crm.git`; checkout limpo no commit auditado. |
| Node/npm | OK | Node `v22.23.1`, npm `10.9.8`; compatível com o requisito de Node 22. |
| `npm install` / `npm ci` | BLOQUEADO | Uma tentativa com `npm install` e duas com `npm ci` não terminaram com sucesso observável após warnings de depreciação; deixaram diretórios vazios em `node_modules` e nenhum `node_modules/.bin/tsc`. `make install` não foi invocado diretamente, pois apenas encapsula `npm install`. |
| `make typecheck` | NÃO EXECUTÁVEL | `tsc` não foi instalado pela instalação incompleta. |
| `make lint` | NÃO EXECUTÁVEL | `eslint` e `prettier` não foram instalados pela instalação incompleta. |
| `make test` | NÃO EXECUTÁVEL | `vitest` não foi instalado pela instalação incompleta. |
| `make build` | NÃO EXECUTÁVEL | depende de TypeScript/Vite locais. |
| Supabase local / E2E | BLOQUEADO | Docker não está instalado/disponível (`docker` não reconhecido); E2E também precisa das dependências e browsers Playwright. |

Não houve alteração de schema ou funcionalidade nesta fase. Antes do próximo milestone, repetir a instalação em um ambiente com npm concluindo normalmente, Docker Desktop e Chromium Playwright; então executar `make typecheck`, `make lint`, `make test`, `make build` e `make test-e2e-ci`.

## Riscos de fork e atualização

O projeto foi baixado apenas com `origin`; não há remote `upstream` configurado. A documentação upstream recomenda atualizações via registry shadcn que podem sobrescrever arquivos. Alterar indiscriminadamente `src/components/admin`, `src/components/ui` ou os módulos genéricos do CRM elevará muito o custo de sincronização.

O detalhe operacional está em [07-upstream-strategy.md](07-upstream-strategy.md). Em resumo: configurar o remote canônico, isolar código clínico em módulos novos, manter cada mudança de upstream pequena e revisável, e nunca atualizar registry em uma árvore com trabalho pendente.

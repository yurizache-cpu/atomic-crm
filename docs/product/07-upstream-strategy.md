# Estratégia de relacionamento com Atomic CRM upstream

## Objetivo

Receber correções e melhorias do Atomic CRM sem transformar o fork em uma árvore impossível de atualizar. O fork deve divergir em domínio clínico-comercial e segurança, não em infraestrutura genérica por acidente.

## Estado atual

O checkout possui apenas `origin` apontando para o fork `yurizache-cpu/atomic-crm`. O commit auditado é um merge upstream recente, mas não há remote canônico configurado localmente.

## Convenção proposta

```sh
git remote add upstream https://github.com/marmelab/atomic-crm.git
git fetch upstream --tags
```

- `main`: ramo integrado e sempre validável do fork.
- `feature/clinical-*`: uma mudança pequena por tema; não misturar atualização upstream e feature clínica.
- `chore/upstream-*`: atualizações pontuais, com changelog e diff revisado.
- tags internas: marcar releases que já passaram validação de RLS e migrations.

Não executar estes comandos nesta Fase 0: eles são a política recomendada para a primeira preparação controlada do repositório.

## Fronteiras de customização

1. Criar módulos novos em `src/components/clinical-growth/` (ou pasta equivalente decidida no primeiro PR) para pipeline, analytics e follow-up.
2. Usar composição no `<CRM>`, rotas/resources explícitos e componentes de domínio antes de editar `src/components/atomic-crm`.
3. Alterar `atomic-crm` somente quando a mudança é uma adaptação pequena de entidade já existente, documentando a razão no PR.
4. Evitar mudanças em `src/components/admin` e `src/components/ui`; são dependências mutáveis, mas também são as que o registry pode sobrescrever.
5. Isolar todo schema específico da clínica em seções/tabelas claramente nomeadas e manter RLS em arquivos declarativos existentes.

## Atualizações

O upstream publica componentes pelo registry shadcn. Antes de usar `npx shadcn add https://marmelab.com/atomic-crm/r/atomic-crm.json -o -y`:

1. trabalhar em checkout limpo e com commit de segurança/feature já fechado;
2. criar branch `chore/upstream-YYYY-MM-DD`;
3. ler release/changelog e comparar `upstream/main`;
4. executar atualização apenas para o conjunto de componentes desejado;
5. revisar diff, reaplicar mudanças locais deliberadamente e executar validação completa;
6. registrar versão/revisão upstream incorporada em PR ou changelog interno.

O registry pode sobrescrever arquivos; não é um mecanismo de merge semântico. Para migrations, nunca rodar atualização sem revisar a compatibilidade com o schema declarativo e o banco de staging.

## Cadência e critérios

- revisão mensal de releases/correções; revisão extraordinária para vulnerabilidade ou correção de Supabase/Auth;
- atualizar primeiro em branch/staging, com backup e plano de rollback para migrations;
- cherry-pick é preferível para um bug isolado; merge/rebase de upstream só após avaliar o diff completo;
- não editar migrations históricas para acomodar upstream; conciliar source-of-truth, gerar migration nova e revisar;
- dependências npm permanecem travadas por `package-lock.json`; atualizações devem ter propósito e CI verde.

## Evidências de sucesso

Cada atualização upstream deve documentar: SHA/tag de origem, arquivos afetados, impactos em customizações clínicas, schema/migrations, resultado de typecheck/lint/test/build/E2E/RLS e plano de rollback. Essa disciplina é mais valiosa que tentar manter o fork idêntico ao upstream.

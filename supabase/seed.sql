-- Local development and CI data only: a hosted project never runs this file
-- (SI-25). Global reference data a production database needs lives in
-- versioned migrations instead, favicons_excluded_domains among them since
-- 20260913120000.

-- Loss reasons are tenant vocabulary (CLAUDE.md rule 2, ADR 0013). These labels
-- serve local development; a production tenant gets its own through an explicit
-- onboarding path, never through a migration.
insert into loss_reasons (code, label, sort_order) values
    ('financial_constraint', 'Restrição financeira', 10),
    ('price', 'Preço', 20),
    ('not_ready', 'Ainda não está pronto(a)', 30),
    ('no_response', 'Sem resposta', 40),
    ('chose_other_professional', 'Escolheu outro profissional', 50),
    ('no_fit', 'Sem adequação', 60),
    ('postponed', 'Adiado', 70),
    ('other', 'Outro', 80),
    ('unknown', 'Não informado', 90)
on conflict (code) do update
set label = excluded.label,
    sort_order = excluded.sort_order;


-- Company OS development bootstrap (Phase 1C).
--
-- A development tenant and one company to look at. The names below are tenant
-- vocabulary: they live here, in seed data, and never in a migration (CLAUDE.md
-- rule 2, ADR 0013). They are built through the domain functions, so every row
-- carries its lifecycle event -- and a defect in those functions breaks
-- `supabase start` loudly instead of seeding rows that skipped their checks.
--
-- Local only: a hosted project never runs this file. The tenant deliberately
-- does NOT own the local CRM (ops.tenants.owns_local_crm stays false).
do $$
declare
  v_tenant    uuid;
  v_company   uuid;
  v_reception uuid;
  v_marketing uuid;
begin
  insert into ops.tenants (slug, name)
  values ('dev', 'Development tenant')
  on conflict (slug) do nothing;
  select id into v_tenant from ops.tenants where slug = 'dev';

  v_company   := ops.create_company(v_tenant, 'psychology-clinic', 'Psychology Clinic', 'seed');
  v_reception := ops.create_department(v_tenant, v_company, 'reception', 'Reception', 'seed');
  v_marketing := ops.create_department(v_tenant, v_company, 'marketing', 'Marketing', 'seed');
  perform ops.create_department(v_tenant, v_company, 'operations', 'Operations', 'seed');

  perform ops.create_agent(v_tenant, v_company, v_reception, 'reception-agent',
                           'Reception Agent', 'Receptionist', 'seed');
  perform ops.create_agent(v_tenant, v_company, v_marketing, 'marketing-analyst',
                           'Marketing Analyst', 'Marketing analyst', 'seed');
end
$$;

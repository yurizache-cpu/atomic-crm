INSERT INTO favicons_excluded_domains (domain) VALUES
    ('gmail.com'),
    ('yahoo.com'),
    ('hotmail.com'),
    ('aol.com'),
    ('hotmail.co.uk'),
    ('hotmail.fr'),
    ('msn.com'),
    ('yahoo.fr'),
    ('wanadoo.fr'),
    ('orange.fr'),
    ('comcast.net'),
    ('yahoo.co.uk'),
    ('yahoo.com.br'),
    ('yahoo.co.in'),
    ('live.com'),
    ('rediffmail.com'),
    ('free.fr'),
    ('gmx.de'),
    ('web.de'),
    ('yandex.ru'),
    ('ymail.com'),
    ('libero.it'),
    ('outlook.com'),
    ('uol.com.br'),
    ('bol.com.br'),
    ('mail.ru'),
    ('cox.net'),
    ('hotmail.it'),
    ('sbcglobal.net'),
    ('sfr.fr'),
    ('live.fr'),
    ('verizon.net'),
    ('live.co.uk'),
    ('googlemail.com'),
    ('yahoo.es'),
    ('ig.com.br'),
    ('live.nl'),
    ('bigpond.com'),
    ('terra.com.br'),
    ('yahoo.it'),
    ('neuf.fr'),
    ('yahoo.de'),
    ('alice.it'),
    ('rocketmail.com'),
    ('att.net'),
    ('laposte.net'),
    ('facebook.com'),
    ('bellsouth.net'),
    ('yahoo.in'),
    ('hotmail.es'),
    ('charter.net'),
    ('yahoo.ca'),
    ('yahoo.com.au'),
    ('rambler.ru'),
    ('hotmail.de'),
    ('tiscali.it'),
    ('shaw.ca'),
    ('yahoo.co.jp'),
    ('sky.com'),
    ('earthlink.net'),
    ('optonline.net'),
    ('freenet.de'),
    ('t-online.de'),
    ('aliceadsl.fr'),
    ('virgilio.it'),
    ('home.nl'),
    ('qq.com'),
    ('telenet.be'),
    ('me.com'),
    ('yahoo.com.ar'),
    ('tiscali.co.uk'),
    ('yahoo.com.mx'),
    ('voila.fr'),
    ('gmx.net'),
    ('mail.com'),
    ('planet.nl'),
    ('tin.it'),
    ('live.it'),
    ('ntlworld.com'),
    ('arcor.de'),
    ('yahoo.co.id'),
    ('frontiernet.net'),
    ('hetnet.nl'),
    ('live.com.au'),
    ('yahoo.com.sg'),
    ('zonnet.nl'),
    ('club-internet.fr'),
    ('juno.com'),
    ('optusnet.com.au'),
    ('blueyonder.co.uk'),
    ('bluewin.ch'),
    ('skynet.be'),
    ('sympatico.ca'),
    ('windstream.net'),
    ('mac.com'),
    ('centurytel.net'),
    ('chello.nl'),
    ('live.ca'),
    ('aim.com'),
    ('bigpond.net.au'),
    ('online.de'),
    ('apple.com');

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

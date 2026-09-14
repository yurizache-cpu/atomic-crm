-- Global reference data: free-mail and ISP domains whose favicon never stands
-- for a company, so no company logo is fetched for them. The list is upstream
-- Atomic CRM's, identical to DOMAINS_NOT_SUPPORTING_FAVICON in
-- src/components/atomic-crm/misc/unsupportedDomains.const.ts, and carries no
-- tenant vocabulary.
--
-- Until 2026-09-13 only the local development data inserted these rows, so a
-- hosted project, which never receives that data (SI-25), had none. Owner
-- decision 2026-09-13: global reference data a production database needs ships
-- in a versioned migration; tenant vocabulary, such as loss reasons, does not,
-- and waits for an explicit onboarding path.
--
-- Additive and idempotent: a domain already present is left alone and nothing
-- is updated or deleted, so rows an administrator added survive. The column has
-- no unique constraint, hence NOT EXISTS rather than ON CONFLICT. The block
-- raises if any listed domain is still missing afterwards.
do $$
declare
  v_domains constant text[] := array[
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'aol.com',
    'hotmail.co.uk',
    'hotmail.fr',
    'msn.com',
    'yahoo.fr',
    'wanadoo.fr',
    'orange.fr',
    'comcast.net',
    'yahoo.co.uk',
    'yahoo.com.br',
    'yahoo.co.in',
    'live.com',
    'rediffmail.com',
    'free.fr',
    'gmx.de',
    'web.de',
    'yandex.ru',
    'ymail.com',
    'libero.it',
    'outlook.com',
    'uol.com.br',
    'bol.com.br',
    'mail.ru',
    'cox.net',
    'hotmail.it',
    'sbcglobal.net',
    'sfr.fr',
    'live.fr',
    'verizon.net',
    'live.co.uk',
    'googlemail.com',
    'yahoo.es',
    'ig.com.br',
    'live.nl',
    'bigpond.com',
    'terra.com.br',
    'yahoo.it',
    'neuf.fr',
    'yahoo.de',
    'alice.it',
    'rocketmail.com',
    'att.net',
    'laposte.net',
    'facebook.com',
    'bellsouth.net',
    'yahoo.in',
    'hotmail.es',
    'charter.net',
    'yahoo.ca',
    'yahoo.com.au',
    'rambler.ru',
    'hotmail.de',
    'tiscali.it',
    'shaw.ca',
    'yahoo.co.jp',
    'sky.com',
    'earthlink.net',
    'optonline.net',
    'freenet.de',
    't-online.de',
    'aliceadsl.fr',
    'virgilio.it',
    'home.nl',
    'qq.com',
    'telenet.be',
    'me.com',
    'yahoo.com.ar',
    'tiscali.co.uk',
    'yahoo.com.mx',
    'voila.fr',
    'gmx.net',
    'mail.com',
    'planet.nl',
    'tin.it',
    'live.it',
    'ntlworld.com',
    'arcor.de',
    'yahoo.co.id',
    'frontiernet.net',
    'hetnet.nl',
    'live.com.au',
    'yahoo.com.sg',
    'zonnet.nl',
    'club-internet.fr',
    'juno.com',
    'optusnet.com.au',
    'blueyonder.co.uk',
    'bluewin.ch',
    'skynet.be',
    'sympatico.ca',
    'windstream.net',
    'mac.com',
    'centurytel.net',
    'chello.nl',
    'live.ca',
    'aim.com',
    'bigpond.net.au',
    'online.de',
    'apple.com'
  ];
  v_missing integer;
begin
  insert into public.favicons_excluded_domains (domain)
  select listed.domain
  from unnest(v_domains) as listed(domain)
  where not exists (
    select 1
    from public.favicons_excluded_domains existing
    where existing.domain = listed.domain
  );

  select count(*) into v_missing
  from unnest(v_domains) as listed(domain)
  where not exists (
    select 1
    from public.favicons_excluded_domains existing
    where existing.domain = listed.domain
  );
  if v_missing <> 0 then
    raise exception 'favicons_excluded_domains is missing % of % reference domains',
      v_missing, cardinality(v_domains);
  end if;
end
$$;

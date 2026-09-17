-- The person's act the halted upgrade asks for (docs/PERMISSIONS.md,
-- "Owner bootstrap"), exactly as the runbook spells it, for the upgrade replay
-- (scripts/run-db-upgrade-test.mjs). The person chose the instance's
-- first-signup administrator. The id is the auth user id, as the dashboard
-- shows it.

\set ON_ERROR_STOP on

select public.bootstrap_owner(
  '10000000-0000-0000-0000-000000000001',
  'upgrade replay operator',
  'the first-signup administrator of the legacy instance'
);

-- Legacy deals keep their stage across the upgrade (Phase 1D.2, finding 1).
--
-- 20260911232039_pending_delta.sql added deals.pipeline_stage as
-- `text not null default 'new_lead'`. Adding a column with a default fills that
-- value into every EXISTING row, so every deal an upstream instance already had
-- moved to 'new_lead', whatever its stage. The same migration installed
-- synchronize_deal_pipeline(), which copies pipeline_stage over stage on every
-- write. So the first ordinary edit of such a deal, a rename, also overwrote its
-- legacy stage, and that stage was lost (measured, docs/PHASE_1D2_REPORT.md).
--
-- The repository's intended mapping is the trigger's own insert rule:
-- pipeline_stage := coalesce(nullif(stage, ''), 'new_lead'). Stages are tenant
-- vocabulary (ADR 0013), so a legacy value is carried over unchanged, never
-- translated. The tenant's own Settings (public.configuration) still list the
-- legacy stages, so the board shows each deal in the column it had before.
--
-- Which rows: since pending_delta, the trigger keeps stage = pipeline_stage on
-- every write. A row whose two columns DIFFER has therefore not been written
-- since the upgrade, and its stage is still the legacy value. Rows written since
-- are equal and are not touched. The backfill is exact, and running it again
-- changes nothing.
--
-- The trigger is off for this one statement, so the correction does not look
-- like a user edit: updated_at keeps its legacy value. stage_entered_at keeps
-- the upgrade time that pending_delta gave it, because the real entry time was
-- never recorded. The trigger is switched back on immediately, and the block at
-- the end raises if it is not on.
--
-- Not recoverable: a legacy deal that was edited after pending_delta ran and
-- before this migration. No hosted project has ever run pending_delta, and on
-- every upgrade path this migration is pushed together with it, so that window
-- never opens in practice.

alter table public.deals disable trigger synchronize_deal_pipeline_trigger;

update public.deals
   set pipeline_stage = coalesce(nullif(stage, ''), 'new_lead'),
       stage = coalesce(nullif(stage, ''), 'new_lead')
 where stage is distinct from pipeline_stage;

alter table public.deals enable trigger synchronize_deal_pipeline_trigger;

do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad
    from public.deals
   where stage is distinct from pipeline_stage;
  if v_bad > 0 then
    raise exception '% deal(s) still disagree on stage and pipeline_stage after the legacy backfill', v_bad;
  end if;

  if not exists (
    select 1
      from pg_trigger t
     where t.tgrelid = 'public.deals'::regclass
       and t.tgname = 'synchronize_deal_pipeline_trigger'
       and t.tgenabled = 'O'
  ) then
    raise exception 'synchronize_deal_pipeline_trigger is not enabled after the legacy backfill';
  end if;
end
$$;

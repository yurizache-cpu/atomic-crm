-- Phase 3B.1: the deal stage-transition ledger and the funnel's read indexes,
-- in the Atomic CRM adapter layer.
--
-- WHY. public.deals stores only a deal's CURRENT stage (pipeline_stage) and
-- when it entered it (stage_entered_at, which synchronize_deal_pipeline keeps).
-- Nothing recorded how deals moved, so stage-to-stage movement could not be
-- measured. From this migration on, each observed entry or stage change of a
-- deal is recorded.
--
-- WHAT IT IS, AND WHAT IT IS NOT:
--   * An observation log, never a second source of the current stage.
--     public.deals.pipeline_stage stays the one authority, and nothing reads
--     the ledger to decide a deal's stage.
--   * Forward only. No row is fabricated for the past: a deal that existed
--     before this migration has no history before its first change after it,
--     and no snapshot of existing deals is recorded.
--   * One row per observation. An inserted deal records its entry (from_stage
--     null); an update that changes pipeline_stage records one row; an update
--     that keeps the stage records nothing.
--   * Written by an AFTER trigger in the same transaction as the deal write,
--     so a refused or rolled-back write records nothing. The trigger adds no
--     condition a valid deal write could fail.
--   * Content-free: two stage codes and the instant. No title, contact, amount,
--     note, actor or free text.
--   * Append-only. No update, and no delete except the cascade from the deal's
--     own deletion, which keeps erasing a deal possible.
--   * Backend-only. RLS is on with no policy, and anon, authenticated and
--     service_role hold no privilege. The writer is a SECURITY DEFINER trigger
--     function that nobody may execute directly. Company OS reads the ledger
--     only through the ops commercial adapter (20260929130000).
--
-- Matches supabase/schemas (01_tables, 02_functions, 04_triggers, 05_policies,
-- 06_grants) statement for statement.

create table public.deal_stage_transitions (
    id bigint generated always as identity primary key,
    deal_id bigint not null,
    from_stage text,
    to_stage text not null,
    changed_at timestamp with time zone not null,
    -- An entry has no previous stage; a change always has a different one.
    constraint deal_stage_transitions_changes_stage check (from_stage is distinct from to_stage)
);

alter table public.deal_stage_transitions
    add constraint deal_stage_transitions_deal_id_fkey foreign key (deal_id) references public.deals(id) on delete cascade;

create index deal_stage_transitions_changed_at_idx on public.deal_stage_transitions using btree (changed_at, id);
create index deal_stage_transitions_deal_id_idx on public.deal_stage_transitions using btree (deal_id, changed_at, id);

-- The funnel's reads: next actions, outcomes by date and new deals by date.
-- The open board by stage uses the existing deals_pipeline_stage_idx.
create index deals_open_next_action_at_idx on public.deals using btree (next_action_at) where lost_at is null and archived_at is null;
create index deals_converted_at_idx on public.deals using btree (converted_at) where converted_at is not null;
create index deals_lost_at_idx on public.deals using btree (lost_at) where lost_at is not null;
create index deals_created_at_idx on public.deals using btree (created_at);

CREATE OR REPLACE FUNCTION "public"."record_deal_stage_transition"() RETURNS trigger
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    begin
      -- changed_at is when the write was applied, read AFTER the row lock was
      -- taken. Concurrent changes of one deal are serialised by that lock, so
      -- a deal's observations follow the order the lock granted. The deal's
      -- stage_entered_at is its transaction's start, which can be earlier.
      if tg_op = 'INSERT' then
        insert into public.deal_stage_transitions (deal_id, from_stage, to_stage, changed_at)
        values (new.id, null, new.pipeline_stage, pg_catalog.clock_timestamp());
      elsif new.pipeline_stage is distinct from old.pipeline_stage then
        insert into public.deal_stage_transitions (deal_id, from_stage, to_stage, changed_at)
        values (new.id, old.pipeline_stage, new.pipeline_stage, pg_catalog.clock_timestamp());
      end if;
      return null;
    end;
    $$;

CREATE OR REPLACE FUNCTION "public"."deal_stage_transitions_append_only"() RETURNS trigger
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
    begin
      -- The cascade from a deal's own deletion runs inside that delete's
      -- referential trigger, one level deeper than any direct statement.
      if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
        return old;
      end if;
      raise exception 'public.deal_stage_transitions is append-only: % refused', lower(tg_op)
        using errcode = '42501';
    end;
    $$;

create or replace trigger record_deal_stage_transition_trigger
    after insert or update on public.deals
    for each row execute function public.record_deal_stage_transition();

create or replace trigger deal_stage_transitions_append_only_trigger
    before update or delete on public.deal_stage_transitions
    for each row execute function public.deal_stage_transitions_append_only();

alter table public.deal_stage_transitions enable row level security;

revoke all on table public.deal_stage_transitions from anon, authenticated, service_role;
revoke all on sequence public.deal_stage_transitions_id_seq from anon, authenticated, service_role;
revoke all on function public.record_deal_stage_transition() from public, anon, authenticated, service_role;
revoke all on function public.deal_stage_transitions_append_only() from public, anon, authenticated, service_role;

-- The end state, asserted: a migration that silently no-ops must not pass.
do $end_state$
declare
  v_role pg_catalog.text;
begin
  if not (select c.relrowsecurity from pg_catalog.pg_class c
           where c.oid = 'public.deal_stage_transitions'::pg_catalog.regclass)
     or exists (select 1 from pg_catalog.pg_policy p
                 where p.polrelid = 'public.deal_stage_transitions'::pg_catalog.regclass) then
    raise exception 'public.deal_stage_transitions must have RLS on and no policy';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_table_privilege(v_role, 'public.deal_stage_transitions',
         'select, insert, update, delete, truncate, references, trigger')
       or pg_catalog.has_sequence_privilege(v_role, 'public.deal_stage_transitions_id_seq', 'usage, select, update')
       or pg_catalog.has_function_privilege(v_role, 'public.record_deal_stage_transition()', 'execute')
       or pg_catalog.has_function_privilege(v_role, 'public.deal_stage_transitions_append_only()', 'execute') then
      raise exception '% holds a privilege on the deal stage-transition ledger', v_role;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_trigger t
       where not t.tgisinternal and t.tgenabled = 'O'
         and ((t.tgrelid = 'public.deals'::pg_catalog.regclass and t.tgname = 'record_deal_stage_transition_trigger')
           or (t.tgrelid = 'public.deal_stage_transitions'::pg_catalog.regclass
               and t.tgname = 'deal_stage_transitions_append_only_trigger'))) <> 2 then
    raise exception 'the deal stage-transition triggers are missing or disabled';
  end if;
  -- Forward only: nothing is backfilled for deals that already exist.
  if exists (select 1 from public.deal_stage_transitions) then
    raise exception 'public.deal_stage_transitions must start empty: no history is fabricated';
  end if;
end
$end_state$;

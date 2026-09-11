drop trigger if exists "on_contact_notes_attachments_updated_delete_note_attachments" on "public"."contact_notes";

drop trigger if exists "on_contact_notes_deleted_delete_note_attachments" on "public"."contact_notes";

drop trigger if exists "on_deal_notes_attachments_updated_delete_note_attachments" on "public"."deal_notes";

drop trigger if exists "on_deal_notes_deleted_delete_note_attachments" on "public"."deal_notes";

drop policy "Company Delete Policy" on "public"."companies";

drop policy "Enable insert for authenticated users only" on "public"."companies";

drop policy "Enable read access for authenticated users" on "public"."companies";

drop policy "Enable update for authenticated users only" on "public"."companies";

drop policy "Enable insert for admins" on "public"."configuration";

drop policy "Enable read for authenticated" on "public"."configuration";

drop policy "Enable update for admins" on "public"."configuration";

drop policy "Contact Notes Delete Policy" on "public"."contact_notes";

drop policy "Contact Notes Update policy" on "public"."contact_notes";

drop policy "Enable insert for authenticated users only" on "public"."contact_notes";

drop policy "Enable read access for authenticated users" on "public"."contact_notes";

drop policy "Contact Delete Policy" on "public"."contacts";

drop policy "Enable insert for authenticated users only" on "public"."contacts";

drop policy "Enable read access for authenticated users" on "public"."contacts";

drop policy "Enable update for authenticated users only" on "public"."contacts";

drop policy "Deal Notes Delete Policy" on "public"."deal_notes";

drop policy "Deal Notes Update Policy" on "public"."deal_notes";

drop policy "Enable insert for authenticated users only" on "public"."deal_notes";

drop policy "Enable read access for authenticated users" on "public"."deal_notes";

drop policy "Deals Delete Policy" on "public"."deals";

drop policy "Enable insert for authenticated users only" on "public"."deals";

drop policy "Enable read access for authenticated users" on "public"."deals";

drop policy "Enable update for authenticated users only" on "public"."deals";

drop policy "Enable access for authenticated users only" on "public"."favicons_excluded_domains";

drop policy "Enable read access for authenticated users" on "public"."sales";

drop policy "Enable delete for authenticated users only" on "public"."tags";

drop policy "Enable insert for authenticated users only" on "public"."tags";

drop policy "Enable read access for authenticated users" on "public"."tags";

drop policy "Enable update for authenticated users only" on "public"."tags";

drop policy "Enable insert for authenticated users only" on "public"."tasks";

drop policy "Enable read access for authenticated users" on "public"."tasks";

drop policy "Task Delete Policy" on "public"."tasks";

drop policy "Task Update Policy" on "public"."tasks";

revoke delete on table "public"."companies" from "anon";

revoke insert on table "public"."companies" from "anon";

revoke references on table "public"."companies" from "anon";

revoke select on table "public"."companies" from "anon";

revoke trigger on table "public"."companies" from "anon";

revoke truncate on table "public"."companies" from "anon";

revoke update on table "public"."companies" from "anon";

revoke references on table "public"."companies" from "authenticated";

revoke trigger on table "public"."companies" from "authenticated";

revoke truncate on table "public"."companies" from "authenticated";

revoke delete on table "public"."configuration" from "anon";

revoke insert on table "public"."configuration" from "anon";

revoke references on table "public"."configuration" from "anon";

revoke select on table "public"."configuration" from "anon";

revoke trigger on table "public"."configuration" from "anon";

revoke truncate on table "public"."configuration" from "anon";

revoke update on table "public"."configuration" from "anon";

revoke delete on table "public"."configuration" from "authenticated";

revoke insert on table "public"."configuration" from "authenticated";

revoke references on table "public"."configuration" from "authenticated";

revoke trigger on table "public"."configuration" from "authenticated";

revoke truncate on table "public"."configuration" from "authenticated";

revoke delete on table "public"."contact_notes" from "anon";

revoke insert on table "public"."contact_notes" from "anon";

revoke references on table "public"."contact_notes" from "anon";

revoke select on table "public"."contact_notes" from "anon";

revoke trigger on table "public"."contact_notes" from "anon";

revoke truncate on table "public"."contact_notes" from "anon";

revoke update on table "public"."contact_notes" from "anon";

revoke references on table "public"."contact_notes" from "authenticated";

revoke trigger on table "public"."contact_notes" from "authenticated";

revoke truncate on table "public"."contact_notes" from "authenticated";

revoke delete on table "public"."contacts" from "anon";

revoke insert on table "public"."contacts" from "anon";

revoke references on table "public"."contacts" from "anon";

revoke select on table "public"."contacts" from "anon";

revoke trigger on table "public"."contacts" from "anon";

revoke truncate on table "public"."contacts" from "anon";

revoke update on table "public"."contacts" from "anon";

revoke references on table "public"."contacts" from "authenticated";

revoke trigger on table "public"."contacts" from "authenticated";

revoke truncate on table "public"."contacts" from "authenticated";

revoke delete on table "public"."deal_notes" from "anon";

revoke insert on table "public"."deal_notes" from "anon";

revoke references on table "public"."deal_notes" from "anon";

revoke select on table "public"."deal_notes" from "anon";

revoke trigger on table "public"."deal_notes" from "anon";

revoke truncate on table "public"."deal_notes" from "anon";

revoke update on table "public"."deal_notes" from "anon";

revoke references on table "public"."deal_notes" from "authenticated";

revoke trigger on table "public"."deal_notes" from "authenticated";

revoke truncate on table "public"."deal_notes" from "authenticated";

revoke delete on table "public"."deals" from "anon";

revoke insert on table "public"."deals" from "anon";

revoke references on table "public"."deals" from "anon";

revoke select on table "public"."deals" from "anon";

revoke trigger on table "public"."deals" from "anon";

revoke truncate on table "public"."deals" from "anon";

revoke update on table "public"."deals" from "anon";

revoke references on table "public"."deals" from "authenticated";

revoke trigger on table "public"."deals" from "authenticated";

revoke truncate on table "public"."deals" from "authenticated";

revoke delete on table "public"."favicons_excluded_domains" from "anon";

revoke insert on table "public"."favicons_excluded_domains" from "anon";

revoke references on table "public"."favicons_excluded_domains" from "anon";

revoke select on table "public"."favicons_excluded_domains" from "anon";

revoke trigger on table "public"."favicons_excluded_domains" from "anon";

revoke truncate on table "public"."favicons_excluded_domains" from "anon";

revoke update on table "public"."favicons_excluded_domains" from "anon";

revoke delete on table "public"."favicons_excluded_domains" from "authenticated";

revoke insert on table "public"."favicons_excluded_domains" from "authenticated";

revoke references on table "public"."favicons_excluded_domains" from "authenticated";

revoke trigger on table "public"."favicons_excluded_domains" from "authenticated";

revoke truncate on table "public"."favicons_excluded_domains" from "authenticated";

revoke update on table "public"."favicons_excluded_domains" from "authenticated";

revoke delete on table "public"."sales" from "anon";

revoke insert on table "public"."sales" from "anon";

revoke references on table "public"."sales" from "anon";

revoke select on table "public"."sales" from "anon";

revoke trigger on table "public"."sales" from "anon";

revoke truncate on table "public"."sales" from "anon";

revoke update on table "public"."sales" from "anon";

revoke delete on table "public"."sales" from "authenticated";

revoke insert on table "public"."sales" from "authenticated";

revoke references on table "public"."sales" from "authenticated";

revoke trigger on table "public"."sales" from "authenticated";

revoke truncate on table "public"."sales" from "authenticated";

revoke update on table "public"."sales" from "authenticated";

revoke delete on table "public"."tags" from "anon";

revoke insert on table "public"."tags" from "anon";

revoke references on table "public"."tags" from "anon";

revoke select on table "public"."tags" from "anon";

revoke trigger on table "public"."tags" from "anon";

revoke truncate on table "public"."tags" from "anon";

revoke update on table "public"."tags" from "anon";

revoke references on table "public"."tags" from "authenticated";

revoke trigger on table "public"."tags" from "authenticated";

revoke truncate on table "public"."tags" from "authenticated";

revoke delete on table "public"."tasks" from "anon";

revoke insert on table "public"."tasks" from "anon";

revoke references on table "public"."tasks" from "anon";

revoke select on table "public"."tasks" from "anon";

revoke trigger on table "public"."tasks" from "anon";

revoke truncate on table "public"."tasks" from "anon";

revoke update on table "public"."tasks" from "anon";

revoke references on table "public"."tasks" from "authenticated";

revoke trigger on table "public"."tasks" from "authenticated";

revoke truncate on table "public"."tasks" from "authenticated";

drop view if exists "public"."contacts_summary";

drop view if exists "public"."init_state";


  create table "public"."acquisition_attributions" (
    "id" bigint generated by default as identity not null,
    "contact_id" bigint not null,
    "acquired_at" timestamp with time zone not null default now(),
    "source" text,
    "medium" text,
    "campaign" text,
    "campaign_id" text,
    "ad_group" text,
    "ad_group_id" text,
    "ad" text,
    "ad_id" text,
    "keyword" text,
    "match_type" text,
    "landing_page" text,
    "utm_source" text,
    "utm_medium" text,
    "utm_campaign" text,
    "utm_content" text,
    "utm_term" text,
    "gclid" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."acquisition_attributions" enable row level security;


  create table "public"."lead_profiles" (
    "id" bigint generated by default as identity not null,
    "contact_id" bigint not null,
    "acquired_at" timestamp with time zone not null default now(),
    "last_interaction_at" timestamp with time zone,
    "next_action_at" timestamp with time zone,
    "operational_status" text not null default 'active'::text,
    "do_not_contact" boolean not null default false,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."lead_profiles" enable row level security;


  create table "public"."loss_reasons" (
    "id" bigint generated by default as identity not null,
    "code" text not null,
    "label" text not null,
    "active" boolean not null default true,
    "sort_order" integer not null default 0
      );


alter table "public"."loss_reasons" enable row level security;

alter table "public"."deals" add column "converted_at" timestamp with time zone;

alter table "public"."deals" add column "loss_reason_id" bigint;

alter table "public"."deals" add column "lost_at" timestamp with time zone;

alter table "public"."deals" add column "next_action_at" timestamp with time zone;

alter table "public"."deals" add column "pipeline_stage" text not null default 'new_lead'::text;

alter table "public"."deals" add column "stage_entered_at" timestamp with time zone not null default now();

alter table "public"."sales" add column "role" text not null default 'operator'::text;

alter table "public"."sales" alter column "administrator" set default false;

CREATE INDEX acquisition_attributions_contact_id_idx ON public.acquisition_attributions USING btree (contact_id);

CREATE UNIQUE INDEX acquisition_attributions_pkey ON public.acquisition_attributions USING btree (id);

CREATE INDEX deals_loss_reason_id_idx ON public.deals USING btree (loss_reason_id) WHERE (loss_reason_id IS NOT NULL);

CREATE INDEX deals_pipeline_stage_idx ON public.deals USING btree (pipeline_stage) WHERE ((lost_at IS NULL) AND (archived_at IS NULL));

CREATE INDEX lead_profiles_contact_id_idx ON public.lead_profiles USING btree (contact_id);

CREATE UNIQUE INDEX lead_profiles_contact_id_key ON public.lead_profiles USING btree (contact_id);

CREATE INDEX lead_profiles_next_action_at_idx ON public.lead_profiles USING btree (next_action_at) WHERE (do_not_contact = false);

CREATE UNIQUE INDEX lead_profiles_pkey ON public.lead_profiles USING btree (id);

CREATE UNIQUE INDEX loss_reasons_code_key ON public.loss_reasons USING btree (code);

CREATE UNIQUE INDEX loss_reasons_pkey ON public.loss_reasons USING btree (id);

alter table "public"."acquisition_attributions" add constraint "acquisition_attributions_pkey" PRIMARY KEY using index "acquisition_attributions_pkey";

alter table "public"."lead_profiles" add constraint "lead_profiles_pkey" PRIMARY KEY using index "lead_profiles_pkey";

alter table "public"."loss_reasons" add constraint "loss_reasons_pkey" PRIMARY KEY using index "loss_reasons_pkey";

alter table "public"."acquisition_attributions" add constraint "acquisition_attributions_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."acquisition_attributions" validate constraint "acquisition_attributions_contact_id_fkey";

alter table "public"."deals" add constraint "deals_loss_reason_id_fkey" FOREIGN KEY (loss_reason_id) REFERENCES public.loss_reasons(id) not valid;

alter table "public"."deals" validate constraint "deals_loss_reason_id_fkey";

alter table "public"."deals" add constraint "deals_lost_requires_reason" CHECK (((lost_at IS NULL) OR (loss_reason_id IS NOT NULL))) not valid;

alter table "public"."deals" validate constraint "deals_lost_requires_reason";

alter table "public"."lead_profiles" add constraint "lead_profiles_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."lead_profiles" validate constraint "lead_profiles_contact_id_fkey";

alter table "public"."lead_profiles" add constraint "lead_profiles_contact_id_key" UNIQUE using index "lead_profiles_contact_id_key";

alter table "public"."loss_reasons" add constraint "loss_reasons_code_key" UNIQUE using index "loss_reasons_code_key";

alter table "public"."sales" add constraint "sales_role_check" CHECK ((role = ANY (ARRAY['owner'::text, 'operator'::text]))) not valid;

alter table "public"."sales" validate constraint "sales_role_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.can_access_contact(target_contact_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select public.is_admin() or exists (
      select 1
      from public.contacts c
      where c.id = $1
        and c.sales_id = public.current_sales_id()
    );
    $function$
;

CREATE OR REPLACE FUNCTION public.can_access_deal(target_deal_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select public.is_admin() or exists (
      select 1
      from public.deals d
      where d.id = $1
        and d.sales_id = public.current_sales_id()
    );
    $function$
;

CREATE OR REPLACE FUNCTION public.can_manage_sales_id(target_sales_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select public.is_admin() or public.current_sales_id() = $1;
    $function$
;

CREATE OR REPLACE FUNCTION public.create_lead_profile_for_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
    begin
      insert into public.lead_profiles (
        contact_id,
        acquired_at,
        last_interaction_at
      ) values (
        new.id,
        coalesce(new.first_seen, now()),
        new.last_seen
      ) on conflict (contact_id) do nothing;
      return new;
    end;
    $function$
;

CREATE OR REPLACE FUNCTION public.current_sales_id()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select s.id
    from public.sales s
    where s.user_id = auth.uid()
      and s.disabled = false
    limit 1;
    $function$
;

CREATE OR REPLACE FUNCTION public.is_active_sales_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select public.current_sales_id() is not null;
    $function$
;

CREATE OR REPLACE FUNCTION public.set_lead_profile_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
    begin
      new.updated_at = now();
      return new;
    end;
    $function$
;

CREATE OR REPLACE FUNCTION public.synchronize_deal_pipeline()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
    begin
      if new.pipeline_stage is null then
        new.pipeline_stage = coalesce(nullif(new.stage, ''), 'new_lead');
      end if;

      new.stage = new.pipeline_stage;
      new.updated_at = now();

      if tg_op = 'INSERT' then
        new.stage_entered_at = coalesce(new.stage_entered_at, now());
      elsif new.pipeline_stage is distinct from old.pipeline_stage then
        new.stage_entered_at = now();
      end if;

      return new;
    end;
    $function$
;

create or replace view "public"."contacts_summary" as  SELECT co.id,
    co.first_name,
    co.last_name,
    co.gender,
    co.title,
    co.background,
    co.avatar,
    co.first_seen,
    co.last_seen,
    co.has_newsletter,
    co.status,
    co.tags,
    co.company_id,
    co.sales_id,
    co.linkedin_url,
    co.email_jsonb,
    co.phone_jsonb,
    lp.acquired_at,
    lp.last_interaction_at,
    lp.next_action_at,
    lp.operational_status,
    lp.do_not_contact,
    attribution.source AS acquisition_source,
    attribution.medium AS acquisition_medium,
    attribution.campaign AS acquisition_campaign,
    (jsonb_path_query_array(co.email_jsonb, '$[*]."email"'::jsonpath))::text AS email_fts,
    (jsonb_path_query_array(co.phone_jsonb, '$[*]."number"'::jsonpath))::text AS phone_fts,
    c.name AS company_name,
    count(DISTINCT t.id) FILTER (WHERE (t.done_date IS NULL)) AS nb_tasks
   FROM ((((public.contacts co
     LEFT JOIN public.tasks t ON ((co.id = t.contact_id)))
     LEFT JOIN public.companies c ON ((co.company_id = c.id)))
     LEFT JOIN public.lead_profiles lp ON ((lp.contact_id = co.id)))
     LEFT JOIN LATERAL ( SELECT aa.source,
            aa.medium,
            aa.campaign
           FROM public.acquisition_attributions aa
          WHERE (aa.contact_id = co.id)
          ORDER BY aa.acquired_at DESC, aa.id DESC
         LIMIT 1) attribution ON (true))
  GROUP BY co.id, c.name, lp.id, attribution.source, attribution.medium, attribution.campaign;


CREATE OR REPLACE FUNCTION public.handle_contact_note_created_or_updated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.contacts set last_seen = new.date where contacts.id = new.contact_id and contacts.last_seen < new.date;
  update public.lead_profiles
  set last_interaction_at = new.date
  where contact_id = new.contact_id
    and (last_interaction_at is null or last_interaction_at < new.date);
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.sales (first_name, last_name, email, user_id, administrator, role)
  values (
    coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data -> 'custom_claims' ->> 'first_name', 'Pending'),
    coalesce(new.raw_user_meta_data ->> 'last_name', new.raw_user_meta_data -> 'custom_claims' ->> 'last_name', 'Pending'),
    new.email,
    new.id,
    false,
    'operator'
  );
  return new;
end;
$function$
;

create or replace view "public"."init_state" as  SELECT count(sub.id) AS is_initialized
   FROM ( SELECT sales.id
           FROM public.sales
         LIMIT 1) sub;


CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return exists (
    select 1
    from public.sales
    where user_id = auth.uid()
      and administrator = true
      and role = 'owner'
      and disabled = false
  );
end;
$function$
;

grant delete on table "public"."acquisition_attributions" to "authenticated";

grant insert on table "public"."acquisition_attributions" to "authenticated";

grant select on table "public"."acquisition_attributions" to "authenticated";

grant update on table "public"."acquisition_attributions" to "authenticated";

grant delete on table "public"."acquisition_attributions" to "service_role";

grant insert on table "public"."acquisition_attributions" to "service_role";

grant references on table "public"."acquisition_attributions" to "service_role";

grant select on table "public"."acquisition_attributions" to "service_role";

grant trigger on table "public"."acquisition_attributions" to "service_role";

grant truncate on table "public"."acquisition_attributions" to "service_role";

grant update on table "public"."acquisition_attributions" to "service_role";

grant select on table "public"."lead_profiles" to "authenticated";

grant update on table "public"."lead_profiles" to "authenticated";

grant delete on table "public"."lead_profiles" to "service_role";

grant insert on table "public"."lead_profiles" to "service_role";

grant references on table "public"."lead_profiles" to "service_role";

grant select on table "public"."lead_profiles" to "service_role";

grant trigger on table "public"."lead_profiles" to "service_role";

grant truncate on table "public"."lead_profiles" to "service_role";

grant update on table "public"."lead_profiles" to "service_role";

grant delete on table "public"."loss_reasons" to "authenticated";

grant insert on table "public"."loss_reasons" to "authenticated";

grant select on table "public"."loss_reasons" to "authenticated";

grant update on table "public"."loss_reasons" to "authenticated";

grant delete on table "public"."loss_reasons" to "service_role";

grant insert on table "public"."loss_reasons" to "service_role";

grant references on table "public"."loss_reasons" to "service_role";

grant select on table "public"."loss_reasons" to "service_role";

grant trigger on table "public"."loss_reasons" to "service_role";

grant truncate on table "public"."loss_reasons" to "service_role";

grant update on table "public"."loss_reasons" to "service_role";


  create policy "acquisition_delete_scoped"
  on "public"."acquisition_attributions"
  as permissive
  for delete
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id)));



  create policy "acquisition_insert_scoped"
  on "public"."acquisition_attributions"
  as permissive
  for insert
  to authenticated
with check ((public.is_active_sales_user() AND public.can_access_contact(contact_id)));



  create policy "acquisition_select_scoped"
  on "public"."acquisition_attributions"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id)));



  create policy "acquisition_update_scoped"
  on "public"."acquisition_attributions"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id)))
with check ((public.is_active_sales_user() AND public.can_access_contact(contact_id)));



  create policy "company_delete_scoped"
  on "public"."companies"
  as permissive
  for delete
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "company_insert_scoped"
  on "public"."companies"
  as permissive
  for insert
  to authenticated
with check ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "company_select_scoped"
  on "public"."companies"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "company_update_scoped"
  on "public"."companies"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)))
with check ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "configuration_select_active"
  on "public"."configuration"
  as permissive
  for select
  to authenticated
using (public.is_active_sales_user());



  create policy "configuration_update_owner"
  on "public"."configuration"
  as permissive
  for update
  to authenticated
using (public.is_admin())
with check (public.is_admin());



  create policy "contact_note_delete_scoped"
  on "public"."contact_notes"
  as permissive
  for delete
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id) AND public.can_manage_sales_id(sales_id)));



  create policy "contact_note_insert_scoped"
  on "public"."contact_notes"
  as permissive
  for insert
  to authenticated
with check ((public.is_active_sales_user() AND public.can_access_contact(contact_id) AND public.can_manage_sales_id(sales_id)));



  create policy "contact_note_select_scoped"
  on "public"."contact_notes"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id)));



  create policy "contact_note_update_scoped"
  on "public"."contact_notes"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id) AND public.can_manage_sales_id(sales_id)))
with check ((public.is_active_sales_user() AND public.can_access_contact(contact_id) AND public.can_manage_sales_id(sales_id)));



  create policy "contact_delete_scoped"
  on "public"."contacts"
  as permissive
  for delete
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "contact_insert_scoped"
  on "public"."contacts"
  as permissive
  for insert
  to authenticated
with check ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "contact_select_scoped"
  on "public"."contacts"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "contact_update_scoped"
  on "public"."contacts"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)))
with check ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "deal_note_delete_scoped"
  on "public"."deal_notes"
  as permissive
  for delete
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_deal(deal_id) AND public.can_manage_sales_id(sales_id)));



  create policy "deal_note_insert_scoped"
  on "public"."deal_notes"
  as permissive
  for insert
  to authenticated
with check ((public.is_active_sales_user() AND public.can_access_deal(deal_id) AND public.can_manage_sales_id(sales_id)));



  create policy "deal_note_select_scoped"
  on "public"."deal_notes"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_deal(deal_id)));



  create policy "deal_note_update_scoped"
  on "public"."deal_notes"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_deal(deal_id) AND public.can_manage_sales_id(sales_id)))
with check ((public.is_active_sales_user() AND public.can_access_deal(deal_id) AND public.can_manage_sales_id(sales_id)));



  create policy "deal_delete_scoped"
  on "public"."deals"
  as permissive
  for delete
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "deal_insert_scoped"
  on "public"."deals"
  as permissive
  for insert
  to authenticated
with check ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "deal_select_scoped"
  on "public"."deals"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "deal_update_scoped"
  on "public"."deals"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)))
with check ((public.is_active_sales_user() AND public.can_manage_sales_id(sales_id)));



  create policy "favicon_mutation_owner"
  on "public"."favicons_excluded_domains"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());



  create policy "favicon_select_active"
  on "public"."favicons_excluded_domains"
  as permissive
  for select
  to authenticated
using (public.is_active_sales_user());



  create policy "lead_profile_select_scoped"
  on "public"."lead_profiles"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id)));



  create policy "lead_profile_update_scoped"
  on "public"."lead_profiles"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND public.can_access_contact(contact_id)))
with check ((public.is_active_sales_user() AND public.can_access_contact(contact_id)));



  create policy "loss_reason_delete_owner"
  on "public"."loss_reasons"
  as permissive
  for delete
  to authenticated
using (public.is_admin());



  create policy "loss_reason_insert_owner"
  on "public"."loss_reasons"
  as permissive
  for insert
  to authenticated
with check (public.is_admin());



  create policy "loss_reason_select_active"
  on "public"."loss_reasons"
  as permissive
  for select
  to authenticated
using (public.is_active_sales_user());



  create policy "loss_reason_update_owner"
  on "public"."loss_reasons"
  as permissive
  for update
  to authenticated
using (public.is_admin())
with check (public.is_admin());



  create policy "sales_select_scoped"
  on "public"."sales"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND (public.is_admin() OR (user_id = auth.uid()))));



  create policy "tags_delete_owner"
  on "public"."tags"
  as permissive
  for delete
  to authenticated
using (public.is_admin());



  create policy "tags_insert_owner"
  on "public"."tags"
  as permissive
  for insert
  to authenticated
with check (public.is_admin());



  create policy "tags_select_active"
  on "public"."tags"
  as permissive
  for select
  to authenticated
using (public.is_active_sales_user());



  create policy "tags_update_owner"
  on "public"."tags"
  as permissive
  for update
  to authenticated
using (public.is_admin())
with check (public.is_admin());



  create policy "task_delete_scoped"
  on "public"."tasks"
  as permissive
  for delete
  to authenticated
using ((public.is_active_sales_user() AND (public.is_admin() OR ((sales_id = public.current_sales_id()) AND public.can_access_contact(contact_id)))));



  create policy "task_insert_scoped"
  on "public"."tasks"
  as permissive
  for insert
  to authenticated
with check ((public.is_active_sales_user() AND (public.is_admin() OR ((sales_id = public.current_sales_id()) AND public.can_access_contact(contact_id)))));



  create policy "task_select_scoped"
  on "public"."tasks"
  as permissive
  for select
  to authenticated
using ((public.is_active_sales_user() AND (public.is_admin() OR ((sales_id = public.current_sales_id()) AND public.can_access_contact(contact_id)))));



  create policy "task_update_scoped"
  on "public"."tasks"
  as permissive
  for update
  to authenticated
using ((public.is_active_sales_user() AND (public.is_admin() OR ((sales_id = public.current_sales_id()) AND public.can_access_contact(contact_id)))))
with check ((public.is_active_sales_user() AND (public.is_admin() OR ((sales_id = public.current_sales_id()) AND public.can_access_contact(contact_id)))));


CREATE TRIGGER create_lead_profile_after_contact_insert AFTER INSERT ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.create_lead_profile_for_contact();

CREATE TRIGGER synchronize_deal_pipeline_trigger BEFORE INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.synchronize_deal_pipeline();

CREATE TRIGGER set_lead_profile_updated_at_trigger BEFORE UPDATE ON public.lead_profiles FOR EACH ROW EXECUTE FUNCTION public.set_lead_profile_updated_at();



--
-- Row Level Security
-- The clinical CRM is a single organization. Owner/admin users may access all
-- commercial records; active operators may access only records assigned to
-- their sales_id and children of those records.
--

alter table public.companies enable row level security;
alter table public.contacts enable row level security;
alter table public.contact_notes enable row level security;
alter table public.deals enable row level security;
alter table public.deal_notes enable row level security;
alter table public.sales enable row level security;
alter table public.tags enable row level security;
alter table public.tasks enable row level security;
alter table public.configuration enable row level security;
alter table public.favicons_excluded_domains enable row level security;
alter table public.lead_profiles enable row level security;
alter table public.acquisition_attributions enable row level security;
alter table public.loss_reasons enable row level security;

-- Companies
create policy "company_select_scoped" on public.companies for select to authenticated using (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);
create policy "company_insert_scoped" on public.companies for insert to authenticated with check (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);
create policy "company_update_scoped" on public.companies for update to authenticated
  using (public.is_active_sales_user() and public.can_manage_sales_id(sales_id))
  with check (public.is_active_sales_user() and public.can_manage_sales_id(sales_id));
create policy "company_delete_scoped" on public.companies for delete to authenticated using (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);

-- Contacts
create policy "contact_select_scoped" on public.contacts for select to authenticated using (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);
create policy "contact_insert_scoped" on public.contacts for insert to authenticated with check (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);
create policy "contact_update_scoped" on public.contacts for update to authenticated
  using (public.is_active_sales_user() and public.can_manage_sales_id(sales_id))
  with check (public.is_active_sales_user() and public.can_manage_sales_id(sales_id));
create policy "contact_delete_scoped" on public.contacts for delete to authenticated using (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);

-- Notes remain commercial/administrative only. Operators may write only their
-- own notes, on contacts/deals within their assigned scope.
create policy "contact_note_select_scoped" on public.contact_notes for select to authenticated using (
  public.is_active_sales_user() and public.can_access_contact(contact_id)
);
create policy "contact_note_insert_scoped" on public.contact_notes for insert to authenticated with check (
  public.is_active_sales_user()
  and public.can_access_contact(contact_id)
  and public.can_manage_sales_id(sales_id)
);
create policy "contact_note_update_scoped" on public.contact_notes for update to authenticated
  using (
    public.is_active_sales_user()
    and public.can_access_contact(contact_id)
    and public.can_manage_sales_id(sales_id)
  )
  with check (
    public.is_active_sales_user()
    and public.can_access_contact(contact_id)
    and public.can_manage_sales_id(sales_id)
  );
create policy "contact_note_delete_scoped" on public.contact_notes for delete to authenticated using (
  public.is_active_sales_user()
  and public.can_access_contact(contact_id)
  and public.can_manage_sales_id(sales_id)
);

-- Deals
create policy "deal_select_scoped" on public.deals for select to authenticated using (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);
create policy "deal_insert_scoped" on public.deals for insert to authenticated with check (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);
create policy "deal_update_scoped" on public.deals for update to authenticated
  using (public.is_active_sales_user() and public.can_manage_sales_id(sales_id))
  with check (public.is_active_sales_user() and public.can_manage_sales_id(sales_id));
create policy "deal_delete_scoped" on public.deals for delete to authenticated using (
  public.is_active_sales_user() and public.can_manage_sales_id(sales_id)
);

create policy "deal_note_select_scoped" on public.deal_notes for select to authenticated using (
  public.is_active_sales_user() and public.can_access_deal(deal_id)
);
create policy "deal_note_insert_scoped" on public.deal_notes for insert to authenticated with check (
  public.is_active_sales_user()
  and public.can_access_deal(deal_id)
  and public.can_manage_sales_id(sales_id)
);
create policy "deal_note_update_scoped" on public.deal_notes for update to authenticated
  using (
    public.is_active_sales_user()
    and public.can_access_deal(deal_id)
    and public.can_manage_sales_id(sales_id)
  )
  with check (
    public.is_active_sales_user()
    and public.can_access_deal(deal_id)
    and public.can_manage_sales_id(sales_id)
  );
create policy "deal_note_delete_scoped" on public.deal_notes for delete to authenticated using (
  public.is_active_sales_user()
  and public.can_access_deal(deal_id)
  and public.can_manage_sales_id(sales_id)
);

-- User directory: operators can see only their own identity; owners manage
-- accounts through the authorized Edge Function, never direct table writes.
create policy "sales_select_scoped" on public.sales for select to authenticated using (
  public.is_active_sales_user()
  and (public.is_admin() or user_id = auth.uid())
);

-- Shared metadata is readable by active users. Only owners may change it.
create policy "tags_select_active" on public.tags for select to authenticated using (public.is_active_sales_user());
create policy "tags_insert_owner" on public.tags for insert to authenticated with check (public.is_admin());
create policy "tags_update_owner" on public.tags for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "tags_delete_owner" on public.tags for delete to authenticated using (public.is_admin());

create policy "loss_reason_select_active" on public.loss_reasons for select to authenticated using (public.is_active_sales_user());
create policy "loss_reason_insert_owner" on public.loss_reasons for insert to authenticated with check (public.is_admin());
create policy "loss_reason_update_owner" on public.loss_reasons for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "loss_reason_delete_owner" on public.loss_reasons for delete to authenticated using (public.is_admin());

create policy "configuration_select_active" on public.configuration for select to authenticated using (public.is_active_sales_user());
create policy "configuration_update_owner" on public.configuration for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "favicon_select_active" on public.favicons_excluded_domains for select to authenticated using (public.is_active_sales_user());
create policy "favicon_mutation_owner" on public.favicons_excluded_domains to authenticated using (public.is_admin()) with check (public.is_admin());

-- Tasks are the sole follow-up mechanism in Phase 1. The assignee must own the
-- task and the linked contact unless they are an owner/admin.
create policy "task_select_scoped" on public.tasks for select to authenticated using (
  public.is_active_sales_user()
  and (public.is_admin() or (
    sales_id = public.current_sales_id() and public.can_access_contact(contact_id)
  ))
);
create policy "task_insert_scoped" on public.tasks for insert to authenticated with check (
  public.is_active_sales_user()
  and (public.is_admin() or (
    sales_id = public.current_sales_id() and public.can_access_contact(contact_id)
  ))
);
create policy "task_update_scoped" on public.tasks for update to authenticated
  using (
    public.is_active_sales_user()
    and (public.is_admin() or (
      sales_id = public.current_sales_id() and public.can_access_contact(contact_id)
    ))
  )
  with check (
    public.is_active_sales_user()
    and (public.is_admin() or (
      sales_id = public.current_sales_id() and public.can_access_contact(contact_id)
    ))
  );
create policy "task_delete_scoped" on public.tasks for delete to authenticated using (
  public.is_active_sales_user()
  and (public.is_admin() or (
    sales_id = public.current_sales_id() and public.can_access_contact(contact_id)
  ))
);

-- Lead and attribution records inherit their contact's scope.
create policy "lead_profile_select_scoped" on public.lead_profiles for select to authenticated using (
  public.is_active_sales_user() and public.can_access_contact(contact_id)
);
create policy "lead_profile_update_scoped" on public.lead_profiles for update to authenticated
  using (public.is_active_sales_user() and public.can_access_contact(contact_id))
  with check (public.is_active_sales_user() and public.can_access_contact(contact_id));

create policy "acquisition_select_scoped" on public.acquisition_attributions for select to authenticated using (
  public.is_active_sales_user() and public.can_access_contact(contact_id)
);
create policy "acquisition_insert_scoped" on public.acquisition_attributions for insert to authenticated with check (
  public.is_active_sales_user() and public.can_access_contact(contact_id)
);
create policy "acquisition_update_scoped" on public.acquisition_attributions for update to authenticated
  using (public.is_active_sales_user() and public.can_access_contact(contact_id))
  with check (public.is_active_sales_user() and public.can_access_contact(contact_id));
create policy "acquisition_delete_scoped" on public.acquisition_attributions for delete to authenticated using (
  public.is_active_sales_user() and public.can_access_contact(contact_id)
);

// FIXME: This should be exported from the ra-core package
type CanAccessParams<
  RecordType extends Record<string, any> = Record<string, any>,
> = {
  action: string;
  resource: string;
  record?: RecordType;
};

/**
 * Resources a non-admin may reach.
 *
 * This is an ALLOW-list on purpose. It used to be a deny-list ending in
 * `return true`, so every resource nobody had thought about was readable and
 * writable by any authenticated non-admin — including every engine resource
 * the Company OS will add later (agents, approvals, costs, decisions, audit).
 * A gate whose default is "yes" grants access to things that do not exist yet,
 * which is precisely the failure mode this project must not ship.
 *
 * Adding a resource to the app therefore means adding it here deliberately.
 * Forgetting denies access, which is visible and safe; the old default was
 * invisible and unsafe.
 *
 * `_summary` views back the list screens of the resource of the same name and
 * are reached under their own name in a few places, so they carry the same
 * permission as the table they summarise.
 */
const NON_ADMIN_RESOURCES = new Set([
  "companies",
  "companies_summary",
  "contacts",
  "contacts_summary",
  "contact_notes",
  "deals",
  "deal_notes",
  "tags",
  "tasks",
  // Commercial lead data, scoped per sales rep by RLS.
  "lead_profiles",
  "acquisition_attributions",
  // Reference rows the deal form reads to render loss reasons.
  "loss_reasons",
]);

export const canAccess = <
  RecordType extends Record<string, any> = Record<string, any>,
>(
  role: string,
  params: CanAccessParams<RecordType>,
) => {
  if (role === "admin") {
    return true;
  }

  // Non admins can't access the sales or configuration resources. Kept as
  // explicit denials so the intent survives even if either name is ever added
  // to the allow-list by mistake.
  if (params.resource === "sales" || params.resource === "configuration") {
    return false;
  }

  // Unknown resource -> denied. This is the whole point of the change.
  return NON_ADMIN_RESOURCES.has(params.resource);
};

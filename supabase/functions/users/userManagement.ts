// Authorization and ordering for the CRM `users` edge function (Phase 2C S7,
// OD-11; docs/PHASE_2C_BRIEF.md §14 item 2, §16, §19 S7).
//
// A Company OS member is the Supabase Auth user id, never an email, so the
// only way to act as another member is to control that auth user's login. This
// module keeps the CRM's user management from handing that login to anyone:
//
//   - Every authorization check runs before any Auth admin call and any
//     `sales` write: a refused request changes nothing.
//   - Nobody changes a login email through the Auth admin API, the active CRM
//     owner included, not even their own: an admin email change followed by a
//     password recovery is exactly how a login is captured. A person changes
//     their own email through GoTrue, which confirms it.
//   - Nobody sets another person's password: an invitation lets the invitee
//     choose one, so the owner never knows it.
//   - A CRM-disabled user acts on nothing, so they cannot lift their own ban;
//     only the active owner changes a ban, a role or the disabled flag.
//   - An invitation either completes or leaves nothing behind: a failure after
//     the auth user exists removes the account it created.
//
// Pure: the Auth admin API and the `sales` table arrive as ports, so each rule
// is provable without a network (userManagement.test.ts).

export interface SaleRecord {
  id: number | string;
  user_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  administrator?: boolean | null;
  role?: string | null;
  disabled?: boolean | null;
  avatar?: string | null;
}

export interface UserManagementPorts {
  findSaleById(id: unknown): Promise<SaleRecord | null>;
  findSaleByUserId(userId: string): Promise<SaleRecord | null>;
  /** Auth admin: name metadata and, for the owner only, the ban. Never the email or the password. */
  updateAuthUser(
    userId: string,
    attributes: {
      user_metadata: { first_name?: unknown; last_name?: unknown };
      ban_duration?: string;
    },
  ): Promise<{ ok: boolean }>;
  updateSale(
    userId: string,
    patch: Partial<Omit<SaleRecord, "id" | "user_id" | "email">>,
  ): Promise<SaleRecord | null>;
  /** Auth admin: a new user with no password. */
  createAuthUser(
    email: string,
    metadata: { first_name?: unknown; last_name?: unknown },
  ): Promise<{ userId: string } | { error: string }>;
  findAuthUserIdByEmail(email: string): Promise<string | null>;
  insertSale(record: Omit<SaleRecord, "id">): Promise<SaleRecord | null>;
  inviteUserByEmail(email: string): Promise<{ ok: boolean }>;
  deleteSaleByUserId(userId: string): Promise<{ ok: boolean }>;
  deleteAuthUser(userId: string): Promise<{ ok: boolean }>;
}

export interface Outcome {
  status: number;
  body: { data?: SaleRecord | null; message?: string; code?: string };
}

/** Ten years: how the CRM has always represented "disabled" in Auth. */
export const DISABLED_BAN = "87600h";

export const isOwner = (sale: SaleRecord | null | undefined): boolean =>
  sale?.administrator === true && sale?.role === "owner" && !sale?.disabled;

const refuse = (status: number, code: string, message: string): Outcome => ({
  status,
  body: { code, message },
});

const NOT_AUTHORIZED = refuse(401, "not_authorized", "Not Authorized");

const EMAIL_CHANGE_REFUSED = refuse(
  403,
  "email_change_refused",
  "A login email is changed only by its owner, from their own account, and the change must be confirmed.",
);

const PASSWORD_REFUSED = refuse(
  400,
  "password_refused",
  "An administrator never sets another person's password: the invitation lets them choose one.",
);

const OWNER_ONLY_FIELDS = refuse(
  403,
  "owner_only",
  "Only the active owner changes a role or the disabled flag.",
);

const sameEmail = (a: unknown, b: unknown): boolean =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

const changes = (requested: unknown, current: unknown): boolean =>
  typeof requested === "boolean" && requested !== (current === true);

const roleFor = (administrator: boolean) =>
  administrator ? "owner" : "operator";

export interface PatchUserInput {
  sales_id?: unknown;
  email?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  avatar?: unknown;
  administrator?: unknown;
  disabled?: unknown;
}

/**
 * PATCH: update a CRM user. Authorization first, then the writes: a name and
 * an avatar for oneself or, as a CRM administrator, for anyone; a role, the
 * disabled flag and the ban only as the active owner; never a login email.
 */
export async function patchUser(
  ports: UserManagementPorts,
  caller: SaleRecord,
  input: PatchUserInput,
): Promise<Outcome> {
  // A CRM-disabled user acts on nothing, their own profile included, so they
  // can never lift their own ban.
  if (caller.disabled) return NOT_AUTHORIZED;

  const target = await ports.findSaleById(input.sales_id);
  if (!target) return refuse(404, "not_found", "Not Found");

  const isSelf = String(caller.id) === String(target.id);
  if (!isSelf && caller.administrator !== true) return NOT_AUTHORIZED;

  // The login email is the account itself: no administrator path moves it.
  if (input.email !== undefined && !sameEmail(input.email, target.email)) {
    return EMAIL_CHANGE_REFUSED;
  }

  const owner = isOwner(caller);
  const roleChange = changes(input.administrator, target.administrator);
  const disabledChange = changes(input.disabled, target.disabled);
  if (!owner && (roleChange || disabledChange)) return OWNER_ONLY_FIELDS;

  // Every check has passed: now, and only now, the writes.
  const banChange = owner && typeof input.disabled === "boolean";
  const auth = await ports.updateAuthUser(target.user_id, {
    user_metadata: { first_name: input.first_name, last_name: input.last_name },
    ...(banChange
      ? { ban_duration: input.disabled ? DISABLED_BAN : "none" }
      : {}),
  });
  if (!auth.ok) return refuse(500, "internal", "Internal Server Error");

  const patch: Partial<SaleRecord> = {};
  if (typeof input.avatar === "string" && input.avatar !== "") {
    patch.avatar = input.avatar;
  }
  if (owner && typeof input.disabled === "boolean") {
    patch.disabled = input.disabled;
  }
  if (owner && typeof input.administrator === "boolean") {
    // One statement: the role and the administrator flag never disagree.
    patch.administrator = input.administrator;
    patch.role = roleFor(input.administrator);
  }
  if (Object.keys(patch).length > 0) {
    const updated = await ports.updateSale(target.user_id, patch);
    if (!updated) return refuse(500, "internal", "Internal Server Error");
    return { status: 200, body: { data: updated } };
  }
  return {
    status: 200,
    body: { data: await ports.findSaleByUserId(target.user_id) },
  };
}

export interface InviteUserInput {
  email?: unknown;
  password?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  disabled?: unknown;
  administrator?: unknown;
}

/**
 * POST: invite a CRM user, as the active owner only. No password: the
 * invitation lets the person choose one. A failure after the auth user exists
 * removes what this call created, so no half-created account or administrator
 * row survives.
 */
export async function inviteUser(
  ports: UserManagementPorts,
  caller: SaleRecord,
  input: InviteUserInput,
): Promise<Outcome> {
  if (!isOwner(caller)) return NOT_AUTHORIZED;
  if (
    input.password !== undefined &&
    input.password !== null &&
    input.password !== ""
  ) {
    return PASSWORD_REFUSED;
  }
  if (typeof input.email !== "string" || input.email.trim() === "") {
    return refuse(400, "email_required", "An email is required.");
  }
  const email = input.email;
  const administrator = input.administrator === true;
  const disabled = input.disabled === true;

  const created = await ports.createAuthUser(email, {
    first_name: input.first_name,
    last_name: input.last_name,
  });

  if ("error" in created) {
    if (created.error !== "email_exists") {
      return refuse(500, "internal", "Internal Server Error");
    }
    // An auth user with this email already exists (the CRM's data was reset
    // but its auth users were not): give it a CRM profile, nothing else. Its
    // login, password and Company OS membership are untouched.
    const userId = await ports.findAuthUserIdByEmail(email);
    if (!userId) return refuse(500, "internal", "Internal Server Error");
    if (await ports.findSaleByUserId(userId)) {
      return refuse(
        400,
        "sale_exists",
        "A sales for this email already exists",
      );
    }
    const sale = await ports.insertSale({
      user_id: userId,
      email,
      first_name: input.first_name as string,
      last_name: input.last_name as string,
      disabled,
      administrator,
      role: roleFor(administrator),
    });
    if (!sale) return refuse(500, "internal", "Internal Server Error");
    return { status: 200, body: { data: sale } };
  }

  const { userId } = created;
  // The account the trigger created is a plain operator; set its flags in one
  // statement, then send the invitation. Any failure removes the account.
  const sale = await ports.updateSale(userId, {
    disabled,
    administrator,
    role: roleFor(administrator),
  });
  const invited = sale ? await ports.inviteUserByEmail(email) : { ok: false };
  if (!sale || !invited.ok) {
    await removeCreatedAccount(ports, userId);
    return refuse(500, "invitation_failed", "Failed to invite the user");
  }
  return { status: 200, body: { data: sale } };
}

async function removeCreatedAccount(
  ports: UserManagementPorts,
  userId: string,
): Promise<void> {
  // The sales row first: it references the auth user.
  const sale = await ports.deleteSaleByUserId(userId);
  const auth = await ports.deleteAuthUser(userId);
  if (!sale.ok || !auth.ok) {
    console.error("users: a failed invitation left an account to remove", {
      userId,
      saleRemoved: sale.ok,
      authUserRemoved: auth.ok,
    });
  }
}

// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DISABLED_BAN,
  inviteUser,
  patchUser,
  type SaleRecord,
  type UserManagementPorts,
} from "./userManagement";

// The S7 user-management prerequisite (docs/PHASE_2C_BRIEF.md §16, §19 S7): a
// Company OS member is an auth user id, so whoever controls that user's login
// acts as the member. Before this change any CRM administrator could change
// another user's auth email (then recover its password), the owner chose an
// invitee's initial password, a CRM-disabled user could lift their own ban,
// and a failed invitation left a half-created account. Each case below was red
// on that function and is green on this one.

interface AuthUser {
  id: string;
  email: string;
  password?: string;
  banned: boolean;
  metadata: Record<string, unknown>;
}

/** An in-memory Auth directory and sales table that records every call. */
function world(
  options: { failInvite?: boolean; failSaleUpdate?: boolean } = {},
) {
  const auth = new Map<string, AuthUser>();
  const sales = new Map<string, SaleRecord>();
  const calls: { name: string; args: unknown[] }[] = [];
  let nextId = 100;
  const record = (name: string, args: unknown[]) => calls.push({ name, args });
  const saleOf = (userId: string) =>
    [...sales.values()].find((s) => s.user_id === userId) ?? null;

  const addUser = (sale: Omit<SaleRecord, "user_id">, banned = false) => {
    const userId = `user-${sale.id}`;
    auth.set(userId, { id: userId, email: sale.email, banned, metadata: {} });
    sales.set(String(sale.id), { ...sale, user_id: userId });
    return sales.get(String(sale.id))!;
  };

  const ports: UserManagementPorts = {
    async findSaleById(id) {
      record("findSaleById", [id]);
      return sales.get(String(id)) ?? null;
    },
    async findSaleByUserId(userId) {
      record("findSaleByUserId", [userId]);
      return saleOf(userId);
    },
    async updateAuthUser(userId, attributes) {
      record("updateAuthUser", [userId, attributes]);
      const user = auth.get(userId);
      if (!user) return { ok: false };
      const a = attributes as Record<string, unknown>;
      if (typeof a.email === "string") user.email = a.email;
      if (typeof a.password === "string") user.password = a.password;
      if (a.ban_duration !== undefined) user.banned = a.ban_duration !== "none";
      user.metadata = { ...user.metadata, ...(a.user_metadata as object) };
      return { ok: true };
    },
    async updateSale(userId, patch) {
      record("updateSale", [userId, patch]);
      const sale = saleOf(userId);
      if (!sale || options.failSaleUpdate) return null;
      Object.assign(sale, patch);
      return { ...sale };
    },
    async createAuthUser(email, metadata, ...rest: unknown[]) {
      record("createAuthUser", [email, metadata, ...rest]);
      if ([...auth.values()].some((u) => u.email === email)) {
        return { error: "email_exists" };
      }
      const id = `user-new-${nextId++}`;
      const extra = rest[0] as { password?: string } | undefined;
      auth.set(id, {
        id,
        email,
        password: extra?.password,
        banned: false,
        metadata: metadata as Record<string, unknown>,
      });
      // The auth.users trigger creates a plain operator row.
      const saleId = String(nextId++);
      sales.set(saleId, {
        id: saleId,
        user_id: id,
        email,
        administrator: false,
        role: "operator",
        disabled: false,
      });
      return { userId: id };
    },
    async findAuthUserIdByEmail(email) {
      record("findAuthUserIdByEmail", [email]);
      return [...auth.values()].find((u) => u.email === email)?.id ?? null;
    },
    async insertSale(saleRecord) {
      record("insertSale", [saleRecord]);
      const id = String(nextId++);
      sales.set(id, { ...saleRecord, id });
      return sales.get(id)!;
    },
    async inviteUserByEmail(email) {
      record("inviteUserByEmail", [email]);
      return { ok: !options.failInvite };
    },
    async deleteSaleByUserId(userId) {
      record("deleteSaleByUserId", [userId]);
      const sale = saleOf(userId);
      if (sale) sales.delete(String(sale.id));
      return { ok: true };
    },
    async deleteAuthUser(userId) {
      record("deleteAuthUser", [userId]);
      return { ok: auth.delete(userId) };
    },
  };

  const writes = () =>
    calls.filter((c) =>
      [
        "updateAuthUser",
        "updateSale",
        "createAuthUser",
        "insertSale",
        "inviteUserByEmail",
        "deleteSaleByUserId",
        "deleteAuthUser",
      ].includes(c.name),
    );

  return { auth, sales, calls, writes, ports, addUser, saleOf };
}

/** The CRM's usual cast: the active owner, a second administrator, a member. */
function crm(options?: Parameters<typeof world>[0]) {
  const w = world(options);
  const owner = w.addUser({
    id: 1,
    email: "owner@example.test",
    administrator: true,
    role: "owner",
    disabled: false,
  });
  const admin = w.addUser({
    id: 2,
    email: "admin@example.test",
    administrator: true,
    role: "administrator",
    disabled: false,
  });
  const member = w.addUser({
    id: 3,
    email: "member@example.test",
    administrator: false,
    role: "operator",
    disabled: false,
  });
  const disabled = w.addUser(
    {
      id: 4,
      email: "disabled@example.test",
      administrator: false,
      role: "operator",
      disabled: true,
    },
    true,
  );
  return { ...w, owner, admin, member, disabled };
}

describe("patchUser: authorization before any write", () => {
  it("refuses a user editing someone else, and changes nothing", async () => {
    const w = crm();

    const outcome = await patchUser(w.ports, w.member, {
      sales_id: w.admin.id,
      email: "member@example.test",
      first_name: "Taken",
      disabled: true,
    });

    expect(outcome.status).toBe(401);
    expect(w.writes()).toEqual([]);
    expect(w.auth.get(w.admin.user_id)).toMatchObject({
      email: "admin@example.test",
      banned: false,
    });
  });

  it("refuses a CRM administrator changing another user's login email, and changes nothing", async () => {
    // The capture: the administrator's own address on the victim's login,
    // then a password recovery, is a live session as the victim's auth user.
    const w = crm();

    const outcome = await patchUser(w.ports, w.admin, {
      sales_id: w.member.id,
      email: "admin+capture@example.test",
      first_name: "Member",
    });

    expect(outcome.status).toBe(403);
    expect(w.writes()).toEqual([]);
    expect(w.auth.get(w.member.user_id)!.email).toBe("member@example.test");
  });

  it("refuses the active owner changing another user's login email, and changes nothing", async () => {
    const w = crm();

    const outcome = await patchUser(w.ports, w.owner, {
      sales_id: w.member.id,
      email: "owner+capture@example.test",
    });

    expect(outcome.status).toBe(403);
    expect(w.writes()).toEqual([]);
    expect(w.auth.get(w.member.user_id)!.email).toBe("member@example.test");
  });

  it("refuses changing one's own login email through the admin API: GoTrue must confirm it", async () => {
    const w = crm();

    const outcome = await patchUser(w.ports, w.owner, {
      sales_id: w.owner.id,
      email: "owner-new@example.test",
    });

    expect(outcome.status).toBe(403);
    expect(w.writes()).toEqual([]);
    expect(w.auth.get(w.owner.user_id)!.email).toBe("owner@example.test");
  });

  it("refuses a CRM-disabled user lifting their own ban, and changes nothing", async () => {
    const w = crm();

    const outcome = await patchUser(w.ports, w.disabled, {
      sales_id: w.disabled.id,
      email: "disabled@example.test",
      disabled: false,
    });

    expect(outcome.status).toBe(401);
    expect(w.writes()).toEqual([]);
    expect(w.auth.get(w.disabled.user_id)!.banned).toBe(true);
    expect(w.sales.get("4")!.disabled).toBe(true);
  });

  it("refuses a CRM-disabled administrator acting on anyone", async () => {
    const w = crm();
    w.sales.get(String(w.admin.id))!.disabled = true;

    const outcome = await patchUser(w.ports, w.sales.get("2")!, {
      sales_id: w.member.id,
      first_name: "Renamed",
    });

    expect(outcome.status).toBe(401);
    expect(w.writes()).toEqual([]);
  });

  it("refuses anyone but the active owner changing a role or the disabled flag", async () => {
    const w = crm();

    const promote = await patchUser(w.ports, w.member, {
      sales_id: w.member.id,
      administrator: true,
    });
    const disable = await patchUser(w.ports, w.admin, {
      sales_id: w.member.id,
      disabled: true,
    });

    expect([promote.status, disable.status]).toEqual([403, 403]);
    expect(w.writes()).toEqual([]);
    expect(w.auth.get(w.member.user_id)!.banned).toBe(false);
  });
});

describe("patchUser: what stays allowed", () => {
  it("lets a user rename themselves when the form resends their unchanged email and flags", async () => {
    const w = crm();

    const outcome = await patchUser(w.ports, w.member, {
      sales_id: w.member.id,
      email: " Member@Example.Test ",
      first_name: "Mia",
      last_name: "Member",
      administrator: false,
      disabled: false,
    });

    expect(outcome.status).toBe(200);
    expect(w.auth.get(w.member.user_id)).toMatchObject({
      email: "member@example.test",
      banned: false,
      metadata: { first_name: "Mia", last_name: "Member" },
    });
  });

  it("lets the active owner disable another user and change their role, in one sales statement", async () => {
    const w = crm();

    const outcome = await patchUser(w.ports, w.owner, {
      sales_id: w.member.id,
      email: "member@example.test",
      administrator: true,
      disabled: true,
    });

    expect(outcome.status).toBe(200);
    expect(w.auth.get(w.member.user_id)!.banned).toBe(true);
    expect(w.sales.get("3")).toMatchObject({
      administrator: true,
      role: "owner",
      disabled: true,
    });
    expect(w.calls.filter((c) => c.name === "updateSale")).toHaveLength(1);
  });

  it("never sends an email or a password to the Auth admin API", async () => {
    const w = crm();

    await patchUser(w.ports, w.owner, {
      sales_id: w.member.id,
      email: "member@example.test",
      first_name: "Mia",
      disabled: true,
    });
    await patchUser(w.ports, w.admin, {
      sales_id: w.member.id,
      email: "member@example.test",
      last_name: "Renamed",
    });

    const sent = w.calls
      .filter((c) => c.name === "updateAuthUser")
      .map((c) => c.args[1] as Record<string, unknown>);
    expect(sent).toHaveLength(2);
    for (const attributes of sent) {
      expect(attributes).not.toHaveProperty("email");
      expect(attributes).not.toHaveProperty("password");
    }
    // Only the owner's call touches the ban.
    expect(sent.map((a) => "ban_duration" in a)).toEqual([true, false]);
    expect(sent[0].ban_duration).toBe(DISABLED_BAN);
  });
});

describe("inviteUser: no owner-chosen password, no half-created account", () => {
  it("refuses anyone but the active owner before creating anything", async () => {
    const w = crm();

    const outcome = await inviteUser(w.ports, w.admin, {
      email: "new@example.test",
    });

    expect(outcome.status).toBe(401);
    expect(w.writes()).toEqual([]);
  });

  it("refuses an owner-chosen initial password before creating anything", async () => {
    const w = crm();

    const outcome = await inviteUser(w.ports, w.owner, {
      email: "new@example.test",
      password: "chosen-by-the-owner",
    });

    expect(outcome.status).toBe(400);
    expect(w.writes()).toEqual([]);
    expect(
      [...w.auth.values()].some((u) => u.email === "new@example.test"),
    ).toBe(false);
  });

  it("creates the account with no password, sets its flags in one statement, then invites", async () => {
    const w = crm();

    const outcome = await inviteUser(w.ports, w.owner, {
      email: "new@example.test",
      first_name: "New",
      administrator: true,
    });

    expect(outcome.status).toBe(200);
    const created = w.calls.find((c) => c.name === "createAuthUser")!;
    expect(created.args).toHaveLength(2);
    expect(JSON.stringify(created.args)).not.toContain("password");
    expect(outcome.body.data).toMatchObject({
      administrator: true,
      role: "owner",
      disabled: false,
    });
    expect(w.calls.map((c) => c.name).slice(-2)).toEqual([
      "updateSale",
      "inviteUserByEmail",
    ]);
  });

  it("removes the account it created when the invitation fails", async () => {
    const w = crm({ failInvite: true });

    const outcome = await inviteUser(w.ports, w.owner, {
      email: "new@example.test",
      administrator: true,
    });

    expect(outcome.status).toBe(500);
    expect(
      [...w.auth.values()].some((u) => u.email === "new@example.test"),
    ).toBe(false);
    expect(
      [...w.sales.values()].some((s) => s.email === "new@example.test"),
    ).toBe(false);
  });

  it("removes the account it created when its flags cannot be set, and sends no invitation", async () => {
    const w = crm({ failSaleUpdate: true });

    const outcome = await inviteUser(w.ports, w.owner, {
      email: "new@example.test",
      administrator: true,
    });

    expect(outcome.status).toBe(500);
    expect(w.calls.some((c) => c.name === "inviteUserByEmail")).toBe(false);
    expect(
      [...w.auth.values()].some((u) => u.email === "new@example.test"),
    ).toBe(false);
  });

  it("gives an existing auth user a CRM profile only, with a consistent role, and never touches its login", async () => {
    const w = crm();
    w.auth.set("user-orphan", {
      id: "user-orphan",
      email: "orphan@example.test",
      banned: false,
      metadata: {},
    });

    const outcome = await inviteUser(w.ports, w.owner, {
      email: "orphan@example.test",
      administrator: false,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.data).toMatchObject({
      user_id: "user-orphan",
      administrator: false,
      role: "operator",
    });
    expect(w.calls.some((c) => c.name === "updateAuthUser")).toBe(false);
    expect(w.auth.get("user-orphan")!.password).toBeUndefined();
  });

  it("refuses a second CRM profile for an auth user that already has one", async () => {
    const w = crm();

    const outcome = await inviteUser(w.ports, w.owner, {
      email: "member@example.test",
    });

    expect(outcome.status).toBe(400);
    expect(w.calls.some((c) => c.name === "insertSale")).toBe(false);
  });
});

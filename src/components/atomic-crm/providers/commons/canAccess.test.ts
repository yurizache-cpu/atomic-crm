import { describe, expect, it } from "vitest";
import { canAccess } from "./canAccess";

// This gate had NO test while it ended in `return true`. The rule it now
// enforces — unknown resource denied — is the one the whole platform's
// security posture rests on, so it is pinned here first.

const read = (resource: string) => ({ action: "list", resource });

describe("canAccess", () => {
  describe("admin", () => {
    it("reaches every resource, including ones that do not exist yet", () => {
      for (const resource of ["contacts", "sales", "configuration", "ops_agents"]) {
        expect(canAccess("admin", read(resource))).toBe(true);
      }
    });
  });

  describe("non-admin", () => {
    it.each([
      "companies",
      "companies_summary",
      "contacts",
      "contacts_summary",
      "contact_notes",
      "deals",
      "deal_notes",
      "tags",
      "tasks",
      "lead_profiles",
      "acquisition_attributions",
      "loss_reasons",
    ])("reaches the CRM resource %s", (resource) => {
      expect(canAccess("operator", read(resource))).toBe(true);
    });

    it.each(["sales", "configuration"])("is denied %s", (resource) => {
      expect(canAccess("operator", read(resource))).toBe(false);
    });

    // The regression that matters: every one of these was ALLOWED before,
    // because the function ended in `return true`.
    it.each([
      ["a future engine resource", "ops_agents"],
      ["an audit log", "ops_audit_log"],
      ["an approvals queue", "ops_approvals"],
      ["a cost ledger", "ops_agent_runs"],
      ["a typo'd resource name", "contactss"],
      ["an empty resource name", ""],
      ["a storage bucket name", "attachments"],
    ])("denies %s", (_label, resource) => {
      expect(canAccess("operator", read(resource))).toBe(false);
    });

    it("denies an unknown resource for every action, not just reads", () => {
      for (const action of ["list", "show", "create", "edit", "delete"]) {
        expect(canAccess("operator", { action, resource: "ops_agents" })).toBe(
          false,
        );
      }
    });
  });

  describe("unknown role", () => {
    it("gets the non-admin allow-list, never admin access", () => {
      expect(canAccess("", read("contacts"))).toBe(true);
      expect(canAccess("", read("sales"))).toBe(false);
      expect(canAccess("banana", read("ops_agents"))).toBe(false);
    });
  });
});

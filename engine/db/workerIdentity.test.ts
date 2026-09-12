// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertWorkerIdentity,
  WorkerIdentityError,
  type WorkerIdentity,
} from "./workerIdentity.ts";

const identity = (over: Partial<WorkerIdentity> = {}): WorkerIdentity => ({
  user: "ops_worker_login",
  isSuperuser: false,
  bypassesRls: false,
  isOpsWorkerMember: true,
  ...over,
});

describe("the boot gate on the worker's database identity", () => {
  it("accepts the constrained login role", () => {
    expect(() => assertWorkerIdentity(identity())).not.toThrow();
  });

  it("refuses postgres", () => {
    // This is the failure that is invisible at runtime: every job would run,
    // every query would succeed, and RLS would be off.
    expect(() => assertWorkerIdentity(identity({ user: "postgres" }))).toThrow(
      WorkerIdentityError,
    );
  });

  it("refuses service_role", () => {
    expect(() =>
      assertWorkerIdentity(identity({ user: "service_role" })),
    ).toThrow(/administrative identity/);
  });

  it("refuses supabase_admin", () => {
    expect(() =>
      assertWorkerIdentity(identity({ user: "supabase_admin" })),
    ).toThrow(WorkerIdentityError);
  });

  it("refuses a superuser whatever it is called", () => {
    expect(() =>
      assertWorkerIdentity(identity({ user: "sneaky", isSuperuser: true })),
    ).toThrow(/SUPERUSER/);
  });

  it("refuses BYPASSRLS whatever it is called", () => {
    // The measured shape: on Supabase, `postgres` is rolsuper = false but
    // rolbypassrls = true. Checking only for superuser would have passed it.
    expect(() =>
      assertWorkerIdentity(identity({ user: "sneaky", bypassesRls: true })),
    ).toThrow(/BYPASSRLS/);
  });

  it("refuses a role that cannot assume ops_worker", () => {
    expect(() =>
      assertWorkerIdentity(identity({ isOpsWorkerMember: false })),
    ).toThrow(/not a member of ops_worker/);
  });

  it("names every problem at once, so one fix does not reveal the next", () => {
    let message = "";
    try {
      assertWorkerIdentity(
        identity({
          user: "postgres",
          isSuperuser: true,
          bypassesRls: true,
          isOpsWorkerMember: false,
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/administrative identity/);
    expect(message).toMatch(/SUPERUSER/);
    expect(message).toMatch(/BYPASSRLS/);
    expect(message).toMatch(/not a member/);
  });

  it("points at the provisioning script rather than just complaining", () => {
    expect(() => assertWorkerIdentity(identity({ user: "postgres" }))).toThrow(
      /provision-worker-role/,
    );
  });
});

import { CompanyOsApiError } from "../../../contracts/company-os-api/index.ts";
import { contextKey, dataKey } from "../query/keys";
import { createFakeSession } from "../testing/fakeSession";
import { TENANT_A, USER_A, USER_B, syntheticId } from "../testing/samples";
import { createAccessController } from "./accessController";

// The branches of the access controller the shell's browser tests cannot
// reach on demand: a refusal that arrives from a generation already replaced,
// the resolver's OS409, and reads answering in a chosen order after an OS403.
// Answers are fed through the controller's own query cache, the path a real
// query takes.

const PRINCIPAL = syntheticId(201);

const fail = (code: "OS401" | "OS403" | "OS409") => () =>
  Promise.reject(new CompanyOsApiError("overview", code));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const startedAsA = async () => {
  const controller = createAccessController(createFakeSession(USER_A).port);
  const stop = controller.start();
  await settle();
  return { controller, stop };
};

const fetchFailing = async (
  controller: ReturnType<typeof createAccessController>,
  queryKey: readonly unknown[],
  code: "OS401" | "OS403" | "OS409",
) => {
  await controller.queryClient
    .fetchQuery({ queryKey, queryFn: fail(code), retry: false })
    .catch(() => undefined);
  await settle();
};

const fetchSucceeding = async (
  controller: ReturnType<typeof createAccessController>,
  queryKey: readonly unknown[],
) => {
  await controller.queryClient.fetchQuery({
    queryKey,
    queryFn: async () => ({ v: 1 }),
  });
  await settle();
};

describe("the Company OS access controller", () => {
  it("treats two active memberships (OS409 from operator_context) as no access", async () => {
    const { controller, stop } = await startedAsA();

    await fetchFailing(controller, contextKey(USER_A.userId, 1), "OS409");

    expect(controller.getState()).toEqual({
      status: "no-access",
      userId: USER_A.userId,
      reason: "membership",
    });
    stop();
  });

  it("ends in no access when the refused read is refused again after the re-read, whatever other reads succeed meanwhile", async () => {
    const { controller, stop } = await startedAsA();
    controller.bindTenant(1, TENANT_A, PRINCIPAL);
    const first = {
      userId: USER_A.userId,
      epoch: 1,
      tenantId: TENANT_A,
      principalId: PRINCIPAL,
    };
    await fetchFailing(controller, dataKey(first, "list_agents", {}), "OS403");
    controller.bindTenant(2, TENANT_A, PRINCIPAL);
    const second = { ...first, epoch: 2 };

    await fetchSucceeding(controller, dataKey(second, "list_tasks", {}));
    await fetchFailing(controller, dataKey(second, "list_agents", {}), "OS403");

    expect(controller.getState()).toEqual({
      status: "no-access",
      userId: USER_A.userId,
      reason: "read-refused",
    });
    expect(controller.queryClient.getQueryCache().getAll()).toEqual([]);
    stop();
  });

  it("re-reads once more for a later OS403 once the refused read has succeeded again", async () => {
    const { controller, stop } = await startedAsA();
    controller.bindTenant(1, TENANT_A, PRINCIPAL);
    const first = {
      userId: USER_A.userId,
      epoch: 1,
      tenantId: TENANT_A,
      principalId: PRINCIPAL,
    };
    await fetchFailing(controller, dataKey(first, "list_agents", {}), "OS403");
    controller.bindTenant(2, TENANT_A, PRINCIPAL);
    const second = { ...first, epoch: 2 };

    await fetchSucceeding(controller, dataKey(second, "list_agents", {}));
    await fetchFailing(controller, dataKey(second, "list_tasks", {}), "OS403");

    expect(controller.getState()).toEqual({
      status: "signed-in",
      userId: USER_A.userId,
      epoch: 3,
      tenantId: null,
      principalId: null,
    });
    stop();
  });

  it("ignores a refusal from a generation it already replaced", async () => {
    const { controller, stop } = await startedAsA();
    controller.bindTenant(1, TENANT_A, PRINCIPAL);
    const staleScope = {
      userId: USER_A.userId,
      epoch: 1,
      tenantId: TENANT_A,
      principalId: PRINCIPAL,
    };
    await fetchFailing(
      controller,
      dataKey(staleScope, "overview", {}),
      "OS403",
    );
    const afterReRead = controller.getState();

    await fetchFailing(
      controller,
      dataKey(staleScope, "list_agents", {}),
      "OS401",
    );

    expect(afterReRead).toEqual({
      status: "signed-in",
      userId: USER_A.userId,
      epoch: 2,
      tenantId: null,
      principalId: null,
    });
    expect(controller.getState()).toBe(afterReRead);
    stop();
  });

  it("clears the cache and starts a new epoch when operator_context reports another principal for the same tenant", async () => {
    const { controller, stop } = await startedAsA();
    controller.bindTenant(1, TENANT_A, PRINCIPAL);
    controller.queryClient.setQueryData(contextKey(USER_A.userId, 1), {});

    controller.bindTenant(1, TENANT_A, syntheticId(202));

    expect(controller.getState()).toEqual({
      status: "signed-in",
      userId: USER_A.userId,
      epoch: 2,
      tenantId: null,
      principalId: null,
    });
    expect(controller.queryClient.getQueryCache().getAll()).toEqual([]);
    stop();
  });

  it.each([
    "TOKEN_REFRESHED",
    "USER_UPDATED",
    "INITIAL_SESSION",
    "SIGNED_IN",
  ] as const)(
    "stays signed out after a sign-out the server refused, when %s arrives for the same user",
    async (event) => {
      const session = createFakeSession(USER_A);
      session.onSignOut(() => {
        throw new Error("synthetic network failure");
      });
      const controller = createAccessController(session.port);
      const stop = controller.start();
      await settle();

      await controller.signOut();
      session.emit(event, USER_A);
      await settle();

      expect(controller.getState()).toEqual({
        status: "signed-out",
        signOutFailed: true,
      });
      stop();
    },
  );

  it("signs in again after a sign-out only for a new sign-in of another user", async () => {
    const session = createFakeSession(USER_A);
    const controller = createAccessController(session.port);
    const stop = controller.start();
    await settle();
    await controller.signOut();

    session.emit("SIGNED_IN", USER_B);
    await settle();

    expect(controller.getState()).toMatchObject({
      status: "signed-in",
      userId: USER_B.userId,
    });
    stop();
  });

  it("clears the cache and forgets the tenant when it stops", async () => {
    const { controller, stop } = await startedAsA();
    controller.bindTenant(1, TENANT_A, PRINCIPAL);
    controller.queryClient.setQueryData(contextKey(USER_A.userId, 1), {});

    stop();

    expect(controller.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(controller.getState()).toEqual({ status: "checking" });
  });
});

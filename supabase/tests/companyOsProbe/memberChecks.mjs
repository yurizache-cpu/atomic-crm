// What a signed-in member of the probe's tenant A reads, what a foreign id
// answers, and the final sweep over every answer the member received
// (supabase/tests/companyOsApiExposure.mjs).

import { createHash, randomUUID } from "node:crypto";
import {
  ABSENT_ACTS,
  ACTOR,
  CATALOGUE,
  CONTENT,
  PRICE,
  SENTINELS,
  SOURCE,
  check,
  countRequest,
  expectAnswer,
  refusalBody,
} from "./common.mjs";

/** The member resolves through supabase-js and fetch, and reads every function. */
export async function memberResolves(t) {
  const { ids } = t;
  const sdk = await t.member.client
    .schema("company_os_api")
    .rpc("operator_context");
  countRequest();
  check(
    !sdk.error &&
      sdk.data?.tenant?.id === t.tenantA &&
      sdk.data?.principal?.id === t.principalId &&
      sdk.data?.role === "tenant_operator",
    `member: supabase-js operator_context did not resolve to the granted principal and tenant (${sdk.error?.code ?? sdk.status})`,
  );
  check(
    sdk.data?.allowedActions?.decideReview === true &&
      sdk.data?.allowedActions?.tripStop === false,
    "member: operator_context does not report exactly the review decision as allowed",
  );

  const answers = {};
  for (const fn of CATALOGUE) {
    answers[fn] = await t.read(fn, t.argsFor(fn));
  }
  await t.read("list_reviews", { p_status: "accepted" });
  const decided = await t.read("get_review", {
    p_review_id: ids.review_decided,
  });
  const stops = await t.read("list_stops", { p_include_cleared: true });
  await t.read("list_events", {
    p_subject_type: "task",
    p_subject_id: ids.task_a,
  });
  const runEvents = await t.read("list_events", {
    p_subject_type: "agent_run",
    p_subject_id: ids.run_a,
  });

  // Positive controls: the sweep reads real data, not empty pages.
  check(
    (answers.list_agents?.items ?? []).some(
      (agent) => agent.id === ids.agent_a,
    ),
    "member: list_agents does not report the tenant's agent; the sweep would read nothing",
  );
  checkRun(t, answers);
  check(
    answers.get_review?.agentRunId === ids.run_a &&
      answers.get_review?.status === "pending",
    "member: get_review does not return the review opened from the planted run",
  );
  check(
    (runEvents?.items ?? []).length > 0 &&
      runEvents.items.every((event) => event.source === "other"),
    "member: list_events for the planted run does not report its events with the caller-supplied source as other",
  );
  checkStops(ids, stops);
  // Legacy fixture A's task: admitted as a synthetic lead, its review opened
  // from a succeeded run and decided, and the send requested on that review.
  const task = await t.read("get_task", { p_task_id: ids.task_admitted });
  check(
    task?.inbound?.sourceKind === "synthetic" &&
      task?.inbound?.doNotContact === false &&
      task?.review?.id === ids.review_decided &&
      task?.review?.agentRunId === ids.run_decided &&
      task?.review?.status === "accepted",
    "member: get_task does not return the admitted lead's admission and its decided review",
  );
  check(
    task?.outbound?.id === ids.outbound_a &&
      task?.outbound?.status === "authorized" &&
      !("requestedBy" in task.outbound),
    "member: get_task does not return the task's send, or returns it with a requestedBy key",
  );
  check(
    decided?.decisionNote === CONTENT.decisionNote &&
      decided?.status === "accepted",
    "member: get_review does not return the decided review's note as content",
  );
  check(
    answers.get_review_advice?.withheld === "origin_not_synthetic_or_test",
    `member: get_review_advice with no admission returned ${answers.get_review_advice?.withheld ?? "advice"}, expected withheld origin_not_synthetic_or_test`,
  );
}

/** The planted run, in list_runs and in full through get_run. */
function checkRun(t, answers) {
  const { ids } = t;
  check(
    (answers.list_runs?.items ?? []).some(
      (run) => run.id === ids.run_a && run.status === "succeeded",
    ),
    "member: list_runs does not report the planted run; the sweep would read no run",
  );
  const run = answers.get_run;
  check(
    run?.id === ids.run_a &&
      run?.status === "succeeded" &&
      run?.provider === PRICE.provider &&
      run?.chargedCost !== null &&
      run?.chargedCost !== undefined,
    "member: get_run does not return the planted succeeded run with its cost",
  );
  check(
    run?.job?.status === "succeeded" &&
      run?.job?.attempts === 1 &&
      run?.jobSteps?.length === 1 &&
      run.jobSteps[0].step === "job_leased" &&
      run.jobSteps[0].attempt === 1,
    "member: get_run does not return the planted run's job and its one leased step",
  );
  check(
    run?.coveringStop?.id === ids.stop_a,
    "member: get_run does not report the agent stop that covers the planted run",
  );
}

/** The active and the cleared stop: reasons as content, no actor label. */
function checkStops(ids, stops) {
  const items = stops?.items ?? [];
  check(
    items.some(
      (stop) => stop.id === ids.stop_a && stop.reason === CONTENT.stopReason,
    ),
    "member: list_stops does not return the tenant's stop with its reason as content",
  );
  const cleared = items.find((stop) => stop.id === ids.stop_cleared);
  check(
    cleared?.reason === CONTENT.drillReason &&
      cleared?.clearedReason === CONTENT.clearedReason &&
      typeof cleared?.clearedAt === "string",
    "member: list_stops with p_include_cleared does not return the cleared stop with its reasons as content",
  );
  check(
    items.every((stop) => !("trippedBy" in stop) && !("clearedBy" in stop)),
    "member: list_stops carries a trippedBy or clearedBy key",
  );
}

/**
 * A foreign id answers exactly like a random one: for each selector, a tenant
 * B id of the SAME kind, and wrong-kind ids as additional cases; the same for
 * the list filters and a cursor naming a tenant B row.
 */
const FOREIGN_CASES = (ids) => [
  ["get_agent", "p_agent_id", ids.agent_b],
  ["get_task", "p_task_id", ids.task_b],
  ["get_run", "p_run_id", ids.run_b],
  ["get_review", "p_review_id", ids.review_b],
  ["get_review_advice", "p_review_id", ids.review_b],
  // Wrong kinds, of tenant B.
  ["get_agent", "p_agent_id", ids.task_b],
  ["get_task", "p_task_id", ids.company_b],
  ["get_run", "p_run_id", ids.agent_b],
  ["get_review", "p_review_id", ids.run_b],
];
// Each list case: the arguments naming a row, the tenant B row, the tenant A
// row of the same kind (a positive control: the same arguments naming the
// caller's own row succeed, so the refusal is the tenancy, never a malformed
// argument), and the one refusal a random row gets. A missing filter row is
// not found; a missing cursor row is the gate's one fixed OS400, exactly like
// a malformed cursor, which is why the positive control matters there.
const NOT_FOUND = ["OS404", "not found"];
const RESTART = ["OS400", "bad request"];
const FOREIGN_LIST_CASES = (ids) => [
  [
    "list_runs",
    (id) => ({ p_agent_id: id }),
    ids.agent_b,
    ids.agent_a,
    NOT_FOUND,
  ],
  [
    "list_tasks",
    (id) => ({ p_agent_id: id }),
    ids.agent_b,
    ids.agent_a,
    NOT_FOUND,
  ],
  [
    "list_events",
    (id) => ({ p_subject_type: "task", p_subject_id: id }),
    ids.task_b,
    ids.task_a,
    NOT_FOUND,
  ],
  [
    "list_runs",
    (id) => ({ p_cursor: `rn1:${id}` }),
    ids.run_b,
    ids.run_a,
    RESTART,
  ],
  [
    "list_reviews",
    (id) => ({ p_cursor: `rv1:${id}` }),
    ids.review_b,
    ids.review_pending,
    RESTART,
  ],
  [
    "list_tasks",
    (id) => ({ p_cursor: `tk1:${id}` }),
    ids.task_b,
    ids.task_a,
    RESTART,
  ],
];

/** Foreign equals missing; no context argument, extra key or act matches. */
export async function contextArgumentsMatchNothing(t, rpc) {
  const { ids, member } = t;
  for (const [fn, name, foreign] of FOREIGN_CASES(ids)) {
    const random = await rpc(fn, { [name]: randomUUID() }, member.credential);
    const other = await rpc(fn, { [name]: foreign }, member.credential);
    const notFound = refusalBody("OS404", fn, "not found");
    expectAnswer(random, 400, notFound, `member: ${fn} on a random id`);
    check(
      other.status === random.status && other.text === random.text,
      `member: ${fn} on another tenant's id is distinguishable from a random id`,
    );
  }
  for (const [fn, argsOf, foreign, own, [code, text]] of FOREIGN_LIST_CASES(
    ids,
  )) {
    const names = Object.keys(argsOf(foreign)).join(", ");
    await t.read(fn, argsOf(own));
    const random = await rpc(fn, argsOf(randomUUID()), member.credential);
    const other = await rpc(fn, argsOf(foreign), member.credential);
    expectAnswer(
      random,
      400,
      refusalBody(code, fn, text),
      `member: ${fn} with ${names} naming a random row`,
    );
    check(
      other.status === random.status && other.text === random.text,
      `member: ${fn} with ${names} naming another tenant's row is distinguishable from a random one`,
    );
  }
  for (const [fn, body] of [
    ["operator_context", { p_tenant_id: t.tenantA }],
    ["operator_context", { tenant_id: t.tenantA }],
    ["overview", { p_actor: `principal:${t.principalId}` }],
    ["list_tasks", { p_limit: 5, p_tenant_id: t.tenantA }],
    ["get_agent", { p_agent_id: ids.agent_a, p_company_id: ids.company_a }],
    ["list_reviews", { p_status: "pending", p_reviewer: ACTOR }],
    ["list_events", { p_source: SOURCE }],
  ]) {
    const answer = await rpc(fn, body, member.credential);
    expectAnswer(
      answer,
      404,
      "PGRST202",
      `member: ${fn} with ${Object.keys(body).join(", ")}`,
    );
  }
  // The trip does not exist before S8, under any argument shape.
  for (const [act, names] of Object.entries(ABSENT_ACTS)) {
    const nulls = Object.fromEntries(names.map((name) => [name, null]));
    for (const body of [{}, nulls]) {
      const answer = await rpc(act, body, member.credential);
      expectAnswer(answer, 404, "PGRST202", `member: ${act}`);
    }
  }
}

/** Every value no answer to the member may carry, by what it is. */
function forbiddenValues(t) {
  const hash = (value) =>
    createHash("sha256").update(value.toLowerCase()).digest("hex");
  const { ids, values } = t;
  return new Map([
    ["the member's email", t.member.email],
    ["the member's changed email", t.movedEmail],
    ["the SHA-256 of the member's email", hash(t.member.email)],
    ["the SHA-256 of the changed email", hash(t.movedEmail)],
    ["the auth user id", t.member.userId],
    ["an access token", t.member.credential.bearer],
    ["the principal's display name", SENTINELS.display],
    ["a task title", SENTINELS.taskTitle],
    ["a task body", SENTINELS.taskBody],
    ["an agent's role", SENTINELS.agentRole],
    ["an agent's description", SENTINELS.agentDescription],
    ["a reply draft", SENTINELS.draft],
    ["a run result's summary", SENTINELS.runSummary],
    ["a run result's next action", SENTINELS.runNextAction],
    ["a run's requested_by label", SENTINELS.runRequester],
    ["a run's idempotency key", values.runKeyA],
    ["a run's request fingerprint", values.runFingerprintA],
    ["a run's input fingerprint", values.inputFingerprintA],
    ["a run's correlation id", values.correlationA],
    ["a provider request id", values.providerRequestA],
    ["a provider response id", values.providerResponseA],
    ["a job id", ids.job_a],
    ["a job's idempotency key", values.jobKeyA],
    ["an admitted lead's body", SENTINELS.admittedBody],
    ["an admission's external message id", values.admissionMessage],
    ["an admission's contact reference", values.admissionContact],
    ["the decided run's idempotency key", values.runKeyDecided],
    ["the decided run's request fingerprint", values.runFingerprintDecided],
    ["the decided run's input fingerprint", values.inputFingerprintDecided],
    ["the decided run's correlation id", values.correlationDecided],
    ["the decided run's provider request id", values.providerRequestDecided],
    ["the decided run's provider response id", values.providerResponseDecided],
    ["the decided run's job id", ids.job_decided],
    ["the decided run's job idempotency key", values.jobKeyDecided],
    ["a job's lease owner", SENTINELS.leaseOwner],
    ["a job's raw error", SENTINELS.jobError],
    ["a job step's detail", SENTINELS.jobEventDetail],
    ["a price id", ids.price_a],
    ["a price's source", SENTINELS.priceSource],
    ["a price's recorded_by label", SENTINELS.priceRecorder],
    ["a reviewer label", SENTINELS.reviewer],
    ["a tripped_by label", SENTINELS.tripper],
    ["a cleared_by label", SENTINELS.clearer],
    ["a requested_by label", SENTINELS.requester],
    ["a configured_by label", SENTINELS.configurer],
    ["a provider target", values.providerTarget],
    ["a contact reference", values.contactRef],
    ["a caller-supplied event source", SOURCE],
    ["tenant B's id", t.tenantB],
    ["tenant B's name", SENTINELS.tenantB],
    ["tenant B's company", ids.company_b],
    ["tenant B's company name", SENTINELS.companyB],
    ["tenant B's department", ids.department_b],
    ["tenant B's agent", ids.agent_b],
    ["tenant B's agent name", SENTINELS.agentB],
    ["tenant B's task", ids.task_b],
    ["tenant B's task title", SENTINELS.taskTitleB],
    ["tenant B's task body", SENTINELS.taskBodyB],
    ["tenant B's run", ids.run_b],
    ["tenant B's run key", values.runKeyB],
    ["tenant B's run correlation id", values.correlationB],
    ["tenant B's review", ids.review_b],
    ...(t.lender ? [["the tenant that lent the flag", t.lender]] : []),
  ]);
}

/** No answer to the member carried what it must never carry. */
export function sweepMemberOutputs(t) {
  const forbidden = forbiddenValues(t);
  for (const { fn, text } of t.outputs) {
    for (const [label, value] of forbidden) {
      check(!text.includes(value), `member: ${fn} carries ${label}`);
    }
  }
  check(
    t.outputs.some(({ text }) => text.includes(t.ids.agent_a)) &&
      t.outputs.some(({ text }) => text.includes(t.ids.run_a)) &&
      t.outputs.some(({ text }) => text.includes(CONTENT.stopReason)),
    "the member's answers carry none of the tenant's own data; the sweep proves nothing",
  );
}

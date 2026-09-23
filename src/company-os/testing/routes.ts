import type { RenderResult } from "vitest-browser-react";

import { recorded, rid } from "./recorded";
import { goTo } from "./renderCompanyOs";

// Every page of the Company OS, list and detail, with text that shows its
// recorded answer has rendered (not just its heading): the cross-screen sweeps
// (read-only controls, storage sentinel) visit each one in turn. Every marker
// is a value the real projection returned (testing/recorded/).

export interface RouteVisit {
  readonly hash: string;
  /** The page's h1. */
  readonly heading: string;
  /** Exact texts that appear only once the page's reads have answered. */
  readonly markers: readonly string[];
}

/** The pending review whose structured advice the sweeps open. */
export const ADVICE_REVIEW = rid("review:opened");

const adviceSummary = (): string => {
  const advice = recorded("get_review_advice", {
    p_review_id: ADVICE_REVIEW,
  });
  if (!("summary" in advice))
    throw new Error("The recorded advice is withheld.");
  return advice.summary;
};

export const EVERY_ROUTE: readonly RouteVisit[] = [
  { hash: "#/company-os", heading: "Overview", markers: ["Reviews pending"] },
  {
    hash: "#/company-os/activity",
    heading: "Activity",
    markers: [
      "communication.outbound_failed",
      "Synthetic pause of the follow-up desk",
    ],
  },
  {
    hash: `#/company-os/activity/task/${rid("task:succeeded")}`,
    heading: "Task chain",
    markers: ["communication.received", "agent_run.succeeded", "job leased"],
  },
  {
    hash: `#/company-os/activity/run/${rid("run:succeeded")}`,
    heading: "Run chain",
    markers: ["agent_run.started", "job leased"],
  },
  {
    hash: "#/company-os/tasks",
    heading: "Tasks",
    markers: [rid("task:succeeded")],
  },
  {
    hash: `#/company-os/tasks/${rid("task:accepted-1")}`,
    heading: "Task",
    markers: ["Synthetic test line", "131047"],
  },
  {
    hash: "#/company-os/agents",
    heading: "Agents",
    markers: ["Lead Triage", "Queue Desk"],
  },
  {
    hash: `#/company-os/agents/${rid("agent:lead-triage")}`,
    heading: "Agent",
    markers: [rid("run:indeterminate")],
  },
  {
    hash: "#/company-os/runs",
    heading: "Agent runs",
    markers: [rid("run:failed")],
  },
  {
    hash: `#/company-os/runs/${rid("run:held")}`,
    heading: "Agent run",
    markers: ["job deferred"],
  },
  {
    hash: "#/company-os/reviews",
    heading: "Reviews",
    markers: [rid("review:opened")],
  },
  ...(["accepted", "rejected", "needs_edit"] as const).map((status) => ({
    hash: `#/company-os/reviews?status=${status}`,
    heading: "Reviews",
    markers: [
      rid(
        {
          accepted: "review:accepted-1",
          rejected: "review:not-pinned",
          needs_edit: "review:invalid",
        }[status],
      ),
    ],
  })),
  {
    hash: `#/company-os/reviews/${rid("review:accepted-1")}`,
    heading: "Review",
    markers: ["Call back tomorrow"],
  },
  {
    hash: `#/company-os/reviews/${ADVICE_REVIEW}`,
    heading: "Review",
    markers: ["rejected, needs edit"],
  },
  {
    hash: "#/company-os/stops",
    heading: "Execution stops",
    markers: ["Synthetic pause of the follow-up desk"],
  },
  {
    hash: "#/company-os/stops?include=cleared",
    heading: "Execution stops",
    markers: ["Drill over", "Synthetic annex pause"],
  },
  {
    hash: "#/company-os/costs",
    heading: "Costs",
    markers: ["100000.000000 USD", "dbtest-cos-contract-model"],
  },
  {
    hash: "#/company-os/communications",
    heading: "Communications status",
    markers: ["Synthetic test line", "Production line"],
  },
];

/** Navigates the mounted module to `route` and waits for its data. */
export const visit = async (screen: RenderResult, route: RouteVisit) => {
  if (window.location.hash !== route.hash) goTo(route.hash);
  await expect
    .element(
      screen.getByRole("heading", {
        name: route.heading,
        exact: true,
        level: 1,
      }),
    )
    .toBeVisible();
  for (const marker of route.markers) {
    await expect
      .element(screen.getByText(marker, { exact: true }).first())
      .toBeVisible();
  }
};

/** Opens the pending review's advice and waits for it. */
export const openAdvice = async (screen: RenderResult) => {
  await screen.getByRole("button", { name: "Show advice" }).click();
  await expect
    .element(screen.getByText(adviceSummary(), { exact: true }))
    .toBeVisible();
};

/** The advice's summary, the one model-written text the sweeps open. */
export const ADVICE_SUMMARY = adviceSummary();

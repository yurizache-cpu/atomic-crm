// The Cloudflare Workers configuration for the static frontend, generated at
// deploy time (Production Hosting, owner decision pending acceptance by account
// creation; docs/PRODUCTION_HOSTING_DECISION_PACKET.md §9).
//
// One assets-only Worker per environment (no script: every request is a static
// asset, free and unlimited on Workers Free), named for its environment so that
// staging and production never share a deployment or a rollback history. It is
// served ONLY on the environment's custom domain: the workers.dev address and
// preview URLs are off, so there is no second public origin to forget.
// Single-page-application fallback serves index.html for a path with no file
// (/set-password, /forgot-password). The headers come from the `_headers` file
// in the build (scripts/host-headers-file.mjs).
//
// Pure, so it is tested without the tool or an account.

export const WORKER_NAME_PREFIX = "clinic-crm";
export const COMPATIBILITY_DATE = "2026-09-01";
export const ENVIRONMENTS = Object.freeze(["staging", "production"]);

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The Wrangler configuration object for one environment. */
export function cloudflareWorkerConfig({
  environment,
  hostname,
  assetsDirectory,
}) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error('the environment must be "staging" or "production"');
  }
  if (typeof hostname !== "string" || !HOSTNAME.test(hostname)) {
    throw new Error(
      "the hostname must be a plain lower-case domain name, such as app.example.org (no scheme, path or port)",
    );
  }
  if (typeof assetsDirectory !== "string" || assetsDirectory === "") {
    throw new Error("the assets directory is required");
  }
  return {
    name: `${WORKER_NAME_PREFIX}-${environment}`,
    compatibility_date: COMPATIBILITY_DATE,
    assets: {
      directory: assetsDirectory,
      not_found_handling: "single-page-application",
    },
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: hostname, custom_domain: true }],
  };
}

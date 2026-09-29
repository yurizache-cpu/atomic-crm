// The production ENVIRONMENT contract (Production Hosting Gate B): what a
// production build, a production worker and a hosted Supabase project must and
// must not carry. Pure functions over already-read facts, tested without a
// network or a database; the commands that read them are
// scripts/production-preflight.mjs and scripts/verify-hosted-supabase.mjs.
//
// A finding is { rule, severity: "blocking" | "advisory", detail }. It names a
// variable or a rule and never a value: a URL or a key is reported by what is
// wrong with it, not by what it is.
//
// No provider is named. A production environment is refused for being local,
// synthetic or over-privileged, wherever it runs.

import { createHash } from "node:crypto";
import { isNonPublicHost } from "./production-contract-host.mjs";
import { scanText } from "./scan-build-artifacts.mjs";

const blocking = (rule, detail) => ({ rule, severity: "blocking", detail });
const advisory = (rule, detail) => ({ rule, severity: "advisory", detail });

/**
 * The `VITE_` variables the application actually reads (audited 2026-09-29
 * against src/, vite.config.ts and deploy.yml): each is meant for a browser.
 * The API URL and the publishable key are public by design; the others are
 * labels and switches.
 */
export const BROWSER_SAFE_VITE_VARIABLES = Object.freeze([
  "VITE_SUPABASE_URL",
  "VITE_SB_PUBLISHABLE_KEY",
  "VITE_IS_DEMO",
  "VITE_INBOUND_EMAIL",
  "VITE_ATTACHMENTS_BUCKET",
  "VITE_DISABLE_EMAIL_PASSWORD_AUTHENTICATION",
  "VITE_GOOGLE_WORKPLACE_DOMAIN",
]);

/**
 * The publishable key every local Supabase stack (CLI) issues, by fingerprint:
 * the same key on every developer machine, so a build that carries it points at
 * a local stack. The key itself is not repeated here.
 */
const LOCAL_PUBLISHABLE_KEY_SHA256 =
  "9705102db0d5f99ee08daa19a73e510d9877a2a9add9369da247cbbe6c2a0140";

/** The claims of a JWT-shaped value, or null. Never verifies: it only reads. */
const jwtClaims = (value) => {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const present = (value) => value !== undefined && value !== "";

/** A URL's hostname, or null when it is not a URL. */
const hostnameOf = (value) => {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

function publishableKeyFindings(key) {
  const findings = [];
  if (key.startsWith("sb_secret_")) {
    findings.push(
      blocking(
        "publishable-key-is-secret",
        "VITE_SB_PUBLISHABLE_KEY holds a secret key (sb_secret_): it would be published to every browser",
      ),
    );
    return findings;
  }
  if (
    createHash("sha256").update(key).digest("hex") ===
    LOCAL_PUBLISHABLE_KEY_SHA256
  ) {
    findings.push(
      blocking(
        "local-publishable-key",
        "VITE_SB_PUBLISHABLE_KEY is the key every local Supabase stack issues: this build points at a development backend",
      ),
    );
  }
  const claims = jwtClaims(key);
  if (claims !== null) {
    if (claims.role !== "anon") {
      findings.push(
        blocking(
          "publishable-key-role",
          `VITE_SB_PUBLISHABLE_KEY is a JWT for role "${String(claims.role)}", not anon`,
        ),
      );
    }
    if (
      typeof claims.iss === "string" &&
      /supabase-demo|127\.0\.0\.1|localhost/.test(claims.iss)
    ) {
      findings.push(
        blocking(
          "local-publishable-key",
          "VITE_SB_PUBLISHABLE_KEY is a JWT issued by a local or demo stack",
        ),
      );
    }
  } else if (!key.startsWith("sb_publishable_")) {
    findings.push(
      blocking(
        "publishable-key-shape",
        "VITE_SB_PUBLISHABLE_KEY is neither an sb_publishable_ key nor an anon JWT",
      ),
    );
  }
  return findings;
}

/**
 * The environment a production BUILD reads (what reaches the browser). `env` is
 * a plain object, normally process.env.
 */
export function auditClientEnvironment(env) {
  const findings = [];

  if (env.VITE_IS_DEMO === "true") {
    findings.push(
      blocking(
        "demo-build",
        "VITE_IS_DEMO is true: a demo build (in-browser fake data, no backend, no second factor) cannot be a production build",
      ),
    );
  }

  const url = env.VITE_SUPABASE_URL;
  if (!present(url)) {
    findings.push(
      blocking(
        "supabase-url-missing",
        "VITE_SUPABASE_URL is not set: the build would ship with no backend",
      ),
    );
  } else {
    const hostname = hostnameOf(url);
    if (hostname === null || new URL(url).protocol !== "https:") {
      findings.push(
        blocking("supabase-url-https", "VITE_SUPABASE_URL is not an https URL"),
      );
    } else if (
      isNonPublicHost(hostname) ||
      /(^|\.)example\.(org|com|net)$/i.test(hostname)
    ) {
      findings.push(
        blocking(
          "supabase-url-local",
          "VITE_SUPABASE_URL names a local, private, placeholder or demo host, not a hosted project",
        ),
      );
    }
  }

  const key = env.VITE_SB_PUBLISHABLE_KEY;
  if (!present(key)) {
    findings.push(
      blocking(
        "publishable-key-missing",
        "VITE_SB_PUBLISHABLE_KEY is not set: the build could not sign anyone in",
      ),
    );
  } else {
    findings.push(...publishableKeyFindings(key));
  }

  for (const name of Object.keys(env).filter((n) => n.startsWith("VITE_"))) {
    // The build scan's own name rules (a server secret, a model provider), run
    // over the NAME, so this contract and the artifact scan cannot disagree.
    const named = scanText("environment", name).filter(
      (f) => f.severity === "critical" || f.severity === "high",
    );
    if (named.length > 0) {
      findings.push(
        blocking(
          "privileged-vite-variable",
          `${name} is named like a server secret or a model provider credential, and Vite would hand its value to every browser`,
        ),
      );
    } else if (!BROWSER_SAFE_VITE_VARIABLES.includes(name)) {
      findings.push(
        advisory(
          "unknown-vite-variable",
          `${name} is not one of the audited browser-safe variables: review it before it ships`,
        ),
      );
    }
  }
  return findings;
}

const LOCAL_DATABASE_PORTS = /^(5432[0-9]|5433[0-9]|5434[0-9])$/;

/**
 * The environment a production WORKER, gateway or operator command runs in.
 * Only what is set is judged; an unset provider is "off", which is the safe
 * default.
 */
export function auditServiceEnvironment(env) {
  const findings = [];

  for (const name of ["DECISION_SHADOW_PROVIDER", "CALENDAR_PROVIDER"]) {
    const value = env[name];
    if (value === "fake") {
      findings.push(
        blocking(
          "fake-provider",
          `${name} is "fake": a deterministic test provider cannot stand in for a production one`,
        ),
      );
    } else if (value === "jev" || value === "google") {
      findings.push(
        advisory(
          "unconnected-provider",
          `${name} is "${value}": that boundary is not connected (no approved contract) and calls nothing`,
        ),
      );
    }
  }

  if (env.COMPANY_OS_SYNTHETIC_INGRESS === "enabled") {
    findings.push(
      blocking(
        "synthetic-ingress",
        'COMPANY_OS_SYNTHETIC_INGRESS is "enabled": production admits no synthetic message',
      ),
    );
  }

  for (const name of [
    "ADMIN_DATABASE_URL",
    "OPS_WORKER_DATABASE_URL",
    "OPS_GATEWAY_DATABASE_URL",
  ]) {
    if (!present(env[name])) continue;
    let parsed;
    try {
      parsed = new URL(env[name]);
    } catch {
      findings.push(blocking("database-url", `${name} is not a URL`));
      continue;
    }
    if (
      isNonPublicHost(parsed.hostname) ||
      LOCAL_DATABASE_PORTS.test(parsed.port)
    ) {
      findings.push(
        blocking(
          "local-database",
          `${name} names a local or private database (host or a local Supabase port)`,
        ),
      );
    }
  }

  if (present(env.OTEL_EXPORTER_OTLP_ENDPOINT)) {
    const host = hostnameOf(env.OTEL_EXPORTER_OTLP_ENDPOINT);
    if (host !== null && isNonPublicHost(host)) {
      findings.push(
        advisory(
          "local-telemetry-endpoint",
          "OTEL_EXPORTER_OTLP_ENDPOINT is a local collector: fine beside the worker, meaningless if the worker runs elsewhere",
        ),
      );
    }
  }
  return findings;
}

/**
 * A hosted Supabase project, as facts read from it:
 * `authSettings` (`{ disable_signup, mailer_autoconfirm }` from the public auth
 * settings, or null when not read) and `database` (or null): the exemption row
 * count, the applied and repository migration versions, and the seed's marks.
 * What cannot be read from outside is reported by the command, never assumed.
 */
export function auditHostedSupabase({ authSettings, database }) {
  const findings = [];
  if (authSettings !== null) {
    if (authSettings.disable_signup !== true) {
      findings.push(
        blocking(
          "signup-open",
          "the project accepts self-registration: accounts are created by an owner through the users function only",
        ),
      );
    }
    if (authSettings.mailer_autoconfirm === true) {
      findings.push(
        advisory(
          "email-autoconfirm",
          "the project confirms email addresses without a link: a typed address counts as verified",
        ),
      );
    }
  }
  if (database !== null) {
    if (database.exemptionRows > 0) {
      findings.push(
        blocking(
          "assurance-exemption-present",
          "ops.operator_assurance_exemption holds a row: the project accepts sessions below multi-factor assurance",
        ),
      );
    }
    const applied = new Set(database.appliedMigrations);
    const expected = new Set(database.repositoryMigrations);
    const missing = [...expected].filter((v) => !applied.has(v));
    const unknown = [...applied].filter((v) => !expected.has(v));
    if (missing.length > 0) {
      findings.push(
        blocking(
          "migrations-missing",
          `${missing.length} repository migration(s) are not applied (first: ${missing.sort()[0]})`,
        ),
      );
    }
    if (unknown.length > 0) {
      findings.push(
        blocking(
          "migrations-unknown",
          `${unknown.length} applied migration(s) are not in the repository (first: ${unknown.sort()[0]})`,
        ),
      );
    }
    if (database.seedMarks > 0) {
      findings.push(
        blocking(
          "development-seed-applied",
          `${database.seedMarks} mark(s) of the development seed are present: a hosted project never runs it (SI-25)`,
        ),
      );
    }
  }
  return findings;
}

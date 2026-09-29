// The production HOST contract (Production Hosting Gate B): what a deployed
// origin must answer, and what a production artifact must not contain.
//
// Pure functions over already-read facts (a response, a directory listing),
// so they are tested without a network. The commands that read a real URL or
// a real directory are scripts/verify-production-host.mjs and
// scripts/production-preflight.mjs. Nothing here names a hosting provider: the
// contract is what the PAGE needs, whoever serves it.
//
// A finding is { rule, severity: "blocking" | "advisory", detail, file? }. It
// names a rule and a place, and never a secret's value.
//
// WHY A HEADER CONTRACT AT ALL. The build already puts the Content-Security-
// Policy in a <meta>, which a browser enforces. Four things a <meta> cannot do,
// or a host must do itself, are why a deployed response is checked as well:
// `frame-ancestors` (ignored in a meta), Strict-Transport-Security,
// X-Content-Type-Options and Permissions-Policy. A static host that cannot set
// response headers cannot meet this contract, whatever its other merits.

import { scanText } from "./scan-build-artifacts.mjs";
import {
  auditHtmlPage,
  contentSecurityPolicy,
  duplicateDirectives,
  hostedPolicy,
  pageContentSecurityPolicy,
  parsePolicy,
} from "./security-headers.mjs";

const blocking = (rule, detail, file) => ({
  rule,
  severity: "blocking",
  detail,
  ...(file === undefined ? {} : { file }),
});
const advisory = (rule, detail, file) => ({
  rule,
  severity: "advisory",
  detail,
  ...(file === undefined ? {} : { file }),
});

/** A build-scan severity as this contract's: critical and high block. */
const scanSeverity = (severity) =>
  severity === "critical" || severity === "high" ? "blocking" : "advisory";

// One definition of a non-public host, shared with the deployed runtime's
// start gate (engine/runtime/deploymentEnvironment.ts).
export { isNonPublicHost } from "../engine/runtime/deploymentEnvironment.ts";
import { isNonPublicHost } from "../engine/runtime/deploymentEnvironment.ts";

/**
 * What a production page or bundle must never point at: a developer machine, a
 * dev server, the local Supabase ports, or the demo backend. `localhost` alone
 * is not listed: libraries carry it as a parsing base (measured 2026-09-29:
 * `http://localhost` and auth-js's `http://localhost:9999` in the real build).
 */
export const LOCAL_ENDPOINT_PATTERNS = [
  ["loopback address", /127\.0\.0\.1/],
  ["wildcard address", /0\.0\.0\.0/],
  ["container host", /host\.docker\.internal/],
  ["local dev or local Supabase port", /localhost:(517\d|543\d\d|5432\d)\b/],
  ["Vite development client", /@vite\/client|@react-refresh/],
  ["demo backend", /demo\.example\.org/],
];

/** Findings for one text file (a page or a script) that names a local endpoint. */
export function localEndpointFindings(file, text) {
  return LOCAL_ENDPOINT_PATTERNS.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([name]) =>
    blocking(
      "local-endpoint",
      `names a ${name}: a production page and bundle point at the deployed API only`,
      file,
    ),
  );
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

/** The header's value, from a Headers-like object or a plain map. */
const headerOf = (headers, name) => {
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const found = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return found?.[1];
};

/**
 * The Content-Security-Policy header against the declared policy. Several
 * policies (a repeated header arrives comma-joined) intersect, so it is enough
 * that ONE equals the declared policy directive for directive: the effective
 * policy is then never wider than the declared one.
 */
function cspFindings(value, supabaseUrl) {
  if (value === undefined) {
    return [
      blocking(
        "header-content-security-policy",
        "the response carries no Content-Security-Policy header (a <meta> cannot carry frame-ancestors)",
      ),
    ];
  }
  const declared = hostedPolicy({ supabaseUrl });
  const problems = value.split(",").map((text) => {
    const served = parsePolicy(text);
    // A browser keeps the first occurrence of a directive and ignores a later
    // duplicate; a reader that keeps the last would disagree. Refuse both.
    const found = duplicateDirectives(text).map(
      (name) => `${name} is named more than once`,
    );
    for (const [name, sources] of declared) {
      const got = served.get(name);
      if (got === undefined) found.push(`${name} is missing`);
      else if (!sameSet(got, sources)) {
        found.push(`${name} is [${got.join(" ")}], not [${sources.join(" ")}]`);
      }
    }
    return found;
  });
  if (problems.some((found) => found.length === 0)) return [];
  const best = problems.reduce((a, b) => (b.length < a.length ? b : a));
  return best.map((problem) =>
    blocking(
      "header-content-security-policy",
      `${problem}; the served policy must equal the declared one (frame-ancestors 'none' included)`,
    ),
  );
}

const REFERRER_ALLOWED = new Set([
  "no-referrer",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
]);

/**
 * The header contract: every header a page needs and a <meta> cannot carry (or
 * that only the host can send). `headers` may be a Headers or a plain object.
 */
export function auditResponseHeaders(headers, { supabaseUrl } = {}) {
  const findings = cspFindings(
    headerOf(headers, "content-security-policy"),
    supabaseUrl,
  );

  const hsts = headerOf(headers, "strict-transport-security");
  if (hsts === undefined) {
    findings.push(
      blocking(
        "header-strict-transport-security",
        "no Strict-Transport-Security header",
      ),
    );
  } else {
    const maxAge = Number(/max-age\s*=\s*(\d+)/i.exec(hsts)?.[1] ?? Number.NaN);
    if (!(maxAge >= 31_536_000)) {
      findings.push(
        blocking(
          "header-strict-transport-security",
          "max-age is missing or below one year (31536000 seconds)",
        ),
      );
    }
    if (!/includeSubDomains/i.test(hsts)) {
      findings.push(
        advisory(
          "header-strict-transport-security",
          "no includeSubDomains: sibling subdomains stay reachable over http (a decision for a custom domain the clinic controls)",
        ),
      );
    }
  }

  if (
    headerOf(headers, "x-content-type-options")?.trim().toLowerCase() !==
    "nosniff"
  ) {
    findings.push(
      blocking(
        "header-x-content-type-options",
        "X-Content-Type-Options is not nosniff",
      ),
    );
  }

  const referrer = headerOf(headers, "referrer-policy");
  const lastToken = referrer?.split(",").at(-1)?.trim().toLowerCase();
  if (lastToken === undefined || !REFERRER_ALLOWED.has(lastToken)) {
    findings.push(
      blocking(
        "header-referrer-policy",
        "Referrer-Policy is missing or weaker than strict-origin-when-cross-origin",
      ),
    );
  }

  const permissions = headerOf(headers, "permissions-policy");
  for (const feature of ["camera", "microphone", "geolocation"]) {
    if (
      permissions === undefined ||
      !new RegExp(`\\b${feature}=\\(\\)`).test(permissions)
    ) {
      findings.push(
        blocking(
          "header-permissions-policy",
          `Permissions-Policy does not deny ${feature} (${feature}=())`,
        ),
      );
    }
  }
  return findings;
}

/**
 * The scripts a page loads (script src and modulepreload), exactly as the page
 * names them: a relative path, an absolute path or a full URL. Whether one is
 * on the page's own origin is decided by resolving it against the page's URL,
 * where that URL is known (scripts/verify-production-host.mjs).
 */
export function pageAssetPaths(html) {
  const refs = new Set();
  const tag = /<(script|link)\b[^>]*>/gi;
  for (const [element, name] of html.matchAll(tag)) {
    const isScript = name.toLowerCase() === "script";
    if (!isScript && !/rel\s*=\s*["']modulepreload["']/i.test(element))
      continue;
    const ref = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(element)?.[1];
    if (ref !== undefined && !/^(data|blob|javascript):/i.test(ref)) {
      refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * A deployed response, as facts: `{ url, status, headers, html, assets }`,
 * where `assets` is `[{ path, text }]` for the scripts the page loads.
 */
export function auditHostResponse(
  response,
  { supabaseUrl, allowLocal = false } = {},
) {
  const findings = [];
  let url;
  try {
    url = new URL(response.url);
  } catch {
    return [blocking("https-required", "the checked address is not a URL")];
  }
  if (
    url.protocol !== "https:" &&
    !(allowLocal && isNonPublicHost(url.hostname))
  ) {
    findings.push(
      blocking("https-required", "the application is not served over https"),
    );
  }
  if (isNonPublicHost(url.hostname) && !allowLocal) {
    findings.push(
      blocking(
        "public-host-required",
        "the address is a local or private host, not a public production origin",
      ),
    );
  }
  if (response.status !== 200) {
    findings.push(
      blocking(
        "page-status",
        `the application page answered ${response.status}, not 200`,
      ),
    );
  }
  findings.push(...auditResponseHeaders(response.headers, { supabaseUrl }));

  if (typeof response.html === "string") {
    findings.push(
      ...auditHtmlPage("index.html", response.html).map((finding) => ({
        rule: finding.rule,
        severity: "blocking",
        detail: finding.detail,
        file: "index.html",
      })),
      ...localEndpointFindings("index.html", response.html),
    );
  }
  // A page that loads no script of its own is not the application, and a script
  // it names that could not be read is one whose content nothing checked.
  const failures = response.assetFailures ?? [];
  if (
    Array.isArray(response.assets) &&
    response.assets.length === 0 &&
    failures.length === 0
  ) {
    findings.push(
      blocking(
        "page-loads-no-script",
        "the page loads no script from its own origin: it is not the application, and nothing was scanned",
      ),
    );
  }
  for (const failure of failures) {
    findings.push(
      blocking(
        "asset-unreadable",
        `a script the page loads could not be read (${failure.reason}), so its content was not checked`,
        failure.path,
      ),
    );
  }
  if (response.assetsNotChecked > 0) {
    findings.push(
      advisory(
        "assets-not-all-checked",
        `${response.assetsNotChecked} script(s) beyond the first were not read`,
      ),
    );
  }
  for (const asset of response.assets ?? []) {
    for (const finding of scanText(asset.path, asset.text)) {
      findings.push({
        rule: finding.rule,
        severity: scanSeverity(finding.severity),
        detail: finding.detail,
        file: asset.path,
      });
    }
    findings.push(...localEndpointFindings(asset.path, asset.text));
  }
  return findings;
}

/**
 * The page's own policy against the environment being deployed: the build must
 * have been made for THIS API, or its connect-src names another project's (or
 * none), and the browser would refuse the API or trust a stranger.
 */
export function auditPageAgainstEnvironment(html, supabaseUrl) {
  const served = pageContentSecurityPolicy(html);
  if (served === null) {
    return [
      blocking(
        "page-policy-missing",
        "the built page carries no Content-Security-Policy meta",
        "index.html",
      ),
    ];
  }
  const declared = parsePolicy(contentSecurityPolicy({ supabaseUrl }));
  const got = parsePolicy(served);
  const findings = duplicateDirectives(served).map((name) =>
    blocking(
      "page-policy-differs",
      `the page's policy names ${name} more than once`,
      "index.html",
    ),
  );
  for (const [name, sources] of declared) {
    if (!got.has(name) || !sameSet(got.get(name), sources)) {
      findings.push(
        blocking(
          "page-policy-differs",
          `the page's ${name} is not the policy declared for the configured API: the build was made for another environment`,
          "index.html",
        ),
      );
    }
  }
  return findings;
}

/**
 * A production ARTIFACT (the built directory), beyond the secret scan the
 * publish step already runs: no shadcn registry (ADR 0008 has not decided its
 * publication), and no page or script pointing at a local endpoint.
 * `files` is `[{ rel, text }]` for every text file, and `hasRegistryDirectory`
 * says whether `r/` exists in the build.
 */
export function auditArtifactFiles(
  files,
  { hasRegistryDirectory = false } = {},
) {
  const findings = [];
  if (hasRegistryDirectory) {
    findings.push(
      blocking(
        "registry-published",
        "the build carries r/, the published component registry, which ADR 0008 has not decided to publish",
        "r/",
      ),
    );
  }
  for (const { rel, text } of files) {
    if (/\.(html|js|mjs)$/i.test(rel)) {
      findings.push(...localEndpointFindings(rel, text));
    }
  }
  return findings;
}

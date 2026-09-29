// Production Security Gate A: the browser security policy of the built
// application, in one place. vite.config.ts injects it into every production
// build and serves it from `vite preview`; scripts/scan-build-artifacts.mjs
// refuses a build whose page does not carry it; a host that serves the build
// must send hostedSecurityHeaders() as HTTP headers.
//
// WHY A META TAG AND HEADERS. The committed deploy target (GitHub Pages,
// scripts/publish-pages.mjs) cannot send response headers, so the policy the
// repository can enforce on its own travels in the page: a Content-Security-
// Policy <meta> and a referrer <meta>. What only an HTTP header can carry
// (frame-ancestors, HSTS, X-Content-Type-Options, Permissions-Policy) is the
// host's to send; hostedSecurityHeaders() is that exact set, and serving a
// real-data Company OS from a host that does not send it is not permitted.
//
// THE POLICY. Scripts and connections only to this origin and the configured
// Supabase project; nothing evaluated from strings; no plugin, frame or form
// target elsewhere. One exception: style-src 'unsafe-inline', because the UI
// libraries in the bundle insert <style> elements at runtime (six
// createElement("style") sites, measured 2026-09-28) and the page carries one
// inline loader style. It admits styles, never scripts. The CRM performs no
// avatar or favicon lookup (Production Security Gate A.1 removed them: a hash
// of a person's email must not leave for a third party); connect-src and
// img-src would refuse one on purpose, and the CRM shows initials.

const REFERRER_POLICY = "strict-origin-when-cross-origin";

/** The Supabase origins the browser may reach, from the configured project URL. */
export function supabaseOrigins(supabaseUrl) {
  if (supabaseUrl === undefined || supabaseUrl === null || supabaseUrl === "") {
    return [];
  }
  let url;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error(
      "VITE_SUPABASE_URL is not a URL; the production security policy cannot name the API origin",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("VITE_SUPABASE_URL must be an http(s) URL");
  }
  const websocket = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  return [url.origin, websocket];
}

/** The directives, in order. frame-ancestors is added only where a header carries it. */
function directives(supabaseUrl) {
  const [api, websocket] = supabaseOrigins(supabaseUrl);
  const withApi = (...sources) =>
    api === undefined ? sources : [...sources, api];
  return [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", withApi("'self'", "data:", "blob:")],
    ["font-src", ["'self'", "data:"]],
    [
      "connect-src",
      api === undefined ? ["'self'"] : ["'self'", api, websocket],
    ],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["frame-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
  ];
}

const serialize = (list) =>
  list.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");

/** The policy a production page carries in its <meta> (no frame-ancestors: a meta cannot). */
export function contentSecurityPolicy({ supabaseUrl } = {}) {
  return serialize(directives(supabaseUrl));
}

/** The HTTP headers a host serving the build must send. */
export function hostedSecurityHeaders({ supabaseUrl } = {}) {
  return {
    "Content-Security-Policy": serialize([
      ...directives(supabaseUrl),
      ["frame-ancestors", ["'none'"]],
    ]),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": REFERRER_POLICY,
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

/** A policy's directives, by lower-cased name, each with its source list. */
export function parsePolicy(policy) {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );
}

/** The policy a host must send, by directive: the declared header's, frame-ancestors included. */
export function hostedPolicy({ supabaseUrl } = {}) {
  return parsePolicy(
    hostedSecurityHeaders({ supabaseUrl })["Content-Security-Policy"],
  );
}

const escapeAttribute = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** The two <meta> elements a production page carries. */
export function securityMetaTags({ supabaseUrl } = {}) {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(contentSecurityPolicy({ supabaseUrl }))}" />`,
    `<meta name="referrer" content="${REFERRER_POLICY}" />`,
  ].join("\n    ");
}

const CSP_META =
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i;

/** The Content-Security-Policy a page carries in its <meta>, or null. */
export function pageContentSecurityPolicy(html) {
  const meta = CSP_META.exec(html);
  return meta === null
    ? null
    : meta[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

/**
 * What a built page must satisfy, as findings in the build scan's shape: the
 * policy present once, in the page head, every required directive, and no
 * wildcard script source, 'unsafe-eval' or script 'unsafe-inline'.
 */
export function auditBuiltPage(rel, html) {
  const findings = [];
  const fail = (detail) =>
    findings.push({
      rule: "content-security-policy",
      severity: "high",
      file: rel,
      detail,
    });
  const metas = html.match(new RegExp(CSP_META.source, "gi")) ?? [];
  if (metas.length !== 1) {
    fail(
      `the page carries ${metas.length} Content-Security-Policy meta elements; a production build carries exactly one`,
    );
    return findings;
  }
  const head = html.split(/<\/head>/i)[0];
  if (!CSP_META.test(head)) {
    fail(
      "the Content-Security-Policy meta is not inside <head>, where a browser applies it",
    );
  }
  const policy = CSP_META.exec(html)[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
  const parsed = new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );
  for (const required of [
    "default-src",
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "connect-src",
    "base-uri",
    "form-action",
    "object-src",
  ]) {
    if (!parsed.has(required)) fail(`the policy has no ${required}`);
  }
  const scripts = parsed.get("script-src") ?? [];
  if (
    scripts.some(
      (source) =>
        source === "*" ||
        source === "'unsafe-inline'" ||
        /^https?:$/.test(source),
    )
  ) {
    fail("script-src admits a wildcard, a whole scheme or inline script");
  }
  if (
    [...parsed.values()].some((sources) => sources.includes("'unsafe-eval'"))
  ) {
    fail("the policy admits 'unsafe-eval'");
  }
  if ((parsed.get("object-src") ?? []).join(" ") !== "'none'") {
    fail("object-src is not 'none'");
  }
  if ((parsed.get("default-src") ?? []).some((source) => source === "*")) {
    fail("default-src admits a wildcard");
  }
  if (
    !/<meta\s+name="referrer"\s+content="strict-origin-when-cross-origin"/i.test(
      head,
    )
  ) {
    fail("the page head carries no strict referrer policy");
  }
  return findings;
}

/**
 * The Vite plugins: the policy in every production page, and every header on
 * `vite preview`. The Supabase origin is the one the build itself was
 * configured with (Vite's resolved env), never a separate setting.
 */
export function securityHeadersPlugins() {
  let supabaseUrl;
  const readEnv = (config) => {
    supabaseUrl = config.env?.VITE_SUPABASE_URL;
  };
  return [
    {
      name: "company-os-security-meta",
      apply: "build",
      configResolved: readEnv,
      transformIndexHtml: {
        order: "post",
        handler(html) {
          return html.replace(
            /<head>/i,
            `<head>
    ${securityMetaTags({ supabaseUrl })}`,
          );
        },
      },
    },
    {
      name: "company-os-security-preview-headers",
      apply: (_config, env) => env.isPreview === true,
      configResolved: readEnv,
      configurePreviewServer(server) {
        const headers = hostedSecurityHeaders({ supabaseUrl });
        server.middlewares.use((_request, response, next) => {
          for (const [name, value] of Object.entries(headers)) {
            response.setHeader(name, value);
          }
          next();
        });
      },
    },
  ];
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>/gi;

/**
 * Every HTML page of a build: no inline script anywhere; the application's
 * page (index.html) carries the full policy; any other page carries its own
 * Content-Security-Policy with no wildcard or inline script source.
 */
export function auditHtmlPage(rel, html) {
  const findings = [];
  const inline = html.match(INLINE_SCRIPT) ?? [];
  if (inline.length > 0) {
    findings.push({
      rule: "inline-script",
      severity: "high",
      file: rel,
      detail: `${inline.length} inline script element(s): the production policy admits same-origin script files only`,
    });
  }
  if (rel === "index.html") return [...findings, ...auditBuiltPage(rel, html)];
  const meta = CSP_META.exec(html);
  const scripts =
    meta === null ? "" : (/script-src([^;]*)/i.exec(meta[1])?.[1] ?? "");
  if (meta === null || /\*|'unsafe-inline'|'unsafe-eval'/.test(scripts)) {
    findings.push({
      rule: "content-security-policy",
      severity: "high",
      file: rel,
      detail:
        "an HTML page without its own Content-Security-Policy, or one admitting inline or wildcard scripts",
    });
  }
  return findings;
}

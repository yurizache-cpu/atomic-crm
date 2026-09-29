import { describe, expect, it } from "vitest";

import {
  LOCAL_ENDPOINT_PATTERNS,
  auditArtifactFiles,
  auditHostResponse,
  auditPageAgainstEnvironment,
  auditResponseHeaders,
  isNonPublicHost,
  localEndpointFindings,
  pageAssetPaths,
} from "../production-contract-host.mjs";
import {
  hostedSecurityHeaders,
  securityMetaTags,
} from "../security-headers.mjs";

// Production Hosting Gate B: the host contract, as a pure function of what a
// deployed origin answered. Every rule is exercised by the smallest response
// that breaks it; all data synthetic.

const API = "https://project-ref.supabase.co";
const declared = () => hostedSecurityHeaders({ supabaseUrl: API });
const blockingRules = (findings) =>
  findings.filter((f) => f.severity === "blocking").map((f) => f.rule);

const goodPage = `<!doctype html><html><head>${securityMetaTags({ supabaseUrl: API })}<script type="module" src="./assets/index-abc.js"></script><link rel="modulepreload" href="/assets/vendor-abc.js"></head><body><div id="root"></div></body></html>`;
const goodResponse = () => ({
  url: "https://clinic.example-domain.org/",
  status: 200,
  headers: declared(),
  html: goodPage,
  assets: [{ path: "assets/index-abc.js", text: "console.log('ok')" }],
});

describe("the declared header set is the host contract", () => {
  it("passes exactly what scripts/security-headers.mjs declares", () => {
    expect(auditResponseHeaders(declared(), { supabaseUrl: API })).toEqual([]);
  });

  it("reads a Headers object as well as a plain object, whatever the case", () => {
    const headers = new Headers(declared());
    expect(auditResponseHeaders(headers, { supabaseUrl: API })).toEqual([]);
    const lower = Object.fromEntries(
      Object.entries(declared()).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(auditResponseHeaders(lower, { supabaseUrl: API })).toEqual([]);
  });

  it.each([
    ["Content-Security-Policy", "header-content-security-policy"],
    ["Strict-Transport-Security", "header-strict-transport-security"],
    ["X-Content-Type-Options", "header-x-content-type-options"],
    ["Referrer-Policy", "header-referrer-policy"],
    ["Permissions-Policy", "header-permissions-policy"],
  ])("requires %s", (name, rule) => {
    const headers = { ...declared() };
    delete headers[name];
    expect(
      blockingRules(auditResponseHeaders(headers, { supabaseUrl: API })),
    ).toContain(rule);
  });
});

describe("the Content-Security-Policy header cannot be weakened", () => {
  const withPolicy = (policy) => ({
    ...declared(),
    "Content-Security-Policy": policy,
  });
  const problems = (policy) =>
    auditResponseHeaders(withPolicy(policy), { supabaseUrl: API })
      .filter((f) => f.rule === "header-content-security-policy")
      .map((f) => f.detail);

  it("refuses a third-party cosmetic source, however small (a Gravatar image)", () => {
    const weakened = declared()["Content-Security-Policy"].replace(
      "img-src 'self'",
      "img-src 'self' https://www.gravatar.com",
    );
    expect(problems(weakened).join(" ")).toMatch(/img-src/);
  });

  it("refuses a missing or looser frame-ancestors: the page could be framed", () => {
    const base = declared()["Content-Security-Policy"];
    expect(
      problems(base.replace("; frame-ancestors 'none'", "")).join(" "),
    ).toMatch(/frame-ancestors is missing/);
    expect(
      problems(
        base.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
      ).join(" "),
    ).toMatch(/frame-ancestors is/);
  });

  it.each([
    ["script-src 'self'", "script-src 'self' 'unsafe-eval'"],
    ["script-src 'self'", "script-src 'self' 'unsafe-inline'"],
    ["script-src 'self'", "script-src *"],
    ["connect-src 'self'", "connect-src 'self' https:"],
    ["default-src 'self'", "default-src *"],
    ["object-src 'none'", "object-src 'self'"],
  ])("refuses %s becoming %s", (from, to) => {
    const weakened = declared()["Content-Security-Policy"].replace(from, to);
    expect(problems(weakened).length).toBeGreaterThan(0);
  });

  it("refuses a policy made for another project's API", () => {
    const other = hostedSecurityHeaders({
      supabaseUrl: "https://other.supabase.co",
    });
    expect(problems(other["Content-Security-Policy"]).length).toBeGreaterThan(
      0,
    );
  });

  it("refuses a directive named twice: a browser keeps the first, a reader may keep the last", () => {
    const base = declared()["Content-Security-Policy"];
    // The weak one first: the wildcard is the effective script-src.
    expect(problems(`script-src *; ${base}`).join(" ")).toMatch(
      /script-src is \[\*\]|script-src is named more than once/,
    );
    // The declared one first: effective, but ambiguous between parsers.
    expect(problems(`${base}; script-src *`).join(" ")).toMatch(
      /script-src is named more than once/,
    );
    expect(problems(`${base}; connect-src 'self'`).length).toBeGreaterThan(0);
  });

  it("accepts repeated policies when one equals the declared one (they intersect)", () => {
    const base = declared()["Content-Security-Policy"];
    expect(problems(`${base}, default-src 'none'`)).toEqual([]);
    expect(problems(`default-src 'none', ${base}`)).toEqual([]);
    expect(
      problems(`default-src 'none', default-src 'self'`).length,
    ).toBeGreaterThan(0);
  });

  it("does not care about the order of sources or directives", () => {
    const policy = declared()["Content-Security-Policy"];
    const reordered = policy
      .split("; ")
      .reverse()
      .join("; ")
      .replace("'self' data: blob:", "blob: data: 'self'");
    expect(problems(reordered)).toEqual([]);
  });
});

describe("the other headers", () => {
  const audit = (patch) =>
    auditResponseHeaders({ ...declared(), ...patch }, { supabaseUrl: API });

  it("requires a year of HSTS, and notes the absence of includeSubDomains without blocking", () => {
    expect(
      blockingRules(audit({ "Strict-Transport-Security": "max-age=60" })),
    ).toContain("header-strict-transport-security");
    expect(
      blockingRules(
        audit({ "Strict-Transport-Security": "includeSubDomains" }),
      ),
    ).toContain("header-strict-transport-security");
    const noSubdomains = audit({
      "Strict-Transport-Security": "max-age=63072000; preload",
    });
    expect(blockingRules(noSubdomains)).toEqual([]);
    expect(noSubdomains.some((f) => f.severity === "advisory")).toBe(true);
  });

  it("requires nosniff exactly", () => {
    expect(
      blockingRules(audit({ "X-Content-Type-Options": "sniff" })),
    ).toContain("header-x-content-type-options");
    expect(
      blockingRules(audit({ "X-Content-Type-Options": "NoSniff" })),
    ).toEqual([]);
  });

  it.each([
    ["no-referrer", true],
    ["same-origin", true],
    ["strict-origin", true],
    ["strict-origin-when-cross-origin", true],
    ["origin-when-cross-origin", false],
    ["unsafe-url", false],
    ["no-referrer-when-downgrade", false],
  ])("Referrer-Policy %s is accepted: %s", (value, accepted) => {
    expect(
      blockingRules(audit({ "Referrer-Policy": value })).includes(
        "header-referrer-policy",
      ),
    ).toBe(!accepted);
  });

  it("uses the last token of a fallback list, as a browser does", () => {
    expect(
      blockingRules(audit({ "Referrer-Policy": "unsafe-url, strict-origin" })),
    ).toEqual([]);
    expect(
      blockingRules(audit({ "Referrer-Policy": "strict-origin, unsafe-url" })),
    ).toContain("header-referrer-policy");
  });

  it("requires the Permissions-Policy to deny camera, microphone and geolocation", () => {
    expect(
      blockingRules(
        audit({ "Permissions-Policy": "camera=(), microphone=()" }),
      ),
    ).toContain("header-permissions-policy");
    expect(
      blockingRules(
        audit({
          "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
        }),
      ),
    ).toContain("header-permissions-policy");
    expect(
      blockingRules(
        audit({
          "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
        }),
      ),
    ).toEqual([]);
  });
});

describe("a deployed response", () => {
  it("passes when it is https, public, 200, carries every header, a clean page and clean scripts", () => {
    expect(auditHostResponse(goodResponse(), { supabaseUrl: API })).toEqual([]);
  });

  it("refuses http and local or private hosts, and only a self-test lets them through", () => {
    const local = { ...goodResponse(), url: "http://localhost:4173/" };
    expect(
      blockingRules(auditHostResponse(local, { supabaseUrl: API })),
    ).toEqual(
      expect.arrayContaining(["https-required", "public-host-required"]),
    );
    expect(
      auditHostResponse(local, { supabaseUrl: API, allowLocal: true }),
    ).toEqual([]);
    // Local self-test never excuses plain http on a public host.
    const plainPublic = {
      ...goodResponse(),
      url: "http://clinic.example-domain.org/",
    };
    expect(
      blockingRules(
        auditHostResponse(plainPublic, { supabaseUrl: API, allowLocal: true }),
      ),
    ).toContain("https-required");
  });

  it.each([
    "localhost",
    "app.localhost",
    "kong",
    "db.internal",
    "host.docker.internal",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.5",
    "172.20.0.9",
    "169.254.1.1",
  ])("treats %s as non-public", (host) => {
    expect(isNonPublicHost(host)).toBe(true);
  });

  it("treats a real domain and a public address as public", () => {
    expect(isNonPublicHost("clinic.example-domain.org")).toBe(false);
    expect(isNonPublicHost("172.32.0.1")).toBe(false);
  });

  it("refuses a page that is not 200", () => {
    expect(
      blockingRules(
        auditHostResponse(
          { ...goodResponse(), status: 404 },
          { supabaseUrl: API },
        ),
      ),
    ).toContain("page-status");
  });

  it("refuses a page with no policy meta, an inline script, or a local or dev endpoint", () => {
    const noMeta = {
      ...goodResponse(),
      html: goodPage.replace(/<meta http-equiv[^>]*>/i, ""),
    };
    expect(
      blockingRules(auditHostResponse(noMeta, { supabaseUrl: API })),
    ).toContain("content-security-policy");
    const inline = {
      ...goodResponse(),
      html: goodPage.replace("</body>", "<script>alert(1)</script></body>"),
    };
    expect(
      blockingRules(auditHostResponse(inline, { supabaseUrl: API })),
    ).toContain("inline-script");
    const dev = {
      ...goodResponse(),
      html: goodPage.replace(
        "</body>",
        '<script type="module" src="http://127.0.0.1:5173/@vite/client"></script></body>',
      ),
    };
    expect(
      blockingRules(auditHostResponse(dev, { supabaseUrl: API })),
    ).toContain("local-endpoint");
  });

  it("refuses a script naming a local endpoint or carrying a service-role token, and never prints the token", () => {
    const b64 = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", iss: "supabase" })}.synthetic-signature-value`;
    const response = {
      ...goodResponse(),
      assets: [
        {
          path: "assets/a.js",
          text: `fetch("http://127.0.0.1:54321/rest/v1")`,
        },
        { path: "assets/b.js", text: `const k = "${token}";` },
      ],
    };
    const findings = auditHostResponse(response, { supabaseUrl: API });
    expect(blockingRules(findings)).toContain("local-endpoint");
    expect(
      findings.some(
        (f) => f.file === "assets/b.js" && f.severity === "blocking",
      ),
    ).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("synthetic-signature-value");
  });

  it("refuses a script the page names that could not be read: its content was never checked", () => {
    const findings = auditHostResponse(
      {
        ...goodResponse(),
        assetFailures: [{ path: "assets/index-abc.js", reason: "status 404" }],
      },
      { supabaseUrl: API },
    );
    expect(blockingRules(findings)).toEqual(["asset-unreadable"]);
    expect(findings[0].file).toBe("assets/index-abc.js");
  });

  it("refuses a page that loads no script of its own, and notes scripts it did not read", () => {
    expect(
      blockingRules(
        auditHostResponse(
          { ...goodResponse(), assets: [] },
          { supabaseUrl: API },
        ),
      ),
    ).toEqual(["page-loads-no-script"]);
    const capped = auditHostResponse(
      { ...goodResponse(), assetsNotChecked: 3 },
      { supabaseUrl: API },
    );
    expect(blockingRules(capped)).toEqual([]);
    expect(capped.map((f) => f.rule)).toEqual(["assets-not-all-checked"]);
  });

  it("refuses a final origin other than the one asked for, only when one is named", () => {
    const moved = {
      ...goodResponse(),
      url: "https://other.example-domain.org/",
    };
    expect(
      blockingRules(
        auditHostResponse(moved, {
          supabaseUrl: API,
          expectedHost: "clinic.example-domain.org",
        }),
      ),
    ).toEqual(["unexpected-final-origin"]);
    expect(
      auditHostResponse(goodResponse(), {
        supabaseUrl: API,
        expectedHost: "clinic.example-domain.org",
      }),
    ).toEqual([]);
  });

  it("rejects an unreadable address as not https", () => {
    expect(
      blockingRules(
        auditHostResponse({ url: "not a url", status: 200, headers: {} }, {}),
      ),
    ).toEqual(["https-required"]);
  });
});

describe("what a page loads", () => {
  it("lists every script and modulepreload as the page names it, leaving the origin to the resolver", () => {
    const html = `<head>
      <script type="module" crossorigin src="./assets/index-1.js"></script>
      <link rel="modulepreload" href="/assets/vendor-2.js">
      <link rel="stylesheet" href="/assets/index.css">
      <script src="https://cdn.example.net/x.js"></script>
      <script src="//cdn.example.net/y.js"></script>
      <script src="data:text/javascript,1"></script>
      <script>inline()</script>
    </head>`;
    // An absolute URL is kept: it may well be this very origin's script, and
    // only resolving it against the page's URL can tell.
    expect(pageAssetPaths(html).sort()).toEqual([
      "./assets/index-1.js",
      "//cdn.example.net/y.js",
      "/assets/vendor-2.js",
      "https://cdn.example.net/x.js",
    ]);
  });
});

describe("a build made for another environment", () => {
  it("passes the page made for this API and refuses one made for another", () => {
    expect(auditPageAgainstEnvironment(goodPage, API)).toEqual([]);
    expect(
      blockingRules(
        auditPageAgainstEnvironment(goodPage, "https://other.supabase.co"),
      ),
    ).toContain("page-policy-differs");
    expect(
      blockingRules(auditPageAgainstEnvironment("<html></html>", API)),
    ).toEqual(["page-policy-missing"]);
  });
});

describe("a production artifact", () => {
  it("refuses a published component registry", () => {
    expect(
      blockingRules(auditArtifactFiles([], { hasRegistryDirectory: true })),
    ).toEqual(["registry-published"]);
    expect(auditArtifactFiles([], {})).toEqual([]);
  });

  it("finds local endpoints in pages and scripts but not the library parsing bases", () => {
    const files = [
      {
        rel: "assets/a.js",
        text: `const d = "http://localhost:9999"; new URL(x, "http://localhost");`,
      },
      { rel: "assets/b.js", text: `const s = "localhost:54321";` },
      { rel: "assets/c.js", text: `const s = "https://demo.example.org";` },
      { rel: "index.html", text: "<html></html>" },
    ];
    const found = auditArtifactFiles(files).map((f) => f.file);
    expect(found).toEqual(["assets/b.js", "assets/c.js"]);
  });

  it("names each local endpoint class it knows", () => {
    for (const [name, pattern] of LOCAL_ENDPOINT_PATTERNS) {
      expect(name.length).toBeGreaterThan(0);
      expect(pattern).toBeInstanceOf(RegExp);
    }
    expect(localEndpointFindings("x.js", "@vite/client")).toHaveLength(1);
    expect(localEndpointFindings("x.js", "nothing here")).toEqual([]);
  });
});

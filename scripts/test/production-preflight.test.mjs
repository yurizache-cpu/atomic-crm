import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { preflightFindings } from "../production-preflight.mjs";
import { securityMetaTags } from "../security-headers.mjs";

// Production Hosting Gate B: the preflight that stands in front of any host. It
// is run against a synthetic build directory and synthetic environments; the
// real build is measured by `npm run production:preflight`. No provider is
// named anywhere: the contract is what the page and its environment need.

const ROOT = process.cwd();
const API = "https://project-ref.supabase.co";
const KEY = "sb_publishable_syntheticExampleKey123456";
const GOOD_ENV = { VITE_SUPABASE_URL: API, VITE_SB_PUBLISHABLE_KEY: KEY };

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0)
    rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** A synthetic build directory; `files` is `{ relativePath: text }`. */
const build = (files = {}, { supabaseUrl = API } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  tempDirs.push(dir);
  const all = {
    "index.html": `<!doctype html><html><head>${securityMetaTags({ supabaseUrl })}<script type="module" src="./assets/index-abc.js"></script></head><body><div id="root"></div></body></html>`,
    "assets/index-abc.js": "console.log('synthetic bundle')",
    "robots.txt": "User-agent: *",
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
};
const blocking = (findings) =>
  findings.filter((f) => f.severity === "blocking").map((f) => f.rule);

describe("the artifact and environment of a production build", () => {
  it("passes a build made for a hosted API with a publishable key", () => {
    expect(
      blocking(preflightFindings({ dist: build(), env: GOOD_ENV })),
    ).toEqual([]);
  });

  it("refuses the environment problems, whatever the artifact", () => {
    const dist = build();
    expect(
      blocking(
        preflightFindings({ dist, env: { ...GOOD_ENV, VITE_IS_DEMO: "true" } }),
      ),
    ).toContain("demo-build");
    expect(blocking(preflightFindings({ dist, env: {} }))).toEqual(
      expect.arrayContaining([
        "supabase-url-missing",
        "publishable-key-missing",
      ]),
    );
  });

  it("refuses a build made for another API: its page policy names a different project", () => {
    const dist = build({}, { supabaseUrl: "https://another.supabase.co" });
    expect(blocking(preflightFindings({ dist, env: GOOD_ENV }))).toContain(
      "page-policy-differs",
    );
  });

  it("refuses a page with no policy, or an inline script", () => {
    const dist = build({
      "index.html":
        "<html><head></head><body><script>run()</script></body></html>",
    });
    expect(blocking(preflightFindings({ dist, env: GOOD_ENV }))).toEqual(
      expect.arrayContaining([
        "content-security-policy",
        "inline-script",
        "page-policy-missing",
      ]),
    );
  });

  it("refuses a missing index.html", () => {
    const dist = build();
    rmSync(join(dist, "index.html"));
    expect(blocking(preflightFindings({ dist, env: GOOD_ENV }))).toContain(
      "index-missing",
    );
  });

  it("refuses a local endpoint in a script, and a published registry", () => {
    const dist = build({
      "assets/index-abc.js": `fetch("http://127.0.0.1:54321/rest/v1/")`,
      "r/registry.json": "{}",
    });
    expect(blocking(preflightFindings({ dist, env: GOOD_ENV }))).toEqual(
      expect.arrayContaining(["local-endpoint", "registry-published"]),
    );
  });

  it("refuses a credential class in the build, through the build scan's own rules", () => {
    const b64 = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", iss: "supabase" })}.synthetic-signature-value`;
    const dist = build({ "assets/index-abc.js": `const k = "${token}";` });
    const findings = preflightFindings({ dist, env: GOOD_ENV });
    expect(blocking(findings).length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain("synthetic-signature-value");
  });

  it("notes published source maps without blocking", () => {
    const dist = build({ "assets/index-abc.js.map": "{}" });
    const findings = preflightFindings({ dist, env: GOOD_ENV });
    expect(blocking(findings)).toEqual([]);
    expect(
      findings.some(
        (f) => f.rule === "source-maps" && f.severity === "advisory",
      ),
    ).toBe(true);
  });

  it("judges the worker environment only when asked", () => {
    const dist = build();
    const env = {
      ...GOOD_ENV,
      DECISION_SHADOW_PROVIDER: "fake",
      COMPANY_OS_SYNTHETIC_INGRESS: "enabled",
    };
    expect(blocking(preflightFindings({ dist, env }))).toEqual([]);
    expect(blocking(preflightFindings({ dist, env, services: true }))).toEqual(
      expect.arrayContaining(["fake-provider", "synthetic-ingress"]),
    );
  });
});

describe("the command", () => {
  const run = (args, env) => {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("VITE_")),
    );
    return spawnSync(
      process.execPath,
      ["scripts/production-preflight.mjs", ...args],
      {
        cwd: ROOT,
        env: { ...clean, ...env },
        encoding: "utf8",
      },
    );
  };

  it("exits 0 on a passing build", () => {
    const result = run(["--dist", build()], GOOD_ENV);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/PASS/);
  });

  it("exits 1 on a blocking finding, and prints no value it judged", () => {
    const secretKey = "sb_secret_syntheticSecretKeyValueThatMustNotAppear";
    const result = run(["--dist", build()], {
      ...GOOD_ENV,
      VITE_SB_PUBLISHABLE_KEY: secretKey,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/publishable-key-is-secret/);
    expect(result.stderr + result.stdout).not.toContain(secretKey);
  });

  it("exits 2, not 0, when there is no build to look at", () => {
    const result = run(
      ["--dist", join(tmpdir(), "no-such-build-directory")],
      GOOD_ENV,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not a pass/);
  });

  it("exits 2 on a usage error", () => {
    expect(run(["--dist"], GOOD_ENV).status).toBe(2);
    expect(run(["surprise"], GOOD_ENV).status).toBe(2);
  });

  it("prints machine-readable findings with --json", () => {
    const result = run(["--dist", build(), "--json"], {
      ...GOOD_ENV,
      VITE_IS_DEMO: "true",
    });
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.blocking).toBeGreaterThan(0);
    expect(parsed.findings[0]).toHaveProperty("rule");
  });
});

describe("the deploy workflow runs the preflight first (SI-76)", () => {
  const workflow = readFileSync(
    join(ROOT, ".github/workflows/deploy.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const job = (name) => {
    const start = workflow.indexOf(`\n    ${name}:`);
    expect(start, `no ${name} job`).toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {4}[a-z][a-z-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  const stepOf = (text, marker) => {
    const at = text.indexOf(marker);
    if (at === -1) return null;
    const begin = text.lastIndexOf("\n            - ", at) + 1;
    const end = text.indexOf("\n            - ", at);
    // The comment that introduces the NEXT step sits in this chunk: drop comments.
    return text
      .slice(begin, end === -1 ? undefined : end)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .trimEnd();
  };

  it("in the production job, after the build and before any database push or publish", () => {
    const text = job("deploy-supabase");
    const lines = text.split("\n");
    const preflight = lines.findIndex((line) =>
      line.includes("production-preflight.mjs"),
    );
    const build = lines.findIndex((line) => line.includes("npm run build"));
    expect(build).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(build);
    // Every line that reaches a remote (the database CLI, or a publish) is below it.
    const reachesRemote =
      /\bsupabase\s+(link|db|secrets|functions)\b|publish-pages\.mjs/;
    const remote = lines
      .map((line, index) => [line, index])
      .filter(
        ([line]) => !line.trim().startsWith("#") && reachesRemote.test(line),
      );
    expect(remote.length).toBeGreaterThan(0);
    for (const [line, index] of remote) {
      expect(
        index,
        `a remote step is above the preflight: ${line.trim()}`,
      ).toBeGreaterThan(preflight);
    }
  });

  it("as a step that always runs and can never be waved through", () => {
    const step = stepOf(job("deploy-supabase"), "production-preflight.mjs");
    expect(step).not.toBeNull();
    expect(step).not.toMatch(/continue-on-error/);
    expect(step).not.toMatch(/\n\s+if:/);
    expect(step).not.toMatch(/\|\|\s*true/);
    expect(step).toMatch(
      /run: node scripts\/production-preflight\.mjs --dist dist\s*$/,
    );
  });

  it("and the demo job, which is expected to be a demo, does not pretend to be production", () => {
    expect(job("deploy-demo")).not.toContain("production-preflight");
  });
});

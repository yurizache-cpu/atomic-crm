import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cloudflareWorkerConfig } from "../cloudflare-config.mjs";
import {
  auditHeadersFile,
  parseHeadersFile,
  renderHeadersFile,
} from "../host-headers-file.mjs";
import { releaseIdentifier } from "../live-release.mjs";
import { WRANGLER_VERSION, publish } from "../publish-cloudflare.mjs";
import {
  hostedSecurityHeaders,
  securityMetaTags,
} from "../security-headers.mjs";

// Production Hosting (SI-77): the frontend host pieces and the deployed runtime's
// packaging, without the tools or an account. The upload and the deployed origin
// are injected into publish(), so its ORDER is what is tested: nothing uploads
// past a blocking preflight, and nothing passes without the live origin's check.

const ROOT = process.cwd();
const API = "https://project-ref.supabase.co";
const HOST = "app.clinic-example.org";
const ENV = {
  VITE_SUPABASE_URL: API,
  VITE_SB_PUBLISHABLE_KEY: "sb_publishable_syntheticExampleKey123456",
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token-never-printed",
  CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
};
const read = (path) =>
  readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0)
    rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const PAGE = `<!doctype html><html><head>${securityMetaTags({ supabaseUrl: API })}<script type="module" src="./assets/index-abc.js"></script></head><body></body></html>`;
const build = () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), PAGE);
  writeFileSync(
    join(dir, "assets", "index-abc.js"),
    "console.log('synthetic')",
  );
  return dir;
};
/** Every build() is the same build, so it has one release identifier. */
const RELEASE = releaseIdentifier(build());
/** The deployed origin as a host that honours the headers file would answer. */
const goodOrigin = async (url) => ({
  release: RELEASE,
  response: {
    url,
    status: 200,
    headers: hostedSecurityHeaders({ supabaseUrl: API }),
    html: PAGE,
    assets: [{ path: "assets/index-abc.js", text: "console.log('synthetic')" }],
    assetFailures: [],
    assetsNotChecked: 0,
  },
  httpRedirect: "redirects",
});
const quiet = { write: () => {}, sleep: async () => {} };

describe("the Worker configuration", () => {
  it("is one assets-only Worker per environment, on its custom domain only, with SPA fallback", () => {
    const config = cloudflareWorkerConfig({
      environment: "staging",
      hostname: "staging.clinic-example.org",
      assetsDirectory: "/work/dist",
    });
    expect(config).toEqual({
      name: "clinic-crm-staging",
      compatibility_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      assets: {
        directory: "/work/dist",
        not_found_handling: "single-page-application",
      },
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: "staging.clinic-example.org", custom_domain: true }],
    });
    expect(config).not.toHaveProperty("main");
    expect(
      cloudflareWorkerConfig({
        environment: "production",
        hostname: HOST,
        assetsDirectory: "d",
      }).name,
    ).toBe("clinic-crm-production");
  });

  it.each([
    "https://app.clinic-example.org",
    "app.clinic-example.org/",
    "app.clinic-example.org:443",
    "App.Clinic-Example.org",
    "*.clinic-example.org",
    "localhost",
    "",
  ])("refuses the hostname %j", (hostname) => {
    expect(() =>
      cloudflareWorkerConfig({
        environment: "production",
        hostname,
        assetsDirectory: "d",
      }),
    ).toThrow(/hostname/);
  });

  it("refuses any environment but staging and production", () => {
    expect(() =>
      cloudflareWorkerConfig({
        environment: "preview",
        hostname: HOST,
        assetsDirectory: "d",
      }),
    ).toThrow(/environment/);
  });
});

describe("the headers file", () => {
  it("renders exactly the declared set for every path, and audits clean", () => {
    const text = renderHeadersFile({ supabaseUrl: API });
    const { rules, invalid } = parseHeadersFile(text);
    expect(invalid).toEqual([]);
    expect(rules).toEqual([
      { path: "/*", headers: hostedSecurityHeaders({ supabaseUrl: API }) },
    ]);
    expect(auditHeadersFile(text, { supabaseUrl: API })).toEqual([]);
    for (const line of text.split("\n"))
      expect(line.length).toBeLessThanOrEqual(2000);
  });

  it("refuses a file made for another API, a weakened or missing header, an extra rule or header", () => {
    const text = renderHeadersFile({ supabaseUrl: API });
    const audit = (t) =>
      auditHeadersFile(t, { supabaseUrl: API })
        .map((f) => f.detail)
        .join(" | ");
    expect(
      audit(renderHeadersFile({ supabaseUrl: "https://other.supabase.co" })),
    ).toMatch(/Content-Security-Policy to a value other than the declared one/);
    expect(
      audit(text.replace("frame-ancestors 'none'", "frame-ancestors *")),
    ).toMatch(/Content-Security-Policy/);
    expect(
      audit(text.replace(/ {2}X-Content-Type-Options: nosniff\n/, "")),
    ).toMatch(/does not set X-Content-Type-Options/);
    expect(
      audit(`${text}/admin/*\n  Content-Security-Policy: default-src *\n`),
    ).toMatch(/exactly one rule/);
    expect(audit(`${text}  Access-Control-Allow-Origin: *\n`)).toMatch(
      /Access-Control-Allow-Origin, which the contract does not declare/,
    );
    expect(audit(`  Orphan: header\n${text}`)).toMatch(/line 1 is not a path/);
  });
});

describe("the publish sequence", () => {
  it("writes the headers file, uploads a generated configuration, then verifies the live origin", async () => {
    const dist = build();
    const calls = [];
    const origins = [];
    const status = await publish({
      dist,
      environment: "production",
      hostname: HOST,
      env: ENV,
      run: (args) => {
        const configPath = args[args.indexOf("--config") + 1];
        calls.push({
          args,
          config: JSON.parse(readFileSync(configPath, "utf8")),
        });
        return 0;
      },
      readOrigin: async (url) => {
        origins.push(url);
        return goodOrigin(url);
      },
      ...quiet,
    });
    expect(status).toBe(0);
    expect(
      auditHeadersFile(readFileSync(join(dist, "_headers"), "utf8"), {
        supabaseUrl: API,
      }),
    ).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(["deploy", "--config"]);
    expect(calls[0].config.name).toBe("clinic-crm-production");
    expect(calls[0].config.routes).toEqual([
      { pattern: HOST, custom_domain: true },
    ]);
    expect(origins).toEqual([`https://${HOST}/`]);
    // The generated configuration is not left in the build or anywhere else.
    expect(existsSync(join(dist, "wrangler.json"))).toBe(false);
  });

  it("uploads nothing when the preflight blocks (a demo build)", async () => {
    let uploaded = false;
    const status = await publish({
      dist: build(),
      environment: "production",
      hostname: HOST,
      env: { ...ENV, VITE_IS_DEMO: "true" },
      run: () => {
        uploaded = true;
        return 0;
      },
      readOrigin: goodOrigin,
      ...quiet,
    });
    expect(status).toBe(1);
    expect(uploaded).toBe(false);
  });

  it("uploads nothing without the credentials, and refuses a bad hostname before writing", async () => {
    const dist = build();
    await expect(
      publish({
        dist,
        environment: "production",
        hostname: HOST,
        env: { ...ENV, CLOUDFLARE_API_TOKEN: "" },
        run: () => 0,
        ...quiet,
      }),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    await expect(
      publish({
        dist,
        environment: "production",
        hostname: "https://x.org",
        env: ENV,
        run: () => 0,
        ...quiet,
      }),
    ).rejects.toThrow(/hostname/);
    expect(existsSync(join(dist, "_headers"))).toBe(false);
  });

  it("stops on a failed upload without claiming anything was verified", async () => {
    let read = false;
    const status = await publish({
      dist: build(),
      environment: "staging",
      hostname: "staging.clinic-example.org",
      env: ENV,
      run: () => 1,
      readOrigin: async (url) => {
        read = true;
        return goodOrigin(url);
      },
      ...quiet,
    });
    expect(status).toBe(1);
    expect(read).toBe(false);
  });

  it("does not accept the previous release: the live page must load this build's scripts", async () => {
    const previous = PAGE.replace("index-abc.js", "index-OLD.js");
    const served = async (url, html) => {
      const facts = await goodOrigin(url);
      return { ...facts, response: { ...facts.response, html } };
    };
    let calls = 0;
    const stale = await publish({
      dist: build(),
      environment: "production",
      hostname: HOST,
      env: ENV,
      run: () => 0,
      readOrigin: async (url) => {
        calls += 1;
        return served(url, previous);
      },
      attempts: 3,
      ...quiet,
    });
    expect(stale).toBe(1);
    expect(calls).toBe(3);

    let attempt = 0;
    const propagated = await publish({
      dist: build(),
      environment: "production",
      hostname: HOST,
      env: ENV,
      run: () => 0,
      readOrigin: async (url) => {
        attempt += 1;
        return served(url, attempt < 2 ? previous : PAGE);
      },
      attempts: 3,
      ...quiet,
    });
    expect(propagated).toBe(0);
  });

  it("does not accept a custom domain that redirects to another origin", async () => {
    const status = await publish({
      dist: build(),
      environment: "production",
      hostname: HOST,
      env: ENV,
      run: () => 0,
      readOrigin: async () =>
        goodOrigin("https://elsewhere.clinic-example.org/"),
      attempts: 1,
      ...quiet,
    });
    expect(status).toBe(1);
  });

  it("retries while the new version propagates, then passes", async () => {
    let attempts = 0;
    const status = await publish({
      dist: build(),
      environment: "production",
      hostname: HOST,
      env: ENV,
      run: () => 0,
      readOrigin: async (url) => {
        attempts += 1;
        if (attempts < 3) throw new TypeError("fetch failed");
        return goodOrigin(url);
      },
      attempts: 5,
      ...quiet,
    });
    expect(status).toBe(0);
    expect(attempts).toBe(3);
  });

  it("fails, and prints the rollback command, when the live origin never meets the contract", async () => {
    const lines = [];
    const status = await publish({
      dist: build(),
      environment: "production",
      hostname: HOST,
      env: ENV,
      run: () => 0,
      readOrigin: async (url) => {
        const facts = await goodOrigin(url);
        const headers = { ...facts.response.headers };
        delete headers["Strict-Transport-Security"];
        return { ...facts, response: { ...facts.response, headers } };
      },
      attempts: 2,
      sleep: async () => {},
      write: (line) => lines.push(line),
    });
    expect(status).toBe(1);
    expect(lines.join("\n")).toContain(
      `wrangler@${WRANGLER_VERSION} rollback --name clinic-crm-production`,
    );
    expect(lines.join("\n")).not.toContain(ENV.CLOUDFLARE_API_TOKEN);
  });
});

describe("the hosted deploy workflow", () => {
  const workflow = read(".github/workflows/deploy-hosted.yml");
  const code = (text) =>
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

  it("runs only when a person dispatches it, for staging or production", () => {
    const on = workflow.slice(
      workflow.indexOf("\non:"),
      workflow.indexOf("\npermissions:"),
    );
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(
      /\b(push|pull_request|schedule|workflow_run|release):/,
    );
    expect(on).toMatch(/- staging\n\s+- production\n/);
  });

  it("deploys both parts only after the gate and the live-database suites, in the chosen environment", () => {
    const jobOf = (name) => {
      const lines = workflow.split("\n");
      const first = lines.indexOf(`    ${name}:`);
      expect(first, name).toBeGreaterThan(-1);
      const rest = lines.slice(first + 1);
      const next = rest.findIndex((line) => /^ {4}[a-z][a-z-]*:$/.test(line));
      return rest.slice(0, next === -1 ? undefined : next).join("\n");
    };
    for (const name of ["frontend", "runtime"]) {
      const job = jobOf(name);
      expect(job, name).toMatch(/needs: \[gate, database\]/);
      expect(job, name).toMatch(/environment: \$\{\{ inputs\.environment \}\}/);
      expect(job, name).not.toMatch(/\n {8}if:/);
    }
    expect(jobOf("database")).toMatch(
      /uses: \.\/\.github\/workflows\/database\.yml/,
    );
    expect(code(workflow)).not.toMatch(/continue-on-error/);
  });

  it("uploads the frontend only through the publish command, after the build", () => {
    const text = code(workflow);
    expect(text.indexOf("npm run build")).toBeGreaterThan(-1);
    expect(text.indexOf("node scripts/publish-cloudflare.mjs")).toBeGreaterThan(
      text.indexOf("npm run build"),
    );
  });

  it("never runs Wrangler anywhere but inside the publish command", () => {
    for (const path of [
      ".github/workflows/deploy-hosted.yml",
      ".github/workflows/deploy.yml",
      ".github/workflows/check.yml",
      "makefile",
      "package.json",
    ]) {
      expect(code(read(path)), path).not.toMatch(/\bwrangler\b/i);
    }
  });

  it("installs the measured flyctl, verified against its published checksum", () => {
    expect(workflow).toMatch(/FLYCTL_VERSION: \d+\.\d+\.\d+\n/);
    expect(workflow).toMatch(/sha256sum -c -/);
    expect(code(workflow)).not.toMatch(
      /fly\.io\/install\.sh|setup-flyctl@master/,
    );
    expect(workflow).toMatch(
      /flyctl deploy --app "\$\{FLY_APP\}" --config fly\.toml --ha=false/,
    );
    expect(workflow).toMatch(
      /DEPLOYMENT_ENVIRONMENT=\$\{\{ inputs\.environment \}\}/,
    );
  });

  it("pins Wrangler to one measured release", () => {
    expect(WRANGLER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the runtime image and its platform configuration", () => {
  const dockerfile = read("Dockerfile");
  const dockerignore = read(".dockerignore");
  const fly = read("fly.toml");

  it("builds from a digest-pinned base, defaults to production and runs unprivileged", () => {
    const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
    expect(froms.length).toBeGreaterThan(0);
    for (const image of froms) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    const users = [...dockerfile.matchAll(/^USER (\S+)/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe("node");
    expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(dockerfile).not.toMatch(
      /^(ARG|ENV) .*(SECRET|TOKEN|PASSWORD|DATABASE_URL|API_KEY)/m,
    );
  });

  it("admits only the manifests and the engine into the build context", () => {
    const rules = dockerignore
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    expect(rules[0]).toBe("*");
    expect(rules.filter((l) => l.startsWith("!")).sort()).toEqual([
      "!engine/",
      "!package-lock.json",
      "!package.json",
    ]);
    const copies = [...dockerfile.matchAll(/^COPY (?!--from)(.+)$/gm)].map(
      (m) => m[1],
    );
    for (const copy of copies) {
      expect(copy).toMatch(
        /^(package\.json package-lock\.json \.\/|package\.json \.\/|engine \.\/engine)$/,
      );
    }
  });

  it("exposes only the gateway, in São Paulo, with health checks and restarts for both processes", () => {
    expect(fly).toMatch(/^primary_region = "gru"$/m);
    expect(fly).not.toMatch(/^app\s*=/m);
    expect(fly).toMatch(/\[http_service\]\n\s+processes = \["gateway"\]/);
    expect(fly).not.toMatch(/\[\[services\]\]/);
    expect(fly).toMatch(/processes = \["worker"\]\n\s+type = "http"/);
    expect(fly).toMatch(/policy = "always"/);
    const envBlock = fly.slice(
      fly.indexOf("[env]"),
      fly.indexOf("[processes]"),
    );
    const keys = [...envBlock.matchAll(/^\s+([A-Z_]+) = /gm)]
      .map((m) => m[1])
      .sort();
    expect(keys).toEqual([
      "WHATSAPP_GATEWAY_HOST",
      "WHATSAPP_GATEWAY_PORT",
      "WORKER_HEALTH_HOST",
      "WORKER_HEALTH_PORT",
    ]);
  });
});

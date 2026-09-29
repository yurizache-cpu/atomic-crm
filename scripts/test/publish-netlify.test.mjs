import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { auditHeadersFile } from "../host-headers-file.mjs";
import {
  NETLIFY_UPLOADER,
  SPA_FALLBACK,
  STAGED_CONFIG,
  STAGED_SITE,
  publish,
} from "../publish-netlify.mjs";
import {
  hostedSecurityHeaders,
  securityMetaTags,
} from "../security-headers.mjs";

// The Netlify publish path (owner cost-first decision, SI-77), without the
// uploader or an account: the upload and the deployed origin are injected, so
// what is tested is the ORDER (nothing uploads past a blocking preflight,
// nothing passes without the live check) and WHAT leaves the machine (a staged
// copy of the build and a publish-only netlify.toml, nothing else).

const API = "https://project-ref.supabase.co";
const HOST = "clinic-staging.netlify.app";
const SITE = "00000000-0000-4000-8000-000000000000";
const GRANT =
  "https://netlify-mcp.netlify.app/proxy/eyJhbGciOiJkaXIifQ..synthetic.grant-never-printed_1";
const ENV = {
  VITE_SUPABASE_URL: API,
  VITE_SB_PUBLISHABLE_KEY: "sb_publishable_syntheticExampleKey123456",
  NETLIFY_UPLOAD_GRANT: GRANT,
};

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0)
    rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const PAGE = `<!doctype html><html><head>${securityMetaTags({ supabaseUrl: API })}<script type="module" src="./assets/index-abc.js"></script></head><body></body></html>`;
const build = () => {
  const root = mkdtempSync(join(tmpdir(), "netlify-test-"));
  tempDirs.push(root);
  // A source file and an environment file beside the build: neither may leave.
  writeFileSync(join(root, ".env"), "SECRET=never-uploaded\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), PAGE);
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log('x')");
  return dist;
};
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).replace(/\\/g, "/"),
    )
    .sort();
const goodOrigin = async (url) => ({
  response: {
    url,
    status: 200,
    headers: hostedSecurityHeaders({ supabaseUrl: API }),
    html: PAGE,
    assets: [{ path: "assets/index-abc.js", text: "console.log('x')" }],
    assetFailures: [],
    assetsNotChecked: 0,
  },
  httpRedirect: "redirects",
});
const quiet = { write: () => {}, sleep: async () => {} };
const target = { environment: "staging", siteId: SITE, hostname: HOST };

describe("the Netlify publish", () => {
  it("uploads only a staged copy of the build with a publish-only configuration, then verifies the live site", async () => {
    const dist = build();
    const uploads = [];
    const origins = [];
    const status = await publish({
      dist,
      ...target,
      env: ENV,
      upload: ({ cwd, siteId, grant }) => {
        const site = join(cwd, STAGED_SITE);
        uploads.push({
          files: filesUnder(cwd),
          config: readFileSync(join(cwd, "netlify.toml"), "utf8"),
          headers: readFileSync(join(site, "_headers"), "utf8"),
          redirects: readFileSync(join(site, "_redirects"), "utf8"),
          siteId,
          grant,
          cwd,
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
    expect(uploads).toHaveLength(1);
    // The configuration sits outside the served directory and builds nothing.
    expect(uploads[0].files).toEqual([
      "netlify.toml",
      "site/_headers",
      "site/_redirects",
      "site/assets/index-abc.js",
      "site/index.html",
    ]);
    expect(uploads[0].config).toBe('[build]\n  publish = "site"\n');
    expect(uploads[0].config).toBe(STAGED_CONFIG);
    expect(uploads[0]).toMatchObject({ siteId: SITE, grant: GRANT });
    expect(auditHeadersFile(uploads[0].headers, { supabaseUrl: API })).toEqual(
      [],
    );
    expect(uploads[0].redirects).toBe(SPA_FALLBACK);
    // The staged copy is removed once the upload returns; the build is untouched.
    expect(existsSync(uploads[0].cwd)).toBe(false);
    expect(filesUnder(dist)).toEqual(["assets/index-abc.js", "index.html"]);
    expect(origins).toEqual([`https://${HOST}/`]);
  });

  it("uploads nothing when the preflight blocks (a demo build, an unpublished registry)", async () => {
    let uploaded = false;
    const attempt = (dist, env) =>
      publish({
        dist,
        ...target,
        env,
        upload: () => {
          uploaded = true;
          return 0;
        },
        readOrigin: goodOrigin,
        ...quiet,
      });
    expect(await attempt(build(), { ...ENV, VITE_IS_DEMO: "true" })).toBe(1);
    const withRegistry = build();
    mkdirSync(join(withRegistry, "r"));
    writeFileSync(join(withRegistry, "r", "registry.json"), "{}");
    expect(await attempt(withRegistry, ENV)).toBe(1);
    expect(uploaded).toBe(false);
  });

  it("refuses a missing or foreign upload grant, a bad site id or hostname, before anything is staged", async () => {
    const dist = build();
    const attempt = (overrides) =>
      publish({
        dist,
        ...target,
        env: ENV,
        upload: () => 0,
        ...quiet,
        ...overrides,
      });
    await expect(
      attempt({ env: { ...ENV, NETLIFY_UPLOAD_GRANT: "" } }),
    ).rejects.toThrow(/NETLIFY_UPLOAD_GRANT/);
    await expect(
      attempt({
        env: {
          ...ENV,
          NETLIFY_UPLOAD_GRANT: "https://collector.example.org/proxy/abc",
        },
      }),
    ).rejects.toThrow(/NETLIFY_UPLOAD_GRANT/);
    await expect(
      attempt({
        env: { ...ENV, NETLIFY_UPLOAD_GRANT: `${GRANT}&whoami` },
      }),
    ).rejects.toThrow(/NETLIFY_UPLOAD_GRANT/);
    await expect(attempt({ siteId: "atomic-crm-staging" })).rejects.toThrow(
      /site id/,
    );
    await expect(attempt({ hostname: `https://${HOST}` })).rejects.toThrow(
      /hostname/,
    );
    await expect(attempt({ environment: "local" })).rejects.toThrow(
      /environment/,
    );
    expect(filesUnder(dist)).toEqual(["assets/index-abc.js", "index.html"]);
  });

  it("stops on a failed upload without claiming anything was verified", async () => {
    let read = false;
    const status = await publish({
      dist: build(),
      ...target,
      env: ENV,
      upload: () => 1,
      readOrigin: async (url) => {
        read = true;
        return goodOrigin(url);
      },
      ...quiet,
    });
    expect(status).toBe(1);
    expect(read).toBe(false);
  });

  it("does not accept the previous release, and says how to restore without printing the grant", async () => {
    const lines = [];
    const status = await publish({
      dist: build(),
      ...target,
      env: ENV,
      upload: () => 0,
      readOrigin: async (url) => {
        const facts = await goodOrigin(url);
        const html = PAGE.replace("index-abc.js", "index-OLD.js");
        return { ...facts, response: { ...facts.response, html } };
      },
      attempts: 2,
      sleep: async () => {},
      write: (line) => lines.push(line),
    });
    expect(status).toBe(1);
    expect(lines.join("\n")).toContain("Publish deploy");
    expect(lines.join("\n")).not.toContain("synthetic.grant");
  });

  it("pins one read and measured uploader release", () => {
    expect(NETLIFY_UPLOADER).toMatch(/^@netlify\/mcp@\d+\.\d+\.\d+$/);
  });
});

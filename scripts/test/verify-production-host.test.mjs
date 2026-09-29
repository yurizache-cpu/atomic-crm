import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { auditHostResponse } from "../production-contract-host.mjs";
import {
  hostedSecurityHeaders,
  securityMetaTags,
} from "../security-headers.mjs";
import { readDeployedOrigin } from "../verify-production-host.mjs";

// Production Hosting Gate B: the command that reads a DEPLOYED origin. A local
// server stands in for the host, so the reading (the page, its scripts, the
// headers actually sent) is exercised over real HTTP. A local address is only
// ever a self-test (`--local-self-test`), never a production sign-off.

const API = "https://project-ref.supabase.co";
const PAGE = `<!doctype html><html><head>${securityMetaTags({ supabaseUrl: API })}<script type="module" src="./assets/app.js"></script></head><body></body></html>`;

const servers = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A stand-in host: sends `headers` on every response and serves a page and one script. */
const host = async ({
  headers = hostedSecurityHeaders({ supabaseUrl: API }),
  script = "console.log(1)",
} = {}) => {
  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(headers))
      response.setHeader(name, value);
    if (request.url === "/assets/app.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(script);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(PAGE);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
};

const blocking = (findings) =>
  findings.filter((f) => f.severity === "blocking").map((f) => f.rule);

describe("reading a deployed origin", () => {
  it("reads the page, its own-origin scripts and the headers actually sent", async () => {
    const url = await host();
    const { response } = await readDeployedOrigin(url, { allowLocal: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.assets.map((a) => a.path)).toEqual(["assets/app.js"]);
    expect(
      auditHostResponse(response, { supabaseUrl: API, allowLocal: true }),
    ).toEqual([]);
  });

  it("finds a missing header in what was actually sent", async () => {
    const headers = hostedSecurityHeaders({ supabaseUrl: API });
    delete headers["Strict-Transport-Security"];
    const { response } = await readDeployedOrigin(await host({ headers }), {
      allowLocal: true,
    });
    expect(
      blocking(
        auditHostResponse(response, { supabaseUrl: API, allowLocal: true }),
      ),
    ).toEqual(["header-strict-transport-security"]);
  });

  it("finds a local endpoint in a script the page loads", async () => {
    const { response } = await readDeployedOrigin(
      await host({ script: `fetch("http://127.0.0.1:54321/x")` }),
      { allowLocal: true },
    );
    expect(
      blocking(
        auditHostResponse(response, { supabaseUrl: API, allowLocal: true }),
      ),
    ).toEqual(["local-endpoint"]);
  });

  it("without the self-test flag, a local origin is refused whatever it sends", async () => {
    const { response } = await readDeployedOrigin(await host(), {
      allowLocal: true,
    });
    expect(blocking(auditHostResponse(response, { supabaseUrl: API }))).toEqual(
      expect.arrayContaining(["https-required", "public-host-required"]),
    );
  });
});

describe("the command", () => {
  const run = (args, env = {}) =>
    spawnSync(
      process.execPath,
      ["scripts/verify-production-host.mjs", ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, VITE_SUPABASE_URL: "", ...env },
        encoding: "utf8",
      },
    );

  // spawnSync blocks the event loop, which would stop an in-process server from
  // answering: the command talks to a server in a child process instead.
  const childHost = async (headers) => {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const h=require("node:http");const H=${JSON.stringify(headers)};const P=${JSON.stringify(PAGE)};
         h.createServer((q,s)=>{for(const[k,v]of Object.entries(H))s.setHeader(k,v);
           if(q.url==="/assets/app.js"){s.setHeader("Content-Type","text/javascript");s.end("1")}else{s.setHeader("Content-Type","text/html");s.end(P)}})
         .listen(0,"127.0.0.1",function(){console.log(this.address().port)})`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const port = await new Promise((resolve) =>
      child.stdout.once("data", (d) => resolve(Number(String(d).trim()))),
    );
    servers.push({
      close: (done) => {
        child.kill();
        done();
      },
    });
    return `http://127.0.0.1:${port}/`;
  };

  it("exits 0 for a local self-test of a host that sends the declared headers", async () => {
    const url = await childHost(hostedSecurityHeaders({ supabaseUrl: API }));
    const result = run([
      "--url",
      url,
      "--supabase-url",
      API,
      "--local-self-test",
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/SELF-TEST ONLY/);
  });

  it("exits 1 when a header is missing", async () => {
    const headers = hostedSecurityHeaders({ supabaseUrl: API });
    delete headers["Permissions-Policy"];
    const url = await childHost(headers);
    const result = run([
      "--url",
      url,
      "--supabase-url",
      API,
      "--local-self-test",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/header-permissions-policy/);
  });

  it("exits 1, never 0, for a local address without the self-test flag", async () => {
    const url = await childHost(hostedSecurityHeaders({ supabaseUrl: API }));
    const result = run(["--url", url, "--supabase-url", API]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/public-host-required/);
  });

  it("exits 2 when it cannot look, or is asked wrongly", () => {
    expect(
      run([
        "--url",
        "https://127.0.0.1:1/",
        "--supabase-url",
        API,
        "--local-self-test",
      ]).status,
    ).toBe(2);
    expect(run(["--url", "https://clinic.example-domain.org/"]).status).toBe(2);
    expect(run([]).status).toBe(2);
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluate,
  isLoopbackAddress,
  mergeSockets,
  parseGetNetTcpConnection,
  parseNetstat,
  parseSs,
  supabaseContainers,
} from "../local-exposure.mjs";

const SCRIPT = fileURLToPath(new URL("../local-exposure.mjs", import.meta.url));

const container = (name, ports, labels = {}, extra = {}) => ({
  Name: `/${name}`,
  Config: { Labels: labels },
  NetworkSettings: { Ports: ports },
  ...extra,
});

// The state measured on 2026-09-12, before the fix: Docker Desktop published
// Kong and Postgres on every IPv4 and IPv6 interface. Unpublished ports appear
// in real `docker inspect` output as `null`, as pg-meta's does here.
const exposedStack = [
  container(
    "supabase_kong_atomic-crm-e2e",
    {
      "8000/tcp": [
        { HostIp: "0.0.0.0", HostPort: "54341" },
        { HostIp: "::", HostPort: "54341" },
      ],
    },
    { "com.supabase.cli.project": "atomic-crm-e2e" },
  ),
  container(
    "supabase_db_atomic-crm-e2e",
    { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54342" }] },
    { "com.supabase.cli.project": "atomic-crm-e2e" },
  ),
  container(
    "supabase_pg_meta_atomic-crm-e2e",
    { "8080/tcp": null },
    { "com.supabase.cli.project": "atomic-crm-e2e" },
  ),
];

const loopbackStack = [
  container("supabase_kong_atomic-crm-e2e", {
    "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "54341" }],
  }),
  container("supabase_db_atomic-crm-e2e", {
    "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54342" }],
  }),
  container("supabase_pg_meta_atomic-crm-e2e", { "8080/tcp": null }),
];

const loopbackSockets = [
  { address: "127.0.0.1", port: 54341 },
  { address: "127.0.0.1", port: 54342 },
];

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.255.0.9", "::1", "[::1]", "::ffff:127.0.0.1"])(
    "accepts %s",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each([
    "0.0.0.0",
    "::",
    "[::]",
    "",
    "192.168.6.100",
    "172.23.128.1",
    "127.0.0.256",
    "localhost",
    undefined,
  ])("rejects %s, which is not a loopback address", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe("supabaseContainers", () => {
  const others = [
    container("supabase_db_atomic-crm-demo", {}),
    container(
      "unlabelled_but_owned",
      {},
      { "com.supabase.cli.project": "atomic-crm-e2e" },
    ),
    container("some_other_app", {}),
  ];

  it("selects by the CLI's label or by its naming, and never an unrelated container", () => {
    const names = supabaseContainers([...exposedStack, ...others]).map((c) =>
      c.Name.slice(1),
    );
    expect(names).not.toContain("some_other_app");
    expect(names).toContain("unlabelled_but_owned");
    expect(names).toContain("supabase_db_atomic-crm-demo");
  });

  it("scopes to one project without leaking another stack into the verdict", () => {
    const names = supabaseContainers(
      [...exposedStack, ...others],
      "atomic-crm-e2e",
    ).map((c) => c.Name.slice(1));
    expect(names).not.toContain("supabase_db_atomic-crm-demo");
    expect(names).toHaveLength(4);
  });

  it("lets the label decide, so a similarly named project never counts as another", () => {
    // Project ids may contain underscores: supabase_db_atomic_demo ends with
    // `_demo` but belongs to project atomic_demo.
    const foreign = container(
      "supabase_db_atomic_demo",
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54362" }] },
      { "com.supabase.cli.project": "atomic_demo" },
    );
    expect(supabaseContainers([foreign], "demo")).toEqual([]);
    const result = evaluate({
      inspected: [foreign],
      sockets: [{ address: "127.0.0.1", port: 54362 }],
      project: "demo",
    });
    expect(result.status).toBe("unverified");
  });
});

describe("evaluate", () => {
  it("reports the measured pre-fix state as exposed on both layers", () => {
    const result = evaluate({
      inspected: exposedStack,
      sockets: [
        { address: "0.0.0.0", port: 54341 },
        { address: "::", port: 54341 },
        { address: "0.0.0.0", port: 54342 },
      ],
      project: "atomic-crm-e2e",
    });
    expect(result.status).toBe("exposed");
    expect(result.exposures.filter((e) => e.layer === "docker")).toHaveLength(
      3,
    );
    expect(result.exposures.filter((e) => e.layer === "host")).toHaveLength(3);
  });

  it("accepts a stack bound to loopback on Docker and on the host, unpublished ports included", () => {
    const result = evaluate({
      inspected: loopbackStack,
      sockets: loopbackSockets,
      project: "atomic-crm-e2e",
    });
    expect(result.status).toBe("ok");
    expect(result.bindings).toHaveLength(2);
  });

  it("accepts Docker Desktop's loopback-only wslrelay mirror beside a loopback forwarder", () => {
    const result = evaluate({
      inspected: loopbackStack,
      sockets: [
        ...loopbackSockets,
        { address: "::1", port: 54341 },
        { address: "::1", port: 54342 },
      ],
    });
    expect(result.status).toBe("ok");
  });

  it("treats an empty HostIp as every interface", () => {
    const result = evaluate({
      inspected: [
        container("supabase_studio_atomic-crm-e2e", {
          "3000/tcp": [{ HostIp: "", HostPort: "54343" }],
        }),
      ],
      sockets: [{ address: "127.0.0.1", port: 54343 }],
    });
    expect(result.status).toBe("exposed");
  });

  it("catches a host forwarder that ignores Docker's loopback binding", () => {
    const result = evaluate({
      inspected: loopbackStack,
      sockets: [...loopbackSockets, { address: "0.0.0.0", port: 54342 }],
    });
    expect(result.status).toBe("exposed");
    expect(result.exposures).toEqual([
      { layer: "host", detail: "host port 54342 listens on 0.0.0.0" },
    ]);
  });

  it("never reports safe when the host's sockets could not be read", () => {
    const result = evaluate({ inspected: loopbackStack, sockets: null });
    expect(result.status).toBe("unverified");
  });

  it("never reports safe when a published port has no visible socket", () => {
    const result = evaluate({
      inspected: loopbackStack,
      sockets: [{ address: "127.0.0.1", port: 54341 }],
    });
    expect(result.status).toBe("unverified");
    expect(result.unverified.join()).toMatch(/54342/);
  });

  it("never reports safe for a requested project with nothing running", () => {
    const result = evaluate({
      inspected: loopbackStack,
      sockets: loopbackSockets,
      project: "atomic-crm-demo",
    });
    expect(result.status).toBe("unverified");
  });

  it("does not let a loopback socket excuse an exposed Docker binding", () => {
    const result = evaluate({
      inspected: exposedStack,
      sockets: [
        { address: "127.0.0.1", port: 54341 },
        { address: "127.0.0.1", port: 54342 },
      ],
    });
    expect(result.status).toBe("exposed");
  });

  it("never reports safe while a container is restarting and its ports cannot be read", () => {
    const restarting = container(
      "supabase_studio_atomic-crm-e2e",
      {},
      {},
      { State: { Restarting: true } },
    );
    const result = evaluate({
      inspected: [...loopbackStack, restarting],
      sockets: loopbackSockets,
    });
    expect(result.status).toBe("unverified");
    expect(result.unverified.join()).toMatch(/restarting/);
  });

  it("flags an explicit non-loopback binding in the container's configuration", () => {
    const configured = container(
      "supabase_studio_atomic-crm-e2e",
      {},
      {},
      {
        HostConfig: {
          PortBindings: {
            "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "54343" }],
          },
        },
      },
    );
    const result = evaluate({
      inspected: [...loopbackStack, configured],
      sockets: loopbackSockets,
    });
    expect(result.status).toBe("exposed");
  });

  it("never lets a TCP socket vouch for a UDP publish on the same port", () => {
    const result = evaluate({
      inspected: [
        container("supabase_inbucket_atomic-crm-e2e", {
          "1025/udp": [{ HostIp: "127.0.0.1", HostPort: "54350" }],
        }),
      ],
      sockets: [{ address: "127.0.0.1", port: 54350 }],
    });
    expect(result.status).toBe("unverified");
  });
});

describe("socket parsers", () => {
  it("reads Get-NetTCPConnection JSON, whether one socket or many", () => {
    expect(
      parseGetNetTcpConnection('{"LocalAddress":"::","LocalPort":54341}'),
    ).toEqual([{ address: "::", port: 54341 }]);
    expect(
      parseGetNetTcpConnection(
        '[{"LocalAddress":"127.0.0.1","LocalPort":54342},{"LocalAddress":"0.0.0.0","LocalPort":135}]',
      ),
    ).toHaveLength(2);
    expect(parseGetNetTcpConnection("")).toEqual([]);
  });

  it("reads netstat listeners in any display language, and nothing else", () => {
    // Real lines from this machine, plus a localised state, an established
    // connection and a UDP socket that must not be read as listeners.
    const text = [
      "  TCP    0.0.0.0:54341          0.0.0.0:0              LISTENING       28108",
      "  TCP    [::]:54341             [::]:0                 LISTENING       28108",
      "  TCP    [::1]:54342            [::]:0                 LISTENING       2748",
      "  TCP    0.0.0.0:54343          0.0.0.0:0              ESCUTANDO       28108",
      "  TCP    127.0.0.1:50000        127.0.0.1:54341        ESTABLISHED     9999",
      "  UDP    0.0.0.0:5353           *:*                                    1234",
    ].join("\r\n");
    expect(parseNetstat(text)).toEqual([
      { address: "0.0.0.0", port: 54341 },
      { address: "[::]", port: 54341 },
      { address: "[::1]", port: 54342 },
      { address: "0.0.0.0", port: 54343 },
    ]);
  });

  it("reads ss output, where * means every address", () => {
    expect(
      parseSs(
        [
          "LISTEN 0 4096 *:54321 *:*",
          "LISTEN 0 4096 [::1]:54342 [::]:*",
          "LISTEN 0 4096 127.0.0.1:54341 0.0.0.0:*",
        ].join("\n"),
      ),
    ).toEqual([
      { address: "0.0.0.0", port: 54321 },
      { address: "[::1]", port: 54342 },
      { address: "127.0.0.1", port: 54341 },
    ]);
  });

  it("merges the two Windows sources so one IPv6 wildcard socket counts once", () => {
    expect(
      mergeSockets([
        [{ address: "::", port: 54341 }],
        [
          { address: "[::]", port: 54341 },
          { address: "0.0.0.0", port: 54341 },
        ],
      ]),
    ).toEqual([
      { address: "::", port: 54341 },
      { address: "0.0.0.0", port: 54341 },
    ]);
  });
});

describe("the command", () => {
  it("fails closed as a real process when it cannot confirm anything", () => {
    // Guards the entry point itself: a main guard that stopped matching would
    // exit 0 with no output, which test:db must never read as safe.
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--project", "__no_such_supabase_project__"],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/UNVERIFIED:/);
  }, 90_000);
});

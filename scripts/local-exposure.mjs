#!/usr/bin/env node
// Detects local Supabase development services reachable beyond this machine.
//
// A local CLI stack is administrative infrastructure, not an application API:
// Kong routes /pg/ and Studio serves a query route, both running arbitrary SQL
// as postgres with no key, Postgres accepts the default password, and the local
// API keys are public development defaults. None of it may be reachable from
// another device. Measured 2026-09-12: every published port of both local stacks
// on this machine listened on 0.0.0.0 and [::], global IPv6 addresses included.
//
// Two independent layers, because either alone can lie:
//   1. Docker's view. Every effective host binding of every running Supabase CLI
//      container must be a loopback address. An empty HostIp means every
//      interface.
//   2. The host's view. Every listening socket on those host ports must be bound
//      to a loopback address. On Docker Desktop a host-side forwarder owns the
//      socket, so this is what another device would actually reach.
//
// Exit codes: 0 every published port is loopback-only; 1 something is exposed;
// 2 could not verify (Docker unreachable, sockets unreadable, a container
// restarting, a non-TCP publish, a published port with no visible socket,
// nothing running for a requested project, or an internal error).
// "Could not check" is never reported as safe. One nuance: on Docker Desktop's
// WSL2 backend, wslrelay mirrors every published port on [::1], so a port is
// never socket-less there; that mirror is loopback-only and changes no verdict.
//
// Scope: what Supabase CLI containers publish. A relay on some other port
// (netsh portproxy, an SSH tunnel) is outside this check.
//
// Usage:
//   node scripts/local-exposure.mjs                         every Supabase CLI stack
//   node scripts/local-exposure.mjs --project atomic-crm-e2e
//
// It only reads: `docker ps`, `docker inspect`, and the host's listening sockets.

import { execFileSync } from "node:child_process";

export const EXIT = Object.freeze({ ok: 0, exposed: 1, unverified: 2 });

/** An address without brackets or zone id, lowercased. */
export function normalizeAddress(address) {
  return String(address ?? "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase();
}

/** True only for a literal loopback address: 127.0.0.0/8, ::1, or ::ffff:127.x. */
export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const a = normalizeAddress(address);
  if (a === "::1") return true;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  return octets[0] === 127 && octets.every((o) => o >= 0 && o <= 255);
}

const containerName = (c) => String(c?.Name ?? "").replace(/^\//, "");

/**
 * The containers that belong to a Supabase CLI stack: those carrying the CLI's
 * project label, or named `supabase_<service>_<project>` when unlabelled. When a
 * project is requested the label decides; the name is only a fallback, so
 * `supabase_db_atomic_demo` (labelled atomic_demo) never counts as project demo.
 */
export function supabaseContainers(inspected, project) {
  return inspected.filter((c) => {
    const name = containerName(c);
    const owner = c?.Config?.Labels?.["com.supabase.cli.project"];
    if (owner === undefined && !name.startsWith("supabase_")) return false;
    if (!project) return true;
    return owner !== undefined
      ? owner === project
      : name.endsWith(`_${project}`);
  });
}

/** Every effective host binding Docker reports for these containers. */
export function publishedBindings(containers) {
  const bindings = [];
  for (const c of containers) {
    for (const [containerPort, list] of Object.entries(
      c?.NetworkSettings?.Ports ?? {},
    )) {
      for (const b of list ?? []) {
        bindings.push({
          container: containerName(c),
          containerPort,
          protocol: containerPort.split("/")[1] ?? "tcp",
          hostIp: b?.HostIp ?? "",
          hostPort: Number(b?.HostPort),
        });
      }
    }
  }
  return bindings;
}

/** Listening sockets from `Get-NetTCPConnection -State Listen | ConvertTo-Json`. */
export function parseGetNetTcpConnection(json) {
  const text = String(json ?? "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((s) => ({
    address: String(s.LocalAddress),
    port: Number(s.LocalPort),
  }));
}

/**
 * Listening TCP sockets from Windows `netstat -ano`. The state column is
 * localised ("LISTENING", "ESCUTANDO", …), so a listener is recognised by its
 * unconnected foreign address instead: `0.0.0.0:0` or `[::]:0`.
 */
export function parseNetstat(text) {
  const sockets = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s/i.exec(line);
    if (m) sockets.push({ address: m[1], port: Number(m[2]) });
  }
  return sockets;
}

/** Listening sockets from `ss -Hltn`. `*` means every address. */
export function parseSs(text) {
  const sockets = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[3];
    const m = /^(.*):(\d+)$/.exec(local);
    if (!m) continue;
    const address = m[1] === "*" ? "0.0.0.0" : m[1];
    sockets.push({ address, port: Number(m[2]) });
  }
  return sockets;
}

/**
 * One list of sockets from several sources, each socket once. Get-NetTCPConnection
 * spells the IPv6 wildcard `::` and netstat `[::]`; they are the same socket.
 */
export function mergeSockets(lists) {
  const unique = new Map();
  for (const list of lists) {
    for (const s of list) {
      unique.set(`${normalizeAddress(s.address)}|${s.port}`, {
        address: normalizeAddress(s.address),
        port: s.port,
      });
    }
  }
  return [...unique.values()];
}

/**
 * The verdict. `sockets` is null when the host's listening sockets could not be
 * read; that makes the host layer unverified rather than silently skipped.
 */
export function evaluate({ inspected, sockets, project }) {
  const containers = supabaseContainers(inspected, project);
  const bindings = publishedBindings(containers);
  const exposures = [];
  const unverified = [];

  if (project && containers.length === 0) {
    unverified.push(`no running container belongs to project "${project}"`);
  }

  for (const c of containers) {
    const name = containerName(c);
    if (c?.State?.Restarting === true) {
      unverified.push(
        `${name} is restarting, so the ports it will publish cannot be read`,
      );
    }
    // A binding requested with an explicit address is intent even before it is
    // live. An empty one (how the Supabase CLI publishes) is decided at runtime,
    // by the effective binding checked below.
    for (const [containerPort, list] of Object.entries(
      c?.HostConfig?.PortBindings ?? {},
    )) {
      for (const b of list ?? []) {
        if (b?.HostIp && !isLoopbackAddress(b.HostIp)) {
          exposures.push({
            layer: "docker",
            detail: `${name} is configured to publish ${containerPort} on ${b.HostIp}:${b.HostPort}`,
          });
        }
      }
    }
  }

  for (const b of bindings) {
    if (!isLoopbackAddress(b.hostIp)) {
      exposures.push({
        layer: "docker",
        detail: `${b.container} publishes ${b.containerPort} on ${b.hostIp || "<every interface>"}:${b.hostPort}`,
      });
    }
    if (b.protocol !== "tcp") {
      unverified.push(
        `${b.container} publishes ${b.containerPort}; only TCP listeners are read, so its host reach is not verified`,
      );
    }
  }

  const tcpPorts = [
    ...new Set(
      bindings.filter((b) => b.protocol === "tcp").map((b) => b.hostPort),
    ),
  ].sort((x, y) => x - y);

  if (sockets === null) {
    if (tcpPorts.length > 0) {
      unverified.push("the host's listening sockets could not be read");
    }
  } else {
    for (const port of tcpPorts) {
      const onPort = sockets.filter((s) => s.port === port);
      if (onPort.length === 0) {
        unverified.push(
          `host port ${port} is published but no listening socket is visible, so its reach cannot be confirmed`,
        );
        continue;
      }
      for (const s of onPort) {
        if (!isLoopbackAddress(s.address)) {
          exposures.push({
            layer: "host",
            detail: `host port ${port} listens on ${s.address}`,
          });
        }
      }
    }
  }

  const status =
    exposures.length > 0
      ? "exposed"
      : unverified.length > 0
        ? "unverified"
        : "ok";
  return {
    status,
    containers: containers.length,
    bindings,
    exposures,
    unverified,
  };
}

/** The running Supabase CLI containers, inspected. Unrelated containers are never read. */
function readInspected() {
  const ids = new Set();
  for (const filter of ["label=com.supabase.cli.project", "name=supabase_"]) {
    for (const id of execFileSync("docker", ["ps", "-q", "--filter", filter], {
      encoding: "utf8",
    }).split(/\s+/)) {
      if (id) ids.add(id);
    }
  }
  if (ids.size === 0) return [];
  // A container can exit between `ps` and `inspect`; one retry re-lists it.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(
        execFileSync("docker", ["inspect", ...ids], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
}

/**
 * The host's listening sockets, or null when none of the sources could be read.
 * Windows has two sources, merged: Get-NetTCPConnection reports a dual-stack
 * listener once, as `::`, while netstat lists `0.0.0.0` and `[::]` separately.
 * A socket either one sees is a socket another device may reach.
 */
function readSockets() {
  const sources =
    process.platform === "win32"
      ? [
          () =>
            parseGetNetTcpConnection(
              execFileSync(
                "powershell",
                [
                  "-NoProfile",
                  "-Command",
                  "Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort | ConvertTo-Json -Compress",
                ],
                { encoding: "utf8" },
              ),
            ),
          () =>
            parseNetstat(
              execFileSync("netstat", ["-ano"], { encoding: "utf8" }),
            ),
        ]
      : process.platform === "linux"
        ? [() => parseSs(execFileSync("ss", ["-Hltn"], { encoding: "utf8" }))]
        : [];
  const lists = [];
  for (const read of sources) {
    try {
      lists.push(read());
    } catch {
      // Another source may still answer; none answering is reported below.
    }
  }
  return lists.length === 0 ? null : mergeSockets(lists);
}

function parseProject(args) {
  const i = args.findIndex(
    (a) => a === "--project" || a.startsWith("--project="),
  );
  if (i === -1) return undefined;
  return (
    (args[i].includes("=") ? args[i].split("=")[1] : args[i + 1]) || undefined
  );
}

async function isMain() {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (await isMain()) {
  const project = parseProject(process.argv.slice(2));
  const scope = project ? `project ${project}` : "every Supabase CLI stack";
  let result;
  try {
    result = evaluate({
      inspected: readInspected(),
      sockets: readSockets(),
      project,
    });
  } catch (error) {
    // Exit 1 must only ever mean a measured exposure.
    console.error(
      `UNVERIFIED: ${scope} could not be checked (${String(error?.message ?? error).split("\n")[0]}).`,
    );
    process.exit(EXIT.unverified);
  }
  for (const e of result.exposures)
    console.error(`  EXPOSED (${e.layer}): ${e.detail}`);
  for (const u of result.unverified) console.error(`  UNVERIFIED: ${u}`);
  if (result.status === "exposed") {
    console.error(
      `\nEXPOSED: ${scope} is reachable beyond this machine. Set Docker Desktop > Settings > Resources > Network > Port binding behavior to "Localhost only", then recreate the stack (see CLAUDE.md, "Local Supabase must stay on loopback").`,
    );
    process.exit(EXIT.exposed);
  }
  if (result.status === "unverified") {
    console.error(
      `\nUNVERIFIED: could not confirm that ${scope} is loopback-only.`,
    );
    process.exit(EXIT.unverified);
  }
  process.stdout.write(
    result.containers === 0
      ? "OK: no running Supabase CLI container publishes a port.\n"
      : `OK: ${scope} — ${result.containers} container(s), ${result.bindings.length} published binding(s), every one loopback-only on Docker and on the host.\n`,
  );
}

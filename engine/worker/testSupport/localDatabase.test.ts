// The guard that keeps the driver-backed suites and their worker processes on
// the local stack. Each refused shape is one a connection string can take by
// accident (an exported deployment URL, the other working copy's port) or one
// node-postgres would follow somewhere else despite a loopback-looking host.
// Every accepted one is also checked against where node-postgres itself says it
// would connect.

import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  assertLocalTestDatabases,
  loopbackDatabaseTarget,
} from "./localDatabase.ts";

const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54342/postgres";
const WORKER_LOCAL =
  "postgresql://ops_worker_login:dbtest-worker-pw@127.0.0.1:54342/postgres";

/** Accepted strings, with the target the guard returns for each. */
const ACCEPTED: Array<[label: string, url: string, target: string]> = [
  ["the e2e stack on 127.0.0.1", LOCAL, "127.0.0.1:54342/postgres"],
  [
    "localhost, in any case",
    "postgres://u:p@LocalHost:54322/postgres",
    "localhost:54322/postgres",
  ],
  ["IPv6 loopback", "postgresql://u:p@[::1]:5432/db", "[::1]:5432/db"],
  [
    "a percent-encoded password",
    "postgresql://u:p%40ss@127.0.0.1:54342/postgres",
    "127.0.0.1:54342/postgres",
  ],
];

/** Where node-postgres would connect, read from a client given the string and never connected. */
function driverTarget(connectionString: string): string {
  const client = new Client({ connectionString });
  return `${client.host.toLowerCase()}:${client.port}/${client.database}`;
}

describe("a local test database connection string", () => {
  it.each(ACCEPTED)("accepts %s", (_label, url, target) => {
    expect(loopbackDatabaseTarget(url)).toBe(target);
  });

  it.each(ACCEPTED)(
    "names, for %s, the host, port and database node-postgres connects to",
    (_label, url, target) => {
      expect(driverTarget(url)).toBe(target);
    },
  );

  it.each([
    ["a deployment host", "postgresql://u:secret@db.example.com:5432/postgres"],
    ["a private address", "postgresql://u:secret@192.168.1.20:54342/postgres"],
    [
      "a host that only starts like loopback",
      "postgresql://u:secret@127.0.0.1.example.com:5432/postgres",
    ],
    [
      "loopback in the user part only",
      "postgresql://localhost:secret@db.example.com:5432/postgres",
    ],
    [
      "a host query parameter that redirects the connection",
      "postgresql://u:secret@127.0.0.1:54342/postgres?host=db.example.com",
    ],
    [
      "a hostaddr query parameter, in any case",
      "postgresql://u:secret@127.0.0.1:54342/postgres?HostAddr=203.0.113.9",
    ],
    [
      "a port query parameter that moves the connection to another local database",
      "postgresql://u:secret@127.0.0.1:54342/postgres?port=54322",
    ],
    [
      "a percent-encoded port query parameter",
      "postgresql://u:secret@127.0.0.1:54342/postgres?p%6Frt=54322",
    ],
    [
      "a database query parameter",
      "postgresql://u:secret@127.0.0.1:54342/postgres?dbname=other",
    ],
    [
      "a leading space, which node-postgres resolves against the host `base`",
      " postgresql://u:secret@127.0.0.1:54342/postgres",
    ],
    [
      "a newline, which the URL parser drops and node-postgres may not",
      "postgresql://u:secret@127.0.0.1:54342/postgres\n",
    ],
    [
      "a malformed percent escape, which node-postgres re-encodes before parsing",
      "postgresql://u:p%zz@127.0.0.1:54342/postgres",
    ],
    [
      "no database, where node-postgres falls back to the user's name",
      "postgresql://u:secret@127.0.0.1:54342",
    ],
    ["an empty database name", "postgresql://u:secret@127.0.0.1:54342/"],
    ["no host (PGHOST or a socket decides)", "postgresql:///postgres"],
    ["another protocol", "mysql://u:secret@127.0.0.1:3306/db"],
    ["an unparseable string", "not a url"],
  ])("refuses %s", (_label, url) => {
    expect(loopbackDatabaseTarget(url)).toBeUndefined();
  });
});

describe("the admin and worker databases of a driver-backed run", () => {
  it("accepts both on the same local database", () => {
    expect(() => assertLocalTestDatabases(LOCAL, WORKER_LOCAL)).not.toThrow();
  });

  it("refuses a worker on another local database, such as the other working copy's port, naming no value", () => {
    const elsewhere =
      "postgresql://ops_worker_login:dbtest-worker-pw@127.0.0.1:54322/postgres";

    const run = () => assertLocalTestDatabases(LOCAL, elsewhere);

    expect(run).toThrow(/name different databases/);
    expect(run).not.toThrow(/54322|dbtest-worker-pw/);
  });

  it("refuses a remote worker or admin database, naming the variable and never its value", () => {
    const remote =
      "postgresql://u:dbtest-remote-pw@db.example.com:5432/postgres";

    expect(() => assertLocalTestDatabases(LOCAL, remote)).toThrow(
      /^Refusing to run: OPS_WORKER_DATABASE_URL does not name a database on this machine/,
    );
    expect(() => assertLocalTestDatabases(remote, WORKER_LOCAL)).toThrow(
      /^Refusing to run: ADMIN_DATABASE_URL/,
    );
    for (const [admin, worker] of [
      [LOCAL, remote],
      [remote, WORKER_LOCAL],
    ]) {
      expect(() => assertLocalTestDatabases(admin, worker)).not.toThrow(
        /db\.example\.com|dbtest-remote-pw/,
      );
    }
  });
});

// The driver-backed suites, and the worker processes they spawn, write to the
// database they are given, lease the head of its WHOLE queue, and answer agent
// runs with canned model output. On any database but the local stack that is
// corruption, not a test: a fake assessment would be recorded as a real run's
// result. So every connection string they use must name THIS machine, and the
// worker's must name the database the fixture provisions and inspects.
//
// Strict on purpose: whatever node-postgres would read differently from the URL
// checked here is refused rather than parsed around. Its `host`, `port` and
// database query parameters override the URL's own; a URL without a host falls
// back to PGHOST or a socket, and one without a database to the user's name; and
// a string holding whitespace or a malformed percent escape is re-encoded before
// node-postgres parses it (a leading space sends it to the host `base`), while
// the URL parser here drops or keeps those characters. Errors name the variable,
// never its value.

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

/** Query parameters that name, or could name, where the connection goes. */
const TARGET_OVERRIDES: ReadonlySet<string> = new Set([
  "host",
  "hostaddr",
  "port",
  "database",
  "dbname",
]);

/** Whitespace, or a percent sign not followed by two hex digits: node-postgres re-encodes the string. */
const REENCODED_BY_DRIVER = /\s|%(?![0-9a-f]{2})/i;

/**
 * `host:port/database` when the connection string names a database on this
 * machine and nothing in it can redirect the connection elsewhere; undefined
 * otherwise, including when it cannot be parsed.
 */
export function loopbackDatabaseTarget(
  connectionString: string,
): string | undefined {
  if (REENCODED_BY_DRIVER.test(connectionString)) return undefined;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return undefined;
  }
  // A non-special scheme keeps the host as written, so case is folded here.
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return undefined;
  for (const key of url.searchParams.keys()) {
    if (TARGET_OVERRIDES.has(key.toLowerCase())) return undefined;
  }
  if (url.pathname.length <= 1) return undefined;
  return `${host}:${url.port}${url.pathname}`;
}

/** Throws unless both name the same loopback database. The message names variables only. */
export function assertLocalTestDatabases(
  adminConnectionString: string,
  workerConnectionString: string,
): void {
  const admin = loopbackDatabaseTarget(adminConnectionString);
  if (!admin) {
    throw new Error(
      "Refusing to run: ADMIN_DATABASE_URL (or SUPABASE_DB_HOST) does not name a database on this machine (127.0.0.1, localhost or [::1]). The driver-backed suites delete and rewrite ops rows on it.",
    );
  }
  const worker = loopbackDatabaseTarget(workerConnectionString);
  if (!worker) {
    throw new Error(
      "Refusing to run: OPS_WORKER_DATABASE_URL does not name a database on this machine (127.0.0.1, localhost or [::1]). The test workers lease the head of its queue and answer it with canned model output.",
    );
  }
  if (admin !== worker) {
    throw new Error(
      "Refusing to run: OPS_WORKER_DATABASE_URL and ADMIN_DATABASE_URL name different databases (host, port or database). The worker role is provisioned, and every result is read, on the admin database; a worker elsewhere would lease another database's queue.",
    );
  }
}

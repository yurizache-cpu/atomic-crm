// Build scanner rules (scripts/scan-build-artifacts.mjs): database
// connection strings that carry a password, in URL form and in libpq
// keyword/value form. `\x60` is the backtick.

import { NOT_INTERPOLATION } from "./scan-build-patterns.mjs";

/** The libpq connection keywords a keyword/value connection string uses. */
const LIBPQ_KEYWORDS = [
  "host",
  "hostaddr",
  "port",
  "dbname",
  "user",
  "password",
  "passfile",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "connect_timeout",
  "application_name",
  "options",
  "target_session_attrs",
];

// A libpq keyword/value pair, and the password pair, whose value (quoted or
// not) must be a literal.
const LIBPQ_PAIR = String.raw`(?:${LIBPQ_KEYWORDS.join("|")})=(?:'[^'\\]*'|[^\s'"\x60\\]+)`;
const LIBPQ_PASSWORD = String.raw`password=(?:'${NOT_INTERPOLATION}[^'\\]+'|${NOT_INTERPOLATION}[^\s'"\x60\\]+)`;
// One character, or one escape sequence, of a URL part that `stop` ends.
const urlChar = (stop = "") =>
  String.raw`(?:[^\s"'\x60\\${stop}]|\\+[^\s"'\x60\\${stop}])`;
// A URL part that is not only template interpolations: `${password}` is code
// building the URL, while `${p}literal` or a literal after an interpolated
// user still carries a credential.
const literalUrlPart = (stop) =>
  String.raw`(?:\$\{[^}\s"'\x60]*\})*(?:[^\s"'\x60\\$${stop}]|\$(?!\{)|\\+[^\s"'\x60\\${stop}])${urlChar(stop)}*`;

/** A connection string, as a URL, then as libpq keyword/value pairs. */
export const CONNECTION_STRING_RULES = [
  {
    id: "postgres-connection-string",
    severity: "critical",
    // Only with a password in it; a bare host:port is not a secret. Two
    // places carry one: the userinfo (`user:password@host`) and libpq's URI
    // query parameter (`?user=…&password=…`, also the `jdbc:` form). The user
    // may be empty or hold `@` and `/` (an Azure single-server login is
    // `user@server`), and the host may be empty (a socket directory given as
    // `?host=/…`). The slashes may be escaped once or twice (JSON, then a
    // source map), and the password may hold escapes. A password made only of
    // template interpolations is code; a literal one is a finding whatever
    // the user is. A redacted report shows the match's last characters, so
    // the userinfo form runs on through the path (an empty host would
    // otherwise end it on the password) and the query form stops before the
    // password.
    // Measured 2026-09-23: 0 in the build and in all of node_modules.
    pattern: new RegExp(
      String.raw`postgres(?:ql)?:\\*/\\*/(?:${urlChar(":")}*:${literalUrlPart("@")}@[^\s"'\x60/\\]*(?:\\*/${urlChar("?#")}*)?|${urlChar()}*?[?&]password=(?=${literalUrlPart("&#")}))`,
      "g",
    ),
    describe: () => "PostgreSQL connection string with credentials",
  },
  {
    id: "libpq-connection-string",
    severity: "critical",
    // The other spelling of a connection string: space-separated libpq
    // keyword/value pairs, one of them the password. `verify` wants a host,
    // dbname or user keyword in the same run, so a lone password pair (a
    // query string, a form field) is not a finding.
    // Keywords with spaces around their `=` are not read. Measured
    // 2026-09-23: 0 in the build and in all of node_modules.
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_])(?:${LIBPQ_PAIR}[ \t]+)*${LIBPQ_PASSWORD}(?:[ \t]+${LIBPQ_PAIR})*`,
      "g",
    ),
    verify: (m) => /(?<![A-Za-z0-9_])(?:host|hostaddr|dbname|user)=/.test(m),
    describe: () => "libpq connection string with a password",
  },
];

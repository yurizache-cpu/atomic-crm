// Whether a `VITE_` variable name says its value is a server secret: the
// predicate behind the build scanner's privileged-vite-variable rule
// (scripts/scan-build-rules-names.mjs), re-exported by
// scripts/scan-build-artifacts.mjs.

/*
 * How a `VITE_` name is read. Its words are its underscore-, camelCase- and
 * digit-delimited parts, upper-cased, without the prefix: `dbPassword2` is
 * DB PASSWORD 2. A word matches only whole (SECRET is not SECRETARY, ADMIN is
 * not ADMINISTRATOR, PASS is not BYPASS), except where a list below says so.
 * Every name in SERVER_SECRET_NAMES is a finding once it carries the prefix,
 * so assigned-server-secret does not have to read the prefixed spelling.
 */

/**
 * Words and compounds that make a `VITE_` name privileged wherever they stand
 * in it. SIGNING covers SIGNING_KEY. WORKER and GATEWAY count only as the
 * Company OS credential prefixes OPS_WORKER and OPS_GATEWAY or next to KEY: a
 * bare `WORKER` is in Vite's own placeholder names (`__VITE_WORKER_ASSET__`),
 * and a public gateway URL is ordinary configuration. WhatsApp is a
 * backend-only transport (ADR 0018), so any WHATSAPP word is privileged.
 * CONNECTION counts only as a database connection or a connection string or
 * URL, not as a timeout.
 */
const PRIVILEGED_VITE_WORDS = [
  "SERVICE_ROLE",
  "SERVICE_KEY",
  "PRIVATE",
  "SIGNING",
  "DATABASE_URL",
  "DATABASE_URI",
  "DB_URL",
  "DB_URI",
  "POSTGRES_URL",
  "POSTGRES_URI",
  "PG_URL",
  "PG_URI",
  "DB_CONNECTION",
  "DATABASE_CONNECTION",
  "PG_CONNECTION",
  "CONNECTION_STRING",
  "CONNECTION_URL",
  "CONNECTION_URI",
  "CONN_STRING",
  "CONN_STR",
  "ADMIN",
  "OPS_WORKER",
  "OPS_GATEWAY",
  "WORKER_KEY",
  "GATEWAY_KEY",
  "WHATSAPP",
];

/**
 * The same compounds written as one word (`VITE_SERVICEROLE_KEY`,
 * `VITE_PRIVATEKEY`): a word that CONTAINS one of these is privileged.
 */
const PRIVILEGED_VITE_GLUED = [
  "SERVICEROLE",
  "SERVICEKEY",
  "PRIVATEKEY",
  "SIGNINGKEY",
  "DATABASEURL",
  "DBURL",
  "PGURL",
  "POSTGRESURL",
];

/**
 * Words that hold a credential wherever they stand, and as the END of a word
 * (JWTSECRET, DBPASSWORD, ACCESSTOKEN): ACCESS_TOKEN, VERIFY_TOKEN, META_TOKEN,
 * JWT_SECRET and APP_SECRET are all covered here. A qualifier after the word
 * (`…_PASSWORD_PROD`, `…_TOKEN_2`) does not change what the value is. The one
 * exception is a next word from PRIVILEGED_VITE_ABOUT_WORDS: then the name is
 * ABOUT the credential, not the credential. TOKENS is not here: design tokens
 * and model token limits are ordinary frontend configuration.
 */
const PRIVILEGED_VITE_CREDENTIAL_WORDS = [
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "SECRET",
  "SECRETS",
  "TOKEN",
];

/**
 * A word right after a credential word that makes the name a setting about
 * the credential: the SPA's own VITE_DISABLE_EMAIL_PASSWORD_AUTHENTICATION is a
 * boolean about password login, `…_PASSWORD_MIN_LENGTH` a rule and
 * `…_TOKEN_URL` a public endpoint. Kept short on purpose: every word added
 * here is a name the rule stops reading.
 */
const PRIVILEGED_VITE_ABOUT_WORDS = [
  "AUTH",
  "AUTHENTICATION",
  "LOGIN",
  "RESET",
  "RECOVERY",
  "MIN",
  "MAX",
  "LENGTH",
  "POLICY",
  "STRENGTH",
  "REFRESH",
  "INTERVAL",
  "EXPIRY",
  "EXPIRES",
  "TTL",
  "URL",
  "URI",
  "ENDPOINT",
  "PATH",
];

/**
 * Abbreviations that are a credential only as the LAST word, once a trailing
 * environment or number is set aside (`VITE_DB_PASS`, `VITE_PG_PWD_PROD`,
 * `VITE_SMTP_PASS2`): elsewhere PASS reads as a verb (`…_PASS_THROUGH`).
 */
const PRIVILEGED_VITE_FINAL_WORDS = ["PASS", "PWD"];

/** Trailing qualifiers a final-word check looks past. */
const VITE_NAME_QUALIFIERS = [
  "PROD",
  "PRODUCTION",
  "STAGING",
  "STAGE",
  "DEV",
  "DEVELOPMENT",
  "TEST",
  "TESTING",
  "LOCAL",
  "PREVIEW",
  "QA",
  "SANDBOX",
];

/**
 * A `VITE_` name's words, without the prefix: a camelCase or digit boundary
 * reads as an underscore, so `dbPassword2` is DB PASSWORD 2.
 */
const viteNameWords = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Za-z])([0-9])/g, "$1_$2")
    .replace(/([0-9])([A-Za-z])/g, "$1_$2")
    .toUpperCase()
    .split("_")
    .filter(Boolean)
    .slice(1);

const isCredentialWord = (word) =>
  PRIVILEGED_VITE_CREDENTIAL_WORDS.some((credential) =>
    word.endsWith(credential),
  );

/** The words left once trailing environments and numbers are set aside. */
const withoutQualifiers = (words) => {
  const end = words.findLastIndex(
    (word) => !/^\d+$/.test(word) && !VITE_NAME_QUALIFIERS.includes(word),
  );
  return words.slice(0, end + 1);
};

/**
 * Whether a `VITE_` name says its value is a server secret. Exported so a
 * source-level check can hold the build inputs to the same rule: the
 * build-level rule needs the name to survive into the build, and Vite keeps
 * it there only in a source map or a whole `import.meta.env` object.
 *
 * @param {string} name
 */
export const isPrivilegedViteName = (name) => {
  const words = viteNameWords(name);
  const joined = `_${words.join("_")}_`;
  const core = withoutQualifiers(words);
  return (
    PRIVILEGED_VITE_WORDS.some((word) => joined.includes(`_${word}_`)) ||
    words.some((word) =>
      PRIVILEGED_VITE_GLUED.some((glued) => word.includes(glued)),
    ) ||
    words.some(
      (word, i) =>
        isCredentialWord(word) &&
        !PRIVILEGED_VITE_ABOUT_WORDS.includes(words[i + 1]),
    ) ||
    PRIVILEGED_VITE_FINAL_WORDS.includes(core.at(-1))
  );
};

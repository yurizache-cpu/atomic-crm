// Build scanner rules (scripts/scan-build-artifacts.mjs) that key on a
// variable NAME: a model provider or other privileged `VITE_` name, and a
// server-only name assigned a value. `\x60` is the backtick.

import {
  BARE_VALUE_CHAR,
  LINE_START,
  NAME_START,
  NOT_INTERPOLATION,
  QUOTE,
  VALUE_CHAR,
  assignedName,
  assignedValue,
} from "./scan-build-patterns.mjs";
import { isPrivilegedViteName } from "./scan-build-vite-names.mjs";

/**
 * What names a model provider credential or its routing configuration. Matched
 * in either case: Vite exposes a lower-case `VITE_` name exactly as it exposes
 * the upper-case spelling. AZURE_OPENAI needs no entry of its own; OPENAI covers
 * it. OPEN_AI and CLAUDE are the other spellings people reach for.
 */
const MODEL_PROVIDER_NAME_PARTS = [
  "OPENAI",
  "OPEN_AI",
  "ANTHROPIC",
  "CLAUDE",
  "AGENT_MODEL",
  "MODEL_PROVIDER",
];

/**
 * Server-only variable names, matched exactly. Kept alongside the classes:
 * a name is the only thing that identifies a secret with no shape of its own
 * (a verify token, an app secret, a password). The Phase 2C names are brief
 * §15's list.
 */
const SERVER_SECRET_NAMES = [
  "SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_PASSWORD",
  "POSTMARK_WEBHOOK_PASSWORD",
  "SUPABASE_ACCESS_TOKEN",
  "JWT_SECRET",
  "DEPLOY_TOKEN",
  "OPS_WORKER_PASSWORD",
  "OPS_WORKER_DATABASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  // Phase 2C: the owner CLI's database, the gateway's login and the WhatsApp
  // Cloud API credentials.
  "ADMIN_DATABASE_URL",
  "OPS_GATEWAY_PASSWORD",
  "OPS_GATEWAY_DATABASE_URL",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
];

const anyCase = (part) =>
  part.replace(/[A-Z]/g, (c) => `[${c}${c.toLowerCase()}]`);

/**
 * Resolves `\uXXXX`, `\u{…}` and `\xXX` escapes, however many backslashes lead
 * them (a source map escapes the backslash of an escape once more). Only for a
 * rule that keys on a NAME: a letter spelled as an escape is still that letter.
 * A literal name is never altered, because every escape starts with a backslash
 * and no name contains one.
 */
const decodeCodeEscapes = (content) =>
  content.replace(
    /\\+(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g,
    (escape, braced, unicode, hex) => {
      const codePoint = parseInt(braced ?? unicode ?? hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
    },
  );

/** Provider and privileged `VITE_` names, then server names with a value. */
export const NAME_RULES = [
  {
    id: "browser-model-provider-variable",
    severity: "critical",
    // Provider credentials and routing configuration are backend-only (Phase
    // 1D): the worker reads them from its own environment. Vite hands every
    // `VITE_` variable to the bundle, so a provider name carrying that prefix
    // proves its value was on its way to a static host, key-shaped or not.
    //
    // A bare NAME match, unlike assigned-server-secret below, because a build
    // spells the name many ways: `import.meta.env.X`, a key of the object Vite
    // inlines (`{"X":"…"}`), `X=` in an embedded .env, and all of those again
    // escaped inside a source map's sourcesContent (`\"X\":`, `\nX=`). There is
    // no leading `\b`: the `n` of an escaped newline is a word character. The
    // match stops where the name does, so a finding never carries a value.
    // Measured 2026-09-14: 0 matches in dist and in node_modules.
    pattern: new RegExp(
      `VITE_[A-Za-z0-9_]*?(?:${MODEL_PROVIDER_NAME_PARTS.map(anyCase).join("|")})[A-Za-z0-9_]*`,
      "g",
    ),
    normalize: decodeCodeEscapes,
    describe: (m) => `model provider variable exposed to the browser (${m})`,
  },
  {
    id: "privileged-vite-variable",
    severity: "critical",
    // The same reasoning for every other server secret: a `VITE_` name whose
    // words say it holds a password, a secret, a private or signing key, a
    // database URL, an admin or service-role credential, a token, or a
    // worker, gateway or WhatsApp credential (isPrivilegedViteName). A bare
    // NAME match in every spelling, like the rule above, and never a value.
    // Every `VITE_` name in the repository on 2026-09-23 (src, demo, the
    // .env files, the vite configs, deploy.yml) and every `VITE_` placeholder
    // in Vite 7's own output is not a finding; measured 2026-09-23: 0 in the
    // build, 0 in all of node_modules.
    //
    // IT NEEDS THE SOURCE MAPS. Vite replaces `import.meta.env.VITE_X` with
    // the value itself, so the NAME reaches the build only in a source map's
    // sourcesContent or in an `import.meta.env` object used whole. Measured
    // 2026-09-23 on a throwaway Vite 7 build: two planted privileged names
    // were 2 findings with `build.sourcemap: true` (both in the .map) and 0
    // without. vite.config.ts publishes maps today; if they are turned off
    // (docs/ROADMAP.md plans it), this rule goes blind, so the CLI prints a
    // note for a build with scripts and no map, and the scanner's test holds
    // every build input to isPrivilegedViteName at the source level.
    pattern: /VITE_[A-Za-z0-9_]+/g,
    normalize: decodeCodeEscapes,
    verify: (m) => isPrivilegedViteName(m),
    describe: (m) => `privileged variable exposed to the browser (${m})`,
  },
  {
    id: "assigned-server-secret",
    severity: "high",
    // A server-only variable NAME with a non-trivial value next to it: the
    // name survived into the bundle (a `define`, a bundled server module, an
    // imported .env file). The prefixed spelling of each name is
    // privileged-vite-variable's or browser-model-provider-variable's, so one
    // leak is one finding. Read in every spelling a build produces: `NAME:"…"`,
    // `NAME = '…'`, a template literal, a key of an inlined env object
    // (`{"NAME":"…"}`), the same escaped in a source map (`\"NAME\":\"…\"`,
    // `NAME=\"…\"`), and an unquoted `.env` line (`NAME=…` at the start of a
    // line, or after an escaped newline). A value may hold escapes (see
    // VALUE_CHAR). Measured 2026-09-23 on a throwaway Vite build that planted
    // each Phase 2C secret in a bundled module and in `VITE_` variables: the
    // rules before this change found 2 findings (the two connection strings),
    // these find 28 across the bundle and its map.
    pattern: new RegExp(
      String.raw`${NAME_START}(?:${SERVER_SECRET_NAMES.join("|")})${QUOTE}?\s*[:=]\s*${QUOTE}${NOT_INTERPOLATION}${VALUE_CHAR}{8,}${QUOTE}|${LINE_START}(?:${SERVER_SECRET_NAMES.join("|")})=${NOT_INTERPOLATION}${BARE_VALUE_CHAR}{8,}`,
      "gm",
    ),
    normalize: decodeCodeEscapes,
    // `const NAME = "NAME"` names the variable, it does not hold its value:
    // engine/cli/agentRunSmoke.ts declares its environment that way.
    verify: (m) => assignedValue(m) !== assignedName(m),
    describe: (m) =>
      `server-only variable assigned a value (${assignedName(m)})`,
  },
];

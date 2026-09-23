// Build scanner rules (scripts/scan-build-artifacts.mjs): token-shaped
// credentials. GitHub, AWS, model provider and Meta tokens by their shape,
// a literal bearer credential, and a generic credential field assigned a
// literal. `\x60` is the backtick.

import {
  NAME_START,
  NOT_INTERPOLATION,
  QUOTE,
  VALUE_CHAR,
  assignedValue,
} from "./scan-build-patterns.mjs";
import { isPublicApiKey } from "./scan-build-rules-supabase-keys.mjs";

/** Generic credential fields whose literal value is a secret. */
const TOKEN_FIELDS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "api_key",
];

/** Tokens by their shape, then literals in a bearer or credential field. */
export const TOKEN_RULES = [
  {
    id: "github-token",
    severity: "critical",
    pattern:
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    describe: () => "GitHub token",
  },
  {
    id: "aws-access-key",
    severity: "critical",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    describe: () => "AWS access key id",
  },
  {
    id: "anthropic-api-key",
    severity: "critical",
    // A model provider key belongs to the worker's environment only (Phase 1D).
    // No row-level policy narrows it: whoever reads it off a static host can
    // bill the account and call every model it reaches.
    //
    // Every `sk-ant-` family, not only `api03`/`admin01`. The OpenAI rule below
    // skips ALL of `sk-ant-`, so the two rules must cover complementary halves
    // of `sk-`: a pattern naming only `api|admin` here left OAuth (`oat01`,
    // `ort01`) and session (`sid01`) tokens refused by neither rule.
    // Measured 2026-09-14: 0 matches in dist, node_modules, src, engine,
    // supabase/functions, docs and scripts.
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    describe: () => "Anthropic credential (sk-ant-…)",
  },
  {
    id: "openai-api-key",
    severity: "critical",
    // `\b` needs a non-word character before `sk`, so "risk-assessment-…" or
    // "task-management-…" never match: their `s` follows a letter. The
    // lookahead leaves `sk-ant-` to the rule above, so one key is one finding.
    // Measured 2026-09-14: neither provider rule matches anything in the
    // current build or in node_modules (47,009 text files).
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    describe: () => "OpenAI API key (sk-…)",
  },
  {
    id: "meta-access-token",
    severity: "critical",
    // A Meta (WhatsApp Cloud API) access token: `EAA` and a long alphanumeric
    // body. It sends messages as the business, so it is the transport's whole
    // authority (ADR 0018). Bounded on both sides by a quote, whitespace or a
    // delimiter, so it never matches inside a base64 blob (whose neighbours
    // are base64 characters) or a source map's `mappings` (whose segments are
    // a few characters between commas). A line continuation (a backslash and
    // a real newline) is not a boundary: measured 2026-09-23, Storybook ships
    // a base64 blob wrapped that way, and one 140-character line of it starts
    // with `EAA`. After that: 0 in the build and 0 in all of node_modules
    // (48,371 text files).
    pattern: new RegExp(
      String.raw`(?:(?<=\\[nrt])|(?<![A-Za-z0-9+/_.\-]))(?<!\\\r?\n)EAA[A-Za-z0-9]{100,}(?!\\\r?\n)(?=$|[\s"'\x60\\,;)\]}&<|])`,
      "g",
    ),
    describe: () => "Meta access token (EAA…)",
  },
  {
    id: "bearer-credential",
    severity: "high",
    // A literal credential after `Bearer` (an Authorization header or a
    // hard-coded fetch option). Code builds the header from a variable or a
    // template (`Bearer ${token}`, `"Bearer "+t`), which never matches: the
    // character after the space is a quote or `$`. The public API key is the
    // one bearer the SPA legitimately sends, in either format, and is skipped;
    // the run must end the token, so a long identifier called as a function
    // is not one. Measured 2026-09-23: 0 in the build and in all of
    // node_modules.
    pattern: new RegExp(
      String.raw`${NAME_START}(?:[Bb]earer|BEARER)[ \t]+[A-Za-z0-9._~+/=\-]{20,}(?![A-Za-z0-9._~+/=(\-])`,
      "g",
    ),
    verify: (m) => !isPublicApiKey(m.replace(/^\S+[ \t]+/, "")),
    describe: () => "literal bearer credential",
  },
  {
    id: "assigned-token-literal",
    severity: "high",
    // A generic credential field assigned a literal: `access_token:"…"`,
    // `"refresh_token":"…"`, `client_secret='…'`, `api_key=\"…\"`, or a URL
    // parameter (`#access_token=…`). A session or OAuth token in a bundle is
    // somebody's live credential. Lower-case snake_case only: the upper-case
    // environment names are assigned-server-secret's, in
    // scan-build-rules-names.mjs. The public API key is skipped.
    // Measured 2026-09-23: 0 in the build and in all of node_modules.
    pattern: new RegExp(
      String.raw`(?:(?:(?<=\\[nrt])|(?<![A-Za-z0-9]))(?:${TOKEN_FIELDS.join("|")})${QUOTE}?\s*[:=]\s*${QUOTE}${NOT_INTERPOLATION}${VALUE_CHAR}{20,}${QUOTE}|(?<=[?&#])(?:${TOKEN_FIELDS.join("|")})=[A-Za-z0-9._~%+/=\-]{20,})`,
      "g",
    ),
    verify: (m) => !isPublicApiKey(assignedValue(m)),
    describe: (m) =>
      `credential field assigned a literal (${m.match(/^[a-z_]+/)[0]})`,
  },
];

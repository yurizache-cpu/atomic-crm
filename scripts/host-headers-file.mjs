// The `_headers` file a static host reads (Cloudflare Workers static assets; the
// same format is Netlify's): the declared header set (scripts/security-headers.mjs)
// for every path. Written into the build by scripts/publish-cloudflare.mjs, and
// checked by the production preflight, so what the host is told to send is the
// contract and never a hand-edited copy.
//
//   /*
//     Content-Security-Policy: ...
//     Strict-Transport-Security: ...

import { hostedSecurityHeaders } from "./security-headers.mjs";

export const HEADERS_FILE = "_headers";

/** The file's text for the configured API. */
export function renderHeadersFile({ supabaseUrl }) {
  const headers = hostedSecurityHeaders({ supabaseUrl });
  const lines = ["/*"];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`  ${name}: ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The file's rules, as `[{ path, headers: {name: value} }]`, in order. A header
 * line before any path, or one without a colon, is reported as `invalid`.
 */
export function parseHeadersFile(text) {
  const rules = [];
  const invalid = [];
  for (const [index, raw] of text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .entries()) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ path: raw.trim(), headers: {} });
      continue;
    }
    const colon = raw.indexOf(":");
    if (rules.length === 0 || colon === -1) {
      invalid.push(index + 1);
      continue;
    }
    const name = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    const headers = rules.at(-1).headers;
    // A header set twice for one path is joined with a comma by the host.
    headers[name] =
      headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { rules, invalid };
}

/**
 * Findings when the file does not tell the host to send exactly the declared
 * set for every path: one rule, `/*`, with every declared header at its
 * declared value, and no other rule that could add to or weaken it.
 */
export function auditHeadersFile(text, { supabaseUrl }) {
  const finding = (detail) => ({
    rule: "host-headers-file",
    severity: "blocking",
    file: HEADERS_FILE,
    detail,
  });
  const { rules, invalid } = parseHeadersFile(text);
  const findings = invalid.map((line) =>
    finding(`line ${line} is not a path or a "Name: value" header under one`),
  );
  const extra = rules.filter((rule) => rule.path !== "/*");
  if (extra.length > 0 || rules.length !== 1) {
    findings.push(
      finding(
        "the file must hold exactly one rule, /*: another rule could add a header to, or weaken one for, some paths",
      ),
    );
  }
  const all = rules.find((rule) => rule.path === "/*")?.headers ?? {};
  const expected = hostedSecurityHeaders({ supabaseUrl });
  for (const [name, value] of Object.entries(expected)) {
    if (all[name] === undefined) {
      findings.push(finding(`/* does not set ${name}`));
    } else if (all[name] !== value) {
      findings.push(
        finding(`/* sets ${name} to a value other than the declared one`),
      );
    }
  }
  for (const name of Object.keys(all)) {
    if (!(name in expected)) {
      findings.push(
        finding(`/* sets ${name}, which the contract does not declare`),
      );
    }
  }
  return findings;
}

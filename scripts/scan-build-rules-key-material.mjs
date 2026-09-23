// Build scanner rules (scripts/scan-build-artifacts.mjs): private and
// signing key material, as a PEM block or as a JSON Web Key. A finding
// withholds the value entirely, not even a redacted prefix. `\x60` is the
// backtick.

import { NAME_START } from "./scan-build-patterns.mjs";

/** How far either side of a JWK `d` member to look for its `kty`. */
const JWK_WINDOW = 1500;

/** A PEM private key, then a JWK's private or symmetric secret. */
export const KEY_MATERIAL_RULES = [
  {
    id: "private-key-block",
    severity: "critical",
    // Every PEM private key label, the encrypted PKCS#8 and armoured PGP
    // forms included: an encrypted key is one weak passphrase from a key.
    // The armoured PGP header ends in `KEY BLOCK-----`, which the pattern
    // before 2026-09-23 could not match.
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    withholdValue: true,
    describe: () => "PEM private key block",
  },
  {
    id: "private-jwk",
    severity: "critical",
    // The private member of a JSON Web Key, as JSON, as the object literal a
    // bundler turns an imported .json file into, or escaped inside a source
    // map. A signing key file (`[{"kty":…,"d":…}]`) or a key set
    // (`{"keys":[…]}`) is the same shape. `verify` insists on a `kty` nearby,
    // so an unrelated `d:"…"` is not a finding; the window spans an RSA-8192
    // modulus, which can sit between the two.
    pattern: /(?:\\*"d\\*"|\bd)\s*:\s*\\*["'`][A-Za-z0-9_-]{32,}\\*["'`]/g,
    verify: (_match, content, index) =>
      /\\*["']?\bkty\\*["']?\s*:/.test(
        content.slice(Math.max(0, index - JWK_WINDOW), index + JWK_WINDOW),
      ),
    withholdValue: true,
    describe: () => "JSON Web Key carrying its private component",
  },
  {
    id: "symmetric-jwk",
    severity: "critical",
    // The other signing key a JWK carries: a symmetric (`"kty":"oct"`) key
    // keeps its secret in `k`, not `d`. An HS256 JWT secret in this form can
    // mint a service_role token, and private-jwk above never looks at `k`.
    // `verify` wants `kty` `oct` nearby, so any other `k:"…"` is left alone.
    // Measured 2026-09-23: 0 in the build and in all of node_modules.
    pattern: new RegExp(
      String.raw`(?:\\*"k\\*"|${NAME_START}k)\s*:\s*\\*["'\x60][A-Za-z0-9_-]{32,}\\*["'\x60]`,
      "g",
    ),
    verify: (_match, content, index) =>
      /\\*["']?\bkty\\*["']?\s*:\s*\\*["'`]oct\\*["'`]/.test(
        content.slice(Math.max(0, index - JWK_WINDOW), index + JWK_WINDOW),
      ),
    withholdValue: true,
    describe: () => "symmetric JSON Web Key (kty oct) carrying its secret",
  },
];

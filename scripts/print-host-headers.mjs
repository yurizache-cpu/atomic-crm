#!/usr/bin/env node
// Prints the response headers a production host must send, for the configured
// API, in a provider-neutral form: one `Name: value` per line, or JSON.
//
//   node scripts/print-host-headers.mjs --supabase-url https://<project>.supabase.co [--json]
//
// (`--supabase-url` defaults to VITE_SUPABASE_URL.) The values are declared once,
// in scripts/security-headers.mjs; this only reads them, so a host's own
// configuration can be written from, and checked against, the same source.
// scripts/verify-production-host.mjs checks a deployed origin against them.

import { pathToFileURL } from "node:url";
import { hostedSecurityHeaders } from "./security-headers.mjs";
import { parseFlags } from "./production-contract-report.mjs";

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2), ["supabase-url"]);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const supabaseUrl = flags["supabase-url"] ?? process.env.VITE_SUPABASE_URL;
  if (supabaseUrl === undefined) {
    console.error(
      "usage: print-host-headers --supabase-url <project url> (or VITE_SUPABASE_URL)",
    );
    process.exit(2);
  }
  const headers = hostedSecurityHeaders({ supabaseUrl });
  const text =
    flags.json === true
      ? JSON.stringify(headers, null, 2)
      : Object.entries(headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\n");
  process.stdout.write(`${text}\n`);
}

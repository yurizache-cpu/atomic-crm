#!/usr/bin/env node
// Verifies a DEPLOYED origin against the production host contract.
//
//   node scripts/verify-production-host.mjs --url https://app.example.org \
//        --supabase-url https://<project>.supabase.co [--json] [--local-self-test]
//
// (`--supabase-url` defaults to VITE_SUPABASE_URL.) It fetches the application
// page and the scripts the page loads from its own origin, then checks, from
// the ACTUAL response: https on a public host; a 200; every response header a
// <meta> cannot carry or only a host can send (Content-Security-Policy with
// frame-ancestors 'none', Strict-Transport-Security of a year or more,
// X-Content-Type-Options nosniff, a strict Referrer-Policy, a Permissions-Policy
// denying camera, microphone and geolocation); the page's own policy and no
// inline script; no local or development endpoint in the page or its scripts;
// and no credential class in a script (the build scan's rules). http:// must
// redirect to https (advisory).
//
// It is NOT a vulnerability scanner: it checks the contract this project
// declared (scripts/security-headers.mjs), and prints no value it finds.
//
// --local-self-test lets a local address through the https and public-host
// rules so the header logic can be exercised against `vite preview`. The output
// says so, and it is never a production sign-off.
//
// Exit 0 pass, 1 a blocking finding, 2 it could not check.

import { pathToFileURL } from "node:url";
import {
  auditHostResponse,
  pageAssetPaths,
} from "./production-contract-host.mjs";
import { parseFlags, report } from "./production-contract-report.mjs";

const MAX_ASSETS = 60;
const TIMEOUT_MS = 15_000;

const get = (url, init = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

/** The facts about one deployed origin: the page, its scripts, and the http redirect. */
export async function readDeployedOrigin(url, { allowLocal = false } = {}) {
  const page = await get(url, { redirect: "follow" });
  const html = await page.text();
  const origin = new URL(page.url);
  const assets = [];
  const assetFailures = [];
  // As the page names them (a path, or a full URL), resolved against the page:
  // an absolute URL on this very origin is this origin's script too.
  const sameOrigin = pageAssetPaths(html)
    .map((ref) => new URL(ref, page.url))
    .filter((asset) => asset.origin === origin.origin);
  for (const asset of sameOrigin.slice(0, MAX_ASSETS)) {
    const path = asset.pathname.replace(/^\//, "");
    try {
      const response = await get(asset, { redirect: "follow" });
      if (response.ok) assets.push({ path, text: await response.text() });
      else assetFailures.push({ path, reason: `status ${response.status}` });
    } catch (error) {
      assetFailures.push({ path, reason: error.name });
    }
  }

  let httpRedirect = "not checked";
  if (origin.protocol === "https:" && !allowLocal) {
    try {
      const plain = new URL(page.url);
      plain.protocol = "http:";
      const response = await get(plain, { redirect: "manual" });
      const location = response.headers.get("location") ?? "";
      httpRedirect =
        response.status >= 300 &&
        response.status < 400 &&
        location.startsWith("https://")
          ? "redirects"
          : "does not redirect";
    } catch {
      httpRedirect = "no answer on http";
    }
  }
  return {
    response: {
      url: page.url,
      status: page.status,
      headers: page.headers,
      html,
      assets,
      assetFailures,
      assetsNotChecked: Math.max(0, sameOrigin.length - MAX_ASSETS),
    },
    httpRedirect,
  };
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2), ["url", "supabase-url"]);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const url = flags.url;
  const supabaseUrl = flags["supabase-url"] ?? process.env.VITE_SUPABASE_URL;
  if (url === undefined || supabaseUrl === undefined) {
    console.error(
      "usage: verify-production-host --url <https origin> --supabase-url <project url> (or VITE_SUPABASE_URL)",
    );
    process.exit(2);
  }
  const allowLocal = flags["local-self-test"] === true;
  let facts;
  try {
    facts = await readDeployedOrigin(url, { allowLocal });
  } catch (error) {
    console.error(
      `could not read ${new URL(url).origin}: ${error.name}. A check that cannot look is not a pass.`,
    );
    process.exit(2);
  }
  const findings = auditHostResponse(facts.response, {
    supabaseUrl,
    allowLocal,
  });
  if (
    facts.httpRedirect === "does not redirect" ||
    facts.httpRedirect === "no answer on http"
  ) {
    findings.push({
      rule: "http-not-redirected",
      severity: "advisory",
      detail: `http:// ${facts.httpRedirect} to https:// (HSTS covers a returning browser, not a first visit)`,
    });
  }
  if (allowLocal) {
    console.error(
      "SELF-TEST ONLY: a local address is never a production sign-off.\n",
    );
  }
  process.exit(
    report(`production host ${new URL(facts.response.url).origin}`, findings, {
      json: flags.json === true,
    }),
  );
}

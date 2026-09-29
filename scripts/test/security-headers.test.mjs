import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  auditHtmlPage,
  contentSecurityPolicy,
  duplicateDirectives,
  hostedSecurityHeaders,
  parsePolicy,
  securityHeadersPlugins,
  securityMetaTags,
  supabaseOrigins,
} from "../security-headers.mjs";

// Production Security Gate A: the browser security policy of the production
// build (scripts/security-headers.mjs), as the page carries it, as a host must
// send it, and as the build scan refuses a page without it. No browser needed:
// the policy is a deterministic function of the configured API origin.

const API = "https://project-ref.supabase.co";

const directive = (policy, name) =>
  policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.split(/\s+/)[0] === name);

const page = (head, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("the production Content-Security-Policy", () => {
  it("admits scripts from this origin only, and connections to this origin and the configured API only", () => {
    const policy = contentSecurityPolicy({ supabaseUrl: API });
    expect(directive(policy, "script-src")).toBe("script-src 'self'");
    expect(directive(policy, "connect-src")).toBe(
      "connect-src 'self' https://project-ref.supabase.co wss://project-ref.supabase.co",
    );
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
    expect(directive(policy, "frame-src")).toBe("frame-src 'none'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/(^|\s)\*(\s|;|$)/);
    // The one documented exception: runtime-inserted <style> elements.
    expect(directive(policy, "style-src")).toBe(
      "style-src 'self' 'unsafe-inline'",
    );
  });

  it("names no API at all when the build configures none, and refuses a malformed one", () => {
    expect(directive(contentSecurityPolicy(), "connect-src")).toBe(
      "connect-src 'self'",
    );
    expect(supabaseOrigins("")).toEqual([]);
    expect(() => supabaseOrigins("not a url")).toThrow(/VITE_SUPABASE_URL/);
    expect(() => supabaseOrigins("javascript:alert(1)")).toThrow(/http\(s\)/);
  });

  it("gives a host the headers a meta tag cannot carry", () => {
    const headers = hostedSecurityHeaders({ supabaseUrl: API });
    expect(
      directive(headers["Content-Security-Policy"], "frame-ancestors"),
    ).toBe("frame-ancestors 'none'");
    expect(headers["Strict-Transport-Security"]).toMatch(/^max-age=31536000/);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });

  it("puts the policy and the referrer policy first in every production page's head, from the build's own env", () => {
    const [meta] = securityHeadersPlugins();
    meta.configResolved({ env: { VITE_SUPABASE_URL: API } });
    const html = meta.transformIndexHtml.handler(page("<title>x</title>"));
    expect(meta.apply).toBe("build");
    expect(html).toContain(securityMetaTags({ supabaseUrl: API }));
    expect(auditHtmlPage("index.html", html)).toEqual([]);
  });
});

describe("the build scan refuses a page without the policy", () => {
  const good = page(securityMetaTags({ supabaseUrl: API }));
  const findings = (html, rel = "index.html") =>
    auditHtmlPage(rel, html).map((finding) => finding.detail);

  it("accepts the production page", () => {
    expect(findings(good)).toEqual([]);
  });

  it("refuses a missing, duplicated or weakened policy", () => {
    expect(findings(page(""))).toEqual([
      "the page carries 0 Content-Security-Policy meta elements; a production build carries exactly one",
    ]);
    expect(findings(page(good + good))[0]).toMatch(/carries 2/);
    const weakened = (from, to) => good.replace(from, to);
    expect(
      findings(
        weakened("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
      ),
    ).toContain("the policy admits 'unsafe-eval'");
    expect(findings(weakened("script-src 'self'", "script-src *"))).toContain(
      "script-src admits a wildcard, a whole scheme or inline script",
    );
    expect(
      findings(weakened("object-src 'none'", "object-src 'self'")),
    ).toContain("object-src is not 'none'");
    expect(findings(weakened(/<meta name="referrer"[^>]*>/, ""))).toContain(
      "the page head carries no strict referrer policy",
    );
  });

  it("reads a policy as a browser does: the first occurrence of a directive counts", () => {
    const parsed = parsePolicy(
      "script-src *; script-src 'self'; object-src 'none'",
    );
    expect(parsed.get("script-src")).toEqual(["*"]);
    expect(
      duplicateDirectives("script-src *; script-src 'self'; object-src 'none'"),
    ).toEqual(["script-src"]);
    expect(
      duplicateDirectives(contentSecurityPolicy({ supabaseUrl: API })),
    ).toEqual([]);
  });

  it("refuses a built page whose policy names a directive twice, the weak one first or last", () => {
    const meta = securityMetaTags({ supabaseUrl: API });
    const twice = (extra, first) =>
      page(
        meta.replace(
          /content="([^"]*)"/,
          (_, policy) =>
            `content="${first ? extra + "; " + policy : policy + "; " + extra}"`,
        ),
      );
    for (const first of [true, false]) {
      expect(findings(twice("script-src *", first)).join(" ")).toMatch(
        /script-src more than once/,
      );
    }
  });

  it("refuses any inline script, on any page", () => {
    expect(
      findings(page(securityMetaTags(), "<script>alert(1)</script>"))[0],
    ).toMatch(/1 inline script element/);
    expect(findings(page(""), "other.html")).toEqual([
      "an HTML page without its own Content-Security-Policy, or one admitting inline or wildcard scripts",
    ]);
  });

  it("accepts the committed auth callback page, whose redirect is a same-origin script file", () => {
    const callback = readFileSync(
      join(process.cwd(), "public", "auth-callback.html"),
      "utf8",
    );
    expect(auditHtmlPage("auth-callback.html", callback)).toEqual([]);
    expect(callback).toContain('<script src="./auth-callback.js"></script>');
  });
});

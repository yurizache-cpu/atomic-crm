import { describe, expect, it } from "vitest";
import { marked } from "marked";
// Importing the component is what registers its `marked.use({ hooks: {
// postprocess: DOMPurify.sanitize } })`. The assertions below therefore run
// against exactly the pipeline that produces the string handed to
// `dangerouslySetInnerHTML`, which is the only such call site in the app.
import "./Markdown";

// Regression tests for SEC-1BS-06. `Markdown` renders NOTE BODIES, and note
// bodies arrive from inbound email — the only untrusted external channel that
// reaches this database. Sanitisation here is the difference between "an
// attacker can email the clinic" and "an attacker can run script in a logged-in
// operator's tab".
//
// These run in a real browser because that is the only place DOMPurify's
// behaviour is the production behaviour.

const renderToHtml = (markdown: string) => marked.parse(markdown) as string;

describe("Markdown sanitises untrusted content", () => {
  it("strips a script tag", () => {
    const out = renderToHtml(`<script>window.__pwned = 1;</script>`);
    expect(out).not.toContain("<script");
  });

  it("strips an inline event handler", () => {
    const out = renderToHtml(`<img src="x" onerror="window.__pwned = 2">`);
    expect(out.toLowerCase()).not.toContain("onerror");
  });

  it("strips a javascript: URL", () => {
    const out = renderToHtml(`[click](javascript:window.__pwned=3)`);
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("strips an iframe", () => {
    const out = renderToHtml(
      `<iframe src="https://evil.example.com"></iframe>`,
    );
    expect(out).not.toContain("<iframe");
  });

  it("strips svg onload", () => {
    const out = renderToHtml(`<svg onload="window.__pwned=4"></svg>`);
    expect(out.toLowerCase()).not.toContain("onload");
  });

  it("strips a data: URL carrying html", () => {
    const out = renderToHtml(
      `[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`,
    );
    expect(out.toLowerCase()).not.toContain("data:text/html");
  });

  it("strips an object/embed tag", () => {
    const out = renderToHtml(`<object data="evil"></object><embed src="evil">`);
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
  });

  it("does not execute anything it stripped", () => {
    renderToHtml(`<img src=x onerror="window.__pwned=9">`);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("still renders legitimate markdown", () => {
    // The sanitiser must not be so blunt that the feature stops working — a
    // guard nobody can live with is a guard that gets removed.
    const out = renderToHtml(`**bold** and [a link](https://example.com)`);
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('href="https://example.com"');
  });
});

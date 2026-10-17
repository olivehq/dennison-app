import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";
import { emailDocument } from "@/server/email/campaigns";
import { renderTemplate, SAMPLE_MERGE_VALUES } from "@/server/email/merge";
import { inertLinks } from "./inert-links";

describe("inertLinks", () => {
  it("leaves no href in a sanitized body and keeps the text and the address as a title", () => {
    const body = sanitizeEmailHtml(
      '<p>See <a href="https://example.com/a?b=1&amp;c=&quot;2&quot;" style="color: #c00">the agenda</a>.</p>',
    );
    expect(body).toContain("href=");
    const preview = inertLinks(body);
    expect(preview).not.toMatch(/href=|target=|rel=/);
    expect(preview).toContain('title="https://example.com/a?b=1&amp;c=&quot;2&quot;"');
    expect(preview).toContain('style="color: #c00"');
    expect(preview).toContain(">the agenda</a>");
  });

  it("disarms the merged schedule link, and leaves other tags alone", () => {
    const body = sanitizeEmailHtml('<p><a href="{{schedule_link}}">Open</a> {{schedule_link}}</p><abbr>x</abbr>');
    const merged = emailDocument(renderTemplate(body, { ...SAMPLE_MERGE_VALUES, schedule_link: "http://localhost:3000/s/abc" }));
    expect(merged).toContain('href="http://localhost:3000/s/abc"');
    const preview = inertLinks(merged);
    expect(preview).not.toContain("href=");
    expect(preview.match(/<a /g)?.length).toBe(merged.match(/<a /g)?.length);
    expect(preview).toContain('title="http://localhost:3000/s/abc"');
  });
});

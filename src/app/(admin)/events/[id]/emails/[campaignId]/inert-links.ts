/**
 * Makes the links in sanitized email HTML non-navigable for the preview:
 * each `<a>` loses `href`, `target`, and `rel` and keeps its text and the
 * other attributes, with the address moved to `title` so a hover still shows
 * it. Opening a participant's link from the preview would record a view on
 * their behalf (D64).
 *
 * Expects `sanitizeEmailHtml` output (merged or not), where every attribute
 * value is double-quoted with `"` and `>` escaped, so a tag ends at the first `>`.
 */
export function inertLinks(sanitizedHtml: string): string {
  return sanitizedHtml.replace(/<a\b([^>]*)>/gi, (_tag, attributes: string) => {
    const href = /\shref="([^"]*)"/i.exec(attributes)?.[1];
    const kept = attributes.replace(/\s(?:href|target|rel|title)="[^"]*"/gi, "");
    return `<a${kept}${href ? ` title="${href}"` : ""}>`;
  });
}

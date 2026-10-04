/**
 * Makes email HTML safe to show inside the admin app (the preview is a plain
 * div, not an iframe). Parses with the browser's DOMParser, which never runs
 * scripts, then keeps only formatting tags and http, https, and mailto links.
 * Browser only.
 */

const ALLOWED = new Set([
  "A", "B", "BLOCKQUOTE", "BR", "DIV", "EM", "H1", "H2", "H3", "H4", "HR", "I", "LI", "OL", "P", "PRE", "S", "SPAN", "STRONG", "U", "UL",
]);

/** Removed with their content. Anything else unknown is unwrapped and its text kept. */
const DROPPED = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "SVG", "MATH", "TEMPLATE", "LINK", "META", "IMG", "VIDEO", "AUDIO", "NOSCRIPT",
]);

function safeHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, "https://invalid.example");
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function clean(parent: Element): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (DROPPED.has(tag)) {
      element.remove();
      continue;
    }
    clean(element);
    if (!ALLOWED.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    const href = tag === "A" ? safeHref(element.getAttribute("href")) : null;
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (href) {
      element.setAttribute("href", href);
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }
}

export function sanitizeEmailHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  clean(doc.body);
  return doc.body.innerHTML;
}

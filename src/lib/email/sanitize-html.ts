import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

/**
 * Allowlist sanitizer for campaign bodies. Runs on the server when a campaign
 * is saved and again before every preview, test, and send, and in the browser
 * for the editor's compatibility check. It parses with parse5 (the HTML spec's
 * parser, so it reads markup the way a browser does), copies only allowed
 * elements and attributes into a fresh string, and escapes everything it
 * writes. Nothing from the input is passed through as raw text.
 *
 * Merge fields (`{{first_name}}`) are plain text to it and survive. It runs
 * BEFORE merge fields are filled in, so a link to the participant's schedule
 * is allowed as exactly `{{schedule_link}}` (the app builds that URL, and in
 * development it is http).
 */

type ChildNode = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_DEPTH = 64;

/** Removed together with everything inside them. */
const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "title", "head", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "textarea", "select", "option", "optgroup", "datalist", "base", "meta", "link", "svg", "math",
  "audio", "video", "source", "track", "canvas", "map", "area", "dialog", "xmp", "plaintext", "noembed", "noframes",
]);

/** Written out as a plain `div`. */
const BLOCK_ALIASES = new Set(["section", "article", "header", "footer", "main", "nav", "aside", "figure", "figcaption"]);

const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

// ---------------------------------------------------------------------------
// Attribute values
// ---------------------------------------------------------------------------

type ValueRule = (value: string) => string | null;

const oneOf =
  (...allowed: string[]): ValueRule =>
  (value) => {
    const v = value.trim().toLowerCase();
    return allowed.includes(v) ? v : null;
  };

const matching =
  (pattern: RegExp): ValueRule =>
  (value) => {
    const v = value.trim();
    return pattern.test(v) ? v : null;
  };

const SIZE = matching(/^\d{1,4}(px|%)?$/);
const SMALL_NUMBER = matching(/^\d{1,3}$/);
const COLOR = matching(/^(#[0-9a-f]{3,8}|[a-z]{3,24})$/i);
const ALIGN = oneOf("left", "right", "center", "justify");
const VALIGN = oneOf("top", "middle", "bottom", "baseline");
const TEXT = (value: string): string | null => (value.length <= 500 ? value : null);
const FONT_FACE = matching(/^[\w\s,'"-]{1,100}$/);
const FONT_SIZE = matching(/^[+-]?\d{1,2}$/);

/** Merge fields are filled in per recipient, so one inside a URL would hand a private value to whoever runs that URL. */
const MERGE_FIELD = /\{\{|\}\}/;

/** https only, no whitespace or control characters, no merge fields. */
function httpsUrl(value: string): string | null {
  const v = value.trim();
  if (MERGE_FIELD.test(v) || v.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(v)) return null;
  if (!/^https:\/\/[^/?#]/i.test(v)) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/** The one merge field a URL attribute may hold, and only as the whole value of an `<a href>`. */
const SCHEDULE_LINK = /^\{\{\s*schedule_link\s*\}\}$/;

function linkTarget(value: string): string | null {
  const v = value.trim();
  if (SCHEDULE_LINK.test(v)) return v;
  if (/^mailto:[^\s\u0000-\u001f\u007f]+$/i.test(v) && v.length <= 500 && !MERGE_FIELD.test(v)) return v;
  return httpsUrl(v);
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const STYLE_PROPERTIES = new Set([
  "color", "background-color", "font-size", "font-weight", "font-family", "font-style", "text-align", "text-decoration",
  "line-height", "border-radius", "width", "max-width", "height", "display", "vertical-align",
]);
/** padding, margin, border, and their sides and parts: `padding-top`, `border-bottom-color`, `border-collapse`. */
const STYLE_FAMILIES = /^(padding|margin|border)(-[a-z]+)*$/;
const DISPLAY_VALUES = new Set(["block", "inline", "inline-block", "table", "table-cell", "table-row", "none"]);
const ALLOWED_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla"]);
const SAFE_VALUE_CHARACTERS = /^[a-z0-9\s#%.,'"()+\-!_]*$/i;
// Belt and braces: functions other than rgb/hsl, backslashes, and comments are already refused above.
const FORBIDDEN_IN_VALUES = /expression|javascript|vbscript|behavior|binding|@import/i;

/** Splits on `;` outside quotes. Returns null when a quote is never closed. */
function splitDeclarations(style: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of style) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ";") {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quote) return null;
  parts.push(current);
  return parts;
}

function styleValue(property: string, raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value === "" || value.length > 200) return null;
  if (!SAFE_VALUE_CHARACTERS.test(value) || FORBIDDEN_IN_VALUES.test(value)) return null;
  for (const call of value.matchAll(/([a-z-]*)\s*\(/gi)) {
    if (!ALLOWED_FUNCTIONS.has(call[1].toLowerCase())) return null;
  }
  const open = (value.match(/\(/g) ?? []).length;
  const close = (value.match(/\)/g) ?? []).length;
  if (open !== close) return null;
  if (property === "display") {
    const keyword = value.replace(/\s*!important$/i, "").toLowerCase();
    return DISPLAY_VALUES.has(keyword) ? keyword : null;
  }
  return value;
}

/** Keeps allowed properties with plain values. Drops the whole attribute when nothing is left. */
export function sanitizeStyle(style: string): string | null {
  const declarations = splitDeclarations(style);
  if (!declarations) return null;
  const kept: string[] = [];
  for (const declaration of declarations) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (!STYLE_PROPERTIES.has(property) && !STYLE_FAMILIES.test(property)) continue;
    const value = styleValue(property, declaration.slice(colon + 1));
    if (value) kept.push(`${property}: ${value}`);
  }
  return kept.length > 0 ? kept.join("; ") : null;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

type Rules = Record<string, ValueRule>;

const CELL: Rules = {
  width: SIZE, height: SIZE, align: ALIGN, valign: VALIGN, bgcolor: COLOR, colspan: SMALL_NUMBER, rowspan: SMALL_NUMBER,
};
const ROW: Rules = { align: ALIGN, valign: VALIGN, bgcolor: COLOR };
const NONE: Rules = {};

const TAGS: Record<string, Rules> = {
  a: { href: linkTarget },
  abbr: NONE, b: NONE, blockquote: NONE, br: NONE, center: NONE, code: NONE, del: NONE, div: { align: ALIGN }, em: NONE,
  h1: { align: ALIGN }, h2: { align: ALIGN }, h3: { align: ALIGN }, h4: { align: ALIGN }, h5: { align: ALIGN }, h6: { align: ALIGN },
  hr: NONE, i: NONE, ins: NONE, li: NONE, ol: { start: SMALL_NUMBER }, p: { align: ALIGN }, pre: NONE, s: NONE, small: NONE,
  span: NONE, strike: NONE, strong: NONE, sub: NONE, sup: NONE, u: NONE, ul: NONE,
  font: { color: COLOR, face: FONT_FACE, size: FONT_SIZE },
  img: { src: httpsUrl, alt: TEXT, width: SIZE, height: SIZE, align: ALIGN, border: SMALL_NUMBER },
  table: {
    width: SIZE, height: SIZE, align: ALIGN, bgcolor: COLOR, border: SMALL_NUMBER, cellpadding: SMALL_NUMBER, cellspacing: SMALL_NUMBER,
  },
  caption: { align: ALIGN },
  colgroup: { width: SIZE, span: SMALL_NUMBER },
  col: { width: SIZE, span: SMALL_NUMBER },
  thead: ROW, tbody: ROW, tfoot: ROW, tr: ROW,
  td: CELL, th: CELL,
};

const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function cleanAttributes(tag: string, element: Element): { text: string; hasRequired: boolean } {
  const rules = TAGS[tag];
  const out: string[] = [];
  let hasRequired = tag !== "a" && tag !== "img";
  for (const { name, value } of element.attrs) {
    let cleaned: string | null = null;
    if (name === "style") cleaned = sanitizeStyle(value);
    else if (Object.hasOwn(rules, name)) cleaned = rules[name](value);
    if (cleaned === null) continue;
    if ((tag === "a" && name === "href") || (tag === "img" && name === "src")) hasRequired = true;
    out.push(` ${name}="${escapeAttribute(cleaned)}"`);
  }
  if (tag === "a") out.push(' target="_blank" rel="noopener noreferrer"');
  return { text: out.join(""), hasRequired };
}

function serialize(nodes: ChildNode[], depth: number): string {
  let out = "";
  for (const node of nodes) {
    if (node.nodeName === "#text") {
      out += escapeText((node as DefaultTreeAdapterMap["textNode"]).value);
      continue;
    }
    if (!isElement(node) || node.namespaceURI !== HTML_NAMESPACE) continue;
    const name = node.tagName.toLowerCase();
    if (DROPPED_WITH_CONTENT.has(name) || depth >= MAX_DEPTH) continue;
    const tag = BLOCK_ALIASES.has(name) ? "div" : name;
    if (!Object.hasOwn(TAGS, tag)) {
      // Unknown but harmless (a custom tag, say): keep its text and children.
      out += serialize(node.childNodes, depth + 1);
      continue;
    }
    const attributes = cleanAttributes(tag, node);
    if (!attributes.hasRequired) {
      // A link with no safe address is just its text; an image with no safe source is nothing.
      if (tag === "a") out += serialize(node.childNodes, depth + 1);
      continue;
    }
    out += `<${tag}${attributes.text}>`;
    if (!VOID_TAGS.has(tag)) out += `${serialize(node.childNodes, depth + 1)}</${tag}>`;
  }
  return out;
}

/** Safe HTML for an email body. Idempotent. */
export function sanitizeEmailHtml(html: string): string {
  return serialize(parseFragment(html).childNodes, 0);
}

// ---------------------------------------------------------------------------
// Does the visual editor keep it?
// ---------------------------------------------------------------------------

/** Elements the editor (Tiptap StarterKit without code, plus links and images) can hold. */
const EDITOR_TAGS: Record<string, readonly string[]> = {
  p: [], br: [], strong: [], em: [], s: [], u: [], ul: [], ol: ["start"], li: [], blockquote: [], hr: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height"],
};

/**
 * True when the visual editor would hold this HTML without dropping anything:
 * only paragraphs, text styling, lists, headings, links, and images, with no
 * inline styles or other attributes. Used to decide which mode a saved
 * campaign opens in, and whether switching back to the editor loses markup.
 */
export function isEditorCompatibleHtml(html: string): boolean {
  const check = (nodes: ChildNode[]): boolean =>
    nodes.every((node) => {
      if (!isElement(node)) return true;
      const allowed = EDITOR_TAGS[node.tagName.toLowerCase()];
      if (!allowed || node.namespaceURI !== HTML_NAMESPACE) return false;
      if (node.attrs.some((attribute) => !allowed.includes(attribute.name))) return false;
      return check(node.childNodes);
    });
  return check(parseFragment(sanitizeEmailHtml(html)).childNodes);
}

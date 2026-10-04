/**
 * Merge fields for campaign subjects and bodies (scope 2.7). Pure functions,
 * no database, so the editor and tests can use them directly.
 */

export const MERGE_FIELDS = [
  { key: "first_name", label: "First name", description: "Buyer's first name, or the supplier contact's first name." },
  { key: "last_name", label: "Last name", description: "Buyer's last name, or the rest of the supplier contact's name." },
  { key: "organization", label: "Organization", description: "Buyer's organization, or the supplier name." },
  { key: "supplier_name", label: "Supplier name", description: "Supplier name. Empty for buyers." },
  { key: "desk", label: "Desk", description: "Supplier's desk number. Empty for buyers, who meet at several desks." },
  { key: "schedule_link", label: "Schedule link", description: "The person's private schedule page. Becomes a link in the body." },
  { key: "event_name", label: "Event name", description: "The event's name." },
  { key: "event_date", label: "Event date", description: "The event date, for example Tuesday, November 10, 2026." },
] as const;

export type MergeFieldKey = (typeof MERGE_FIELDS)[number]["key"];
export type MergeValues = Record<MergeFieldKey, string>;

const KNOWN = new Set<string>(MERGE_FIELDS.map((f) => f.key));
const FIELD_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

function isMergeFieldKey(name: string): name is MergeFieldKey {
  return KNOWN.has(name);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Every `{{name}}` in the text that is not a known merge field, in order of first use. */
export function findUnknownFields(text: string): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(FIELD_PATTERN)) {
    const token = match[0];
    if (!isMergeFieldKey(match[1]) && !unknown.includes(token)) unknown.push(token);
  }
  return unknown;
}

/** Plain-text merge for subjects. Unknown fields are left as typed. */
export function renderText(text: string, values: MergeValues): string {
  return text.replace(FIELD_PATTERN, (token, name: string) => (isMergeFieldKey(name) ? values[name] : token));
}

/**
 * HTML merge for bodies. Values are escaped. Inside a tag (an `href`, say) a
 * field becomes its escaped value; in text, `{{schedule_link}}` becomes a
 * link unless it already sits inside one. Unknown fields are left as typed.
 */
export function renderTemplate(html: string, values: MergeValues): string {
  let insideLink = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<a[\s>]/i.test(part)) insideLink += 1;
        else if (/^<\/a\s*>/i.test(part)) insideLink = Math.max(0, insideLink - 1);
        return part.replace(FIELD_PATTERN, (token, name: string) =>
          isMergeFieldKey(name) ? escapeHtml(values[name]) : token,
        );
      }
      return part.replace(FIELD_PATTERN, (token, name: string) => {
        if (!isMergeFieldKey(name)) return token;
        const value = escapeHtml(values[name]);
        if (name === "schedule_link" && insideLink === 0 && value !== "") {
          return `<a href="${value}">${value}</a>`;
        }
        return value;
      });
    })
    .join("");
}

/** Values for a test send or a preview when there is nobody to borrow them from. */
export const SAMPLE_MERGE_VALUES: MergeValues = {
  first_name: "Alex",
  last_name: "Sample",
  organization: "Sample Organization",
  supplier_name: "",
  desk: "",
  schedule_link: "https://example.com/s/sample-link",
  event_name: "AW Appointment Show",
  event_date: "Tuesday, November 10, 2026",
};

import type { EmailAudience } from "@/lib/schemas/email";
import type { AudienceOption } from "@/server/email/queries";

/** The editor's view of who a campaign reaches, mirroring `filterAudience` on the server. */

export function audienceMembers(
  contacts: readonly AudienceOption[],
  audience: EmailAudience,
  selected: readonly string[],
): AudienceOption[] {
  switch (audience) {
    case "all":
      return [...contacts];
    case "buyers":
      return contacts.filter((c) => c.contactType === "buyer");
    case "suppliers":
      return contacts.filter((c) => c.contactType !== "buyer");
    case "selected": {
      const keys = new Set(selected);
      return contacts.filter((c) => keys.has(c.key));
    }
    case "changed_since_last_send":
      return contacts.filter((c) => c.changed);
  }
}

/** Who a send reaches, who it leaves out because their link was revoked, and how many get the email. */
export function sendPlan(members: readonly AudienceOption[]): {
  recipients: AudienceOption[];
  sendCount: number;
  skipped: AudienceOption[];
} {
  const recipients = members.filter((c) => !c.linkRevoked);
  return { recipients, sendCount: recipients.length, skipped: members.filter((c) => c.linkRevoked) };
}

const NAMES_SHOWN = 3;

/** "Ann, Bo, and 2 more will be left out: their links were revoked. ..." for the editor and the send confirm. */
export function skippedNote(skipped: readonly { name: string }[]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.slice(0, NAMES_SHOWN).map((c) => c.name);
  const rest = skipped.length - names.length;
  const who =
    rest > 0
      ? `${names.join(", ")}, and ${rest} more`
      : names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
        : names[0];
  const revoked = skipped.length === 1 ? "their link was revoked" : "their links were revoked";
  return `${who} will be left out: ${revoked}. Use Regenerate on the roster to give them a new link.`;
}

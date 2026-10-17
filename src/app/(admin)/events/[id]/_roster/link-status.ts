import type { ContactType } from "@/db/schema";
import { recipientKey } from "@/lib/schemas/email";
import type { ReadLink } from "@/server/tokens/queries";
import type { LinkInfo } from "./types";

/**
 * One contact's newest link for the roster tables. `links` comes from
 * `readContactLinks`, which keeps the newest token per contact by the tokens
 * module's rule, the same one the exports use.
 */
export function linkOf(links: ReadonlyMap<string, ReadLink>, contactType: ContactType, entityId: string): LinkInfo {
  const link = links.get(recipientKey(contactType, entityId));
  return link ? { tokenId: link.tokenId, state: link.status } : null;
}

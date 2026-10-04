import type { TokenListItem } from "@/server/tokens/queries";
import type { LinkInfo } from "./types";

type ContactType = TokenListItem["contactType"];
type TokenLike = Pick<TokenListItem, "id" | "contactType" | "entityId" | "status" | "createdAt">;

/** The newest token per contact, keyed by contact type and entity. Older tokens were replaced. */
export function latestLinks(tokens: TokenLike[]): Map<string, LinkInfo> {
  const newest = new Map<string, TokenLike>();
  for (const token of tokens) {
    const key = `${token.contactType}:${token.entityId}`;
    const current = newest.get(key);
    const newer =
      !current ||
      token.createdAt > current.createdAt ||
      (token.createdAt.getTime() === current.createdAt.getTime() && token.status === "active");
    if (newer) newest.set(key, token);
  }
  return new Map([...newest].map(([key, token]) => [key, { tokenId: token.id, state: token.status }]));
}

export function linkOf(links: Map<string, LinkInfo>, contactType: ContactType, entityId: string): LinkInfo {
  return links.get(`${contactType}:${entityId}`) ?? null;
}

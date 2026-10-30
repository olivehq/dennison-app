/**
 * True for an address on example.com, .org, or .net (or a subdomain), which
 * no mail provider will send from. Takes a bare address or "Name <address>".
 */
export function isExampleAddress(address: string): boolean {
  const bare = address.match(/<([^>]*)>/)?.[1] ?? address;
  const domain = bare.slice(bare.lastIndexOf("@") + 1).trim().toLowerCase();
  return /(^|\.)example\.(com|org|net)$/.test(domain);
}

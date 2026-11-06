import { isExampleAddress } from "./example-address";

/** The domain of a bare address or "Name <address>", lowercased, or null when there is no @. */
export function domainOf(value: string): string | null {
  const bare = value.match(/<([^>]*)>/)?.[1] ?? value;
  const at = bare.lastIndexOf("@");
  if (at < 0) return null;
  return bare.slice(at + 1).trim().toLowerCase() || null;
}

/**
 * The one domain a campaign may send from: the domain of `EMAIL_FROM`. Null
 * while `EMAIL_FROM` is unset or still an example.com placeholder, so a fresh
 * install, development, and tests are not held to a domain nobody chose.
 */
export function allowedSenderDomain(emailFrom: string): string | null {
  if (isExampleAddress(emailFrom)) return null;
  return domainOf(emailFrom);
}

/** True when a domain is required and this From email is not on it. Subdomains don't count: Resend verifies each domain on its own. */
export function isOffDomain(fromEmail: string, allowed: string | null): boolean {
  return allowed !== null && domainOf(fromEmail) !== allowed;
}

/** The message under the From email field and beside a refused save. */
export function offDomainMessage(domain: string): string {
  return `Use an address on ${domain}.`;
}

/**
 * Why a send, test, or retry is refused when the From email is off the
 * sending domain. A sent campaign can't be edited, so a retry means a copy.
 */
export function offDomainSendReason(domain: string, { retry = false } = {}): string {
  return retry
    ? `This campaign's From email isn't on ${domain}. Duplicate it, change the From email to an address on ${domain}, and send the copy.`
    : `The From email isn't on ${domain}. Change it to an address on ${domain}.`;
}

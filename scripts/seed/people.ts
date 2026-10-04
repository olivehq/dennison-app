/**
 * Synthetic identities for the demo roster. The 2025 files only carry
 * "Organization - Title" for buyers and names for suppliers, so people get
 * made-up names picked deterministically from their organisation, and
 * example.org / example.com addresses that can never reach anyone.
 */

const FIRST_NAMES = [
  "Alex", "Blake", "Casey", "Dana", "Elliot", "Frankie", "Gray", "Harper", "Indy", "Jordan",
  "Kai", "Lee", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Riley", "Sage", "Taylor",
  "Val", "Wren", "Avery", "Rowan",
];

const LAST_NAMES = [
  "Adams", "Brooks", "Chen", "Diaz", "Evans", "Foster", "Garcia", "Hughes", "Ito", "Jensen",
  "Kim", "Lopez", "Mendez", "Nguyen", "Owens", "Patel", "Reyes", "Silva", "Turner", "Vargas",
  "Walsh", "Young", "Okafor", "Moreau",
];

/** FNV-1a, 32-bit. Stable across runs and platforms. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function personName(seed: string): { firstName: string; lastName: string } {
  const h = hash32(seed);
  return {
    firstName: FIRST_NAMES[h % FIRST_NAMES.length],
    lastName: LAST_NAMES[Math.floor(h / FIRST_NAMES.length) % LAST_NAMES.length],
  };
}

/** "Org - Title" -> organization and title, splitting at the first " - " (2025 display names, D34). */
export function splitBuyerName(name: string): { organization: string; title: string | null } {
  const at = name.indexOf(" - ");
  if (at === -1) return { organization: name.trim(), title: null };
  return { organization: name.slice(0, at).trim(), title: name.slice(at + 3).trim() || null };
}

export type DemoBuyer = {
  email: string;
  firstName: string;
  lastName: string;
  organization: string;
  title: string | null;
};

/**
 * One identity per 2025 buyer, in input order. Emails are
 * `firstname.lastname@example.org`; a clash gets a number (`alex.kim2@...`).
 */
export function demoBuyers(buyers: { name: string; organization?: string; title?: string }[]): DemoBuyer[] {
  const used = new Set<string>();
  return buyers.map((b) => {
    const split = splitBuyerName(b.name);
    const organization = b.organization?.trim() || split.organization;
    const title = b.title?.trim() || split.title;
    const { firstName, lastName } = personName(b.name);
    const local = `${firstName}.${lastName}`.toLowerCase();
    let email = `${local}@example.org`;
    for (let n = 2; used.has(email); n++) email = `${local}${n}@example.org`;
    used.add(email);
    return { email, firstName, lastName, organization, title };
  });
}

export type DemoSupplierContacts = {
  adminContact: { name: string; email: string };
  attendeeContact: { name: string; email: string };
};

/** Admin contact `<slug>@example.com`, attendee contact `attendee.<slug>@example.com`. */
export function demoSupplierContacts(supplierName: string): DemoSupplierContacts {
  const slug = slugify(supplierName);
  const admin = personName(`${supplierName}#admin`);
  const attendee = personName(`${supplierName}#attendee`);
  return {
    adminContact: { name: `${admin.firstName} ${admin.lastName}`, email: `${slug}@example.com` },
    attendeeContact: { name: `${attendee.firstName} ${attendee.lastName}`, email: `attendee.${slug}@example.com` },
  };
}

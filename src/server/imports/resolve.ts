import { compareNames } from "@/lib/names";
import type { NameSuggestion } from "@/lib/schemas/import";

export type ResolvableEntity = {
  id: string;
  /** Shown in suggestions and reports. */
  label: string;
  /** Every spelling the entity is known by: name, display name, "Organization - Title". */
  names: string[];
  /**
   * The roster name a cross-year alias records (supplier name, buyer full
   * name). Defaults to `label`.
   */
  canonicalName?: string;
  /** Matched first when `ResolveOptions.byEmail` is on and the raw text holds an email address. */
  emails?: string[];
  /** Matched after this event's alias when `ResolveOptions.byOrganization` is on. */
  organization?: string | null;
};

/**
 * Extra lookups for one kind of name. Supplier ranking files name buyers by
 * email or company as well as by name, so their choices turn both on.
 */
export type ResolveOptions = { byEmail?: boolean; byOrganization?: boolean };

/** An alias saved for this event: raw text to an entity id. */
export type AliasRow = { rawText: string; entityId: string };

/** A cross-year alias (D76): raw text to the roster name it meant in an earlier event. */
export type GlobalAliasRow = { rawText: string; canonicalName: string };

export type Unresolved = {
  raw: string;
  suggestions: NameSuggestion[];
  /** The text matches several entities by organization or name; `suggestions` holds all of them. */
  ambiguous?: boolean;
};

export type Resolution = {
  resolved: Map<string, string>;
  unresolved: Unresolved[];
  /** Raw names that matched something other than an exact alias or exact name. Worth saving as auto aliases. */
  inexact: Map<string, string>;
  /**
   * Raw names resolved by this event's alias although the text matches
   * several entities by organization or name, with those entities' ids. The
   * alias sends every row with this text to one entity, so callers warn.
   */
  aliasedAmbiguous: Map<string, string[]>;
  /**
   * Raw names resolved by a saved alias rather than by a name on the roster:
   * `event` for this event's alias, `cross_year` for a global one (D76).
   */
  viaAlias: Map<string, AliasScope>;
};

export type AliasScope = "event" | "cross_year";

export const SUGGESTION_THRESHOLD = 0.5;
export const SUGGESTION_LIMIT = 3;

/** Lower case, "&" to "and", no punctuation, no leading "the", single spaces. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "")
    .replace(/\s+the$/, "");
}

const EMAIL_IN_TEXT = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[^\s@<>()[\],;:"']+/;

/** The first email address in the text, lower-cased, or null. "David Smith <ds@x.com>" gives "ds@x.com". */
export function emailIn(text: string): string | null {
  const match = EMAIL_IN_TEXT.exec(text);
  return match ? match[0].toLowerCase() : null;
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  const padded = ` ${text} `;
  for (let i = 0; i < padded.length - 1; i += 1) {
    const gram = padded.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** The numbers in a name, leading zeros dropped and sorted: "Hall 2 Suite 010" gives ["10", "2"]. */
export function numberTokens(name: string): string[] {
  return (normaliseName(name).match(/\p{N}+/gu) ?? []).map((digits) => digits.replace(/^0+(?=.)/, "")).sort();
}

/** True when both names hold the same numbers. "100 Hotel" and "10 Hotel" don't: they are different places. */
export function sameNumbers(a: string, b: string): boolean {
  const left = numberTokens(a);
  const right = numberTokens(b);
  return left.length === right.length && left.every((token, i) => token === right[i]);
}

/** Dice coefficient over character bigrams of the normalised names, 0 to 1. */
export function similarity(a: string, b: string): number {
  const left = bigrams(normaliseName(a));
  const right = bigrams(normaliseName(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of left.values()) leftTotal += count;
  for (const count of right.values()) rightTotal += count;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / (leftTotal + rightTotal);
}

type Index = {
  byEmail: Map<string, Set<string>>;
  byAlias: Map<string, string>;
  /** Lower-cased raw text of a cross-year alias to the entities of this event with its canonical name. */
  byGlobalAlias: Map<string, Set<string>>;
  byOrganization: Map<string, Set<string>>;
  byOrganizationNormalised: Map<string, Set<string>>;
  byLower: Map<string, Set<string>>;
  byNormalised: Map<string, Set<string>>;
};

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  if (key === "") return;
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

function buildIndex(entities: ResolvableEntity[], aliases: AliasRow[], globalAliases: GlobalAliasRow[]): Index {
  const byEmail = new Map<string, Set<string>>();
  const byAlias = new Map<string, string>();
  const byGlobalAlias = new Map<string, Set<string>>();
  const byOrganization = new Map<string, Set<string>>();
  const byOrganizationNormalised = new Map<string, Set<string>>();
  const byLower = new Map<string, Set<string>>();
  const byNormalised = new Map<string, Set<string>>();
  const known = new Set(entities.map((entity) => entity.id));
  for (const alias of aliases) {
    if (known.has(alias.entityId)) byAlias.set(alias.rawText.trim(), alias.entityId);
  }
  const byCanonical = new Map<string, Set<string>>();
  for (const entity of entities) addTo(byCanonical, (entity.canonicalName ?? entity.label).trim().toLowerCase(), entity.id);
  for (const alias of globalAliases) {
    const ids = byCanonical.get(alias.canonicalName.trim().toLowerCase());
    if (ids) byGlobalAlias.set(alias.rawText.trim().toLowerCase(), ids);
  }
  for (const entity of entities) {
    for (const name of entity.names) {
      addTo(byLower, name.trim().toLowerCase(), entity.id);
      addTo(byNormalised, normaliseName(name), entity.id);
    }
    for (const email of entity.emails ?? []) addTo(byEmail, email.trim().toLowerCase(), entity.id);
    if (entity.organization) {
      addTo(byOrganization, entity.organization.trim().toLowerCase(), entity.id);
      addTo(byOrganizationNormalised, normaliseName(entity.organization), entity.id);
    }
  }
  return { byEmail, byAlias, byGlobalAlias, byOrganization, byOrganizationNormalised, byLower, byNormalised };
}

/** Close spellings for the admin to confirm. A name whose numbers differ from the text is never suggested. */
function suggestionsFor(raw: string, entities: ResolvableEntity[]): NameSuggestion[] {
  const scored = entities.map((entity) => ({
    entityId: entity.id,
    name: entity.label,
    score: Math.max(0, ...entity.names.map((name) => (sameNumbers(raw, name) ? similarity(raw, name) : 0))),
  }));
  return scored
    .filter((suggestion) => suggestion.score >= SUGGESTION_THRESHOLD)
    // The id breaks ties between people with the same name, so the order (and a
    // stale-report check comparing two runs) doesn't depend on database row order.
    .sort((a, b) => b.score - a.score || compareNames(a.name, b.name) || a.entityId.localeCompare(b.entityId))
    .slice(0, SUGGESTION_LIMIT)
    .map((suggestion) => ({ ...suggestion, score: Math.round(suggestion.score * 100) / 100 }));
}

/** Every entity a text matches equally, for the admin to pick from. Not capped: they are all exact. */
function candidateSuggestions(ids: Set<string>, entities: ResolvableEntity[]): NameSuggestion[] {
  return entities
    .filter((entity) => ids.has(entity.id))
    .map((entity) => ({ entityId: entity.id, name: entity.label, score: 1 }))
    .sort((a, b) => compareNames(a.name, b.name));
}

/** The single id in the set, or null when the key is ambiguous or unknown. */
function only(set: Set<string> | undefined): string | null {
  return set && set.size === 1 ? [...set][0] : null;
}

/** The set when it holds more than one id, else null. */
function several(set: Set<string> | undefined): Set<string> | null {
  return set && set.size > 1 ? set : null;
}

/**
 * Matches raw names to entities, in this order: an email address in the text
 * (with `byEmail`; one roster email wins, else only this event's alias can
 * settle it), the organization (with `byOrganization`; exact ignoring case,
 * then normalised), exact case-insensitive name, normalised name, then a saved
 * alias (this event's, then a cross-year one whose canonical name is exactly,
 * ignoring case, one entity's name here), then fuzzy suggestions for the admin
 * to confirm. A name on the roster always beats an alias: aliases only resolve
 * text no entity has as its name. A text that matches several entities by
 * organization or by name is left unresolved, `ambiguous`, with all of them
 * suggested; only this event's alias settles it, never a cross-year alias.
 */
export function resolveNames(
  raws: Iterable<string>,
  entities: ResolvableEntity[],
  aliases: AliasRow[],
  globalAliases: GlobalAliasRow[] = [],
  options: ResolveOptions = {},
): Resolution {
  const index = buildIndex(entities, aliases, globalAliases);
  const resolved = new Map<string, string>();
  const inexact = new Map<string, string>();
  const aliasedAmbiguous = new Map<string, string[]>();
  const viaAlias = new Map<string, AliasScope>();
  const unresolved: Unresolved[] = [];
  const seen = new Set<string>();

  const organizationMatch = (key: string): Set<string> | undefined =>
    options.byOrganization
      ? (index.byOrganization.get(key.toLowerCase()) ?? index.byOrganizationNormalised.get(normaliseName(key)))
      : undefined;

  for (const raw of raws) {
    const key = raw.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);

    const email = options.byEmail ? emailIn(key) : null;
    if (email) {
      // An email that is exactly one buyer's wins. Otherwise only the admin's mapping for this text can settle it.
      const byEmail = only(index.byEmail.get(email));
      const byAlias = byEmail ? null : index.byAlias.get(key);
      if (byEmail) resolved.set(key, byEmail);
      else if (byAlias) {
        resolved.set(key, byAlias);
        viaAlias.set(key, "event");
      } else unresolved.push({ raw: key, suggestions: suggestionsFor(key.toLowerCase().replace(email, " "), entities) });
      continue;
    }

    const organization = organizationMatch(key);
    const lower = index.byLower.get(key.toLowerCase());
    const normalised = index.byNormalised.get(normaliseName(key));

    const byOrganization = only(organization);
    if (byOrganization) {
      resolved.set(key, byOrganization);
      continue;
    }
    // A shared company or name is never settled by a name or a cross-year
    // alias: they would pick one of these people silently. Only this event's
    // alias settles it, with a warning. An exact name one entity has still
    // wins over a normalised clash.
    const shared = several(organization) ?? several(lower) ?? (only(lower) ? null : several(normalised));
    if (shared) {
      const byAlias = index.byAlias.get(key);
      if (byAlias) {
        resolved.set(key, byAlias);
        viaAlias.set(key, "event");
        aliasedAmbiguous.set(key, [...shared]);
      } else {
        unresolved.push({ raw: key, suggestions: candidateSuggestions(shared, entities), ambiguous: true });
      }
      continue;
    }

    const byLower = only(lower);
    if (byLower) {
      resolved.set(key, byLower);
      continue;
    }
    const byNormalised = only(normalised);
    if (byNormalised) {
      resolved.set(key, byNormalised);
      inexact.set(key, byNormalised);
      continue;
    }
    const byAlias = index.byAlias.get(key);
    if (byAlias) {
      resolved.set(key, byAlias);
      viaAlias.set(key, "event");
      continue;
    }
    const byGlobalAlias = only(index.byGlobalAlias.get(key.toLowerCase()));
    if (byGlobalAlias) {
      resolved.set(key, byGlobalAlias);
      viaAlias.set(key, "cross_year");
      continue;
    }
    unresolved.push({ raw: key, suggestions: suggestionsFor(key, entities) });
  }
  return { resolved, unresolved, inexact, aliasedAmbiguous, viaAlias };
}

import type { NameSuggestion } from "@/lib/schemas/import";

export type ResolvableEntity = {
  id: string;
  /** Shown in suggestions and reports. */
  label: string;
  /** Every spelling the entity is known by: name, display name, "Organization - Title". */
  names: string[];
};

export type AliasRow = { rawText: string; entityId: string };

export type Unresolved = { raw: string; suggestions: NameSuggestion[] };

export type Resolution = {
  resolved: Map<string, string>;
  unresolved: Unresolved[];
  /** Raw names that matched something other than an exact alias or exact name. Worth saving as auto aliases. */
  inexact: Map<string, string>;
};

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

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  const padded = ` ${text} `;
  for (let i = 0; i < padded.length - 1; i += 1) {
    const gram = padded.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
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
  byAlias: Map<string, string>;
  byLower: Map<string, Set<string>>;
  byNormalised: Map<string, Set<string>>;
};

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  if (key === "") return;
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

function buildIndex(entities: ResolvableEntity[], aliases: AliasRow[]): Index {
  const byAlias = new Map<string, string>();
  const byLower = new Map<string, Set<string>>();
  const byNormalised = new Map<string, Set<string>>();
  const known = new Set(entities.map((entity) => entity.id));
  for (const alias of aliases) {
    if (known.has(alias.entityId)) byAlias.set(alias.rawText.trim(), alias.entityId);
  }
  for (const entity of entities) {
    for (const name of entity.names) {
      addTo(byLower, name.trim().toLowerCase(), entity.id);
      addTo(byNormalised, normaliseName(name), entity.id);
    }
  }
  return { byAlias, byLower, byNormalised };
}

function suggestionsFor(raw: string, entities: ResolvableEntity[]): NameSuggestion[] {
  const scored = entities.map((entity) => ({
    entityId: entity.id,
    name: entity.label,
    score: Math.max(...entity.names.map((name) => similarity(raw, name))),
  }));
  return scored
    .filter((suggestion) => suggestion.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, SUGGESTION_LIMIT)
    .map((suggestion) => ({ ...suggestion, score: Math.round(suggestion.score * 100) / 100 }));
}

/** The single id in the set, or null when the key is ambiguous or unknown. */
function only(set: Set<string> | undefined): string | null {
  return set && set.size === 1 ? [...set][0] : null;
}

/**
 * Matches raw names to entities: exact alias, exact case-insensitive name,
 * normalised name, then fuzzy suggestions for the admin to confirm. A name
 * that matches two entities equally is left unresolved with both suggested.
 */
export function resolveNames(
  raws: Iterable<string>,
  entities: ResolvableEntity[],
  aliases: AliasRow[],
): Resolution {
  const index = buildIndex(entities, aliases);
  const resolved = new Map<string, string>();
  const inexact = new Map<string, string>();
  const unresolved: Unresolved[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const key = raw.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const byAlias = index.byAlias.get(key);
    if (byAlias) {
      resolved.set(key, byAlias);
      continue;
    }
    const byLower = only(index.byLower.get(key.toLowerCase()));
    if (byLower) {
      resolved.set(key, byLower);
      continue;
    }
    const byNormalised = only(index.byNormalised.get(normaliseName(key)));
    if (byNormalised) {
      resolved.set(key, byNormalised);
      inexact.set(key, byNormalised);
      continue;
    }
    unresolved.push({ raw: key, suggestions: suggestionsFor(key, entities) });
  }
  return { resolved, unresolved, inexact };
}

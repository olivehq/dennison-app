/**
 * Plain-English sentences for `audit_events` rows, for the activity page
 * (scope 2.5). Pure: no database. `names` maps buyer and supplier ids to their
 * display names (D34); anything it can't name falls back to a generic noun.
 */

export type DescribableAudit = {
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  note: string | null;
};

/** The type-of-change filter on the activity page. A pattern ending in "." is a prefix. */
export const AUDIT_ACTION_GROUPS = {
  schedule: { label: "Schedule edits", actions: ["appointment.", "schedule.reassign_desks"] },
  roster: { label: "Roster", actions: ["participant.", "supplier.", "token."] },
  imports: { label: "Imports", actions: ["import.", "alias."] },
  matching: { label: "Matching", actions: ["matching."] },
  lock: { label: "Lock and unlock", actions: ["schedule.lock", "schedule.unlock"] },
  emails: { label: "Emails", actions: ["email."] },
  exports: { label: "Exports", actions: ["export."] },
} as const satisfies Record<string, { label: string; actions: readonly string[] }>;

export type AuditActionGroup = keyof typeof AUDIT_ACTION_GROUPS;

export function isAuditActionGroup(value: unknown): value is AuditActionGroup {
  return typeof value === "string" && Object.hasOwn(AUDIT_ACTION_GROUPS, value);
}

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const IMPORT_KINDS: Record<string, string> = {
  participants: "participants",
  suppliers: "suppliers",
  buyer_biztech_rankings: "buyer biztech rankings",
  buyer_hotel_rankings: "buyer hotel rankings",
  supplier_rankings: "supplier rankings",
};

const EXPORTS: Record<string, string> = {
  master: "the master schedule CSV",
  schedules: "the schedules ZIP",
  report: "the quality report",
  access_list: "the participant access list",
};

const SETTING_LABELS: Record<string, string> = {
  slotCount: "slot count",
  slots: "slot times",
  supplierTarget: "meetings per supplier",
  buyerMin: "buyer minimum",
  buyerMax: "buyer maximum",
  buyerIdeal: "buyer ideal",
  mutualTopN: "mutual top N",
  hotelRankCutoff: "hotel rank cutoff",
  biztechOptInRule: "biztech opt-in rule",
  retainData: "data retention",
};

const EVENT_FIELDS: Record<string, string> = { name: "name", eventDate: "show date", timezone: "timezone" };

function changedKeys(before: Bag, after: Bag, labels: Record<string, string>): string[] {
  return Object.keys(labels).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map((k) => labels[k]);
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function describeAudit(row: DescribableAudit, names: ReadonlyMap<string, string>): string {
  const before = bag(row.before);
  const after = bag(row.after);
  const name = (id: unknown, fallback: string): string => (typeof id === "string" && names.get(id)) || fallback;
  const [area, verb] = row.action.split(".", 2);

  // Schedule edits (appointment snapshots in before and after).
  const where = (s: Bag) => `${name(s.supplierId, "a supplier")}, slot ${num(s.slot) ?? "?"}`;
  const buyer = (s: Bag) => name(s.buyerId, "a buyer");
  switch (row.action) {
    case "appointment.replace":
      return `Replaced ${buyer(before)} with ${buyer(after)} at ${where(after.slot ? after : before)}${after.pinKept ? ". The pin stays" : ""}`;
    case "appointment.add":
      return `Added ${buyer(after)} at ${where(after)}`;
    case "appointment.remove":
      return `Removed ${buyer(before)} from ${where(before)}`;
    case "appointment.undo": {
      const hasBefore = Object.keys(before).length > 0;
      const hasAfter = Object.keys(after).length > 0;
      if (hasBefore && hasAfter) return `Undid a change: put ${buyer(after)} back at ${where(after)} in place of ${buyer(before)}`;
      if (hasAfter) return `Undid a removal: put ${buyer(after)} back at ${where(after)}`;
      if (hasBefore) return `Undid an addition: removed ${buyer(before)} from ${where(before)}`;
      return "Undid a schedule change";
    }
    case "appointment.pin":
      return `Pinned ${buyer(after)} at ${where(after)}`;
    case "appointment.unpin":
      return `Unpinned ${buyer(after)} at ${where(after)}`;
    case "schedule.lock": {
      const tokens = num(after.tokensIssued);
      return `Locked the schedule and assigned desks${tokens !== null ? `. Issued ${plural(tokens, "new participant link")}` : ""}`;
    }
    case "schedule.unlock":
      return row.note ? `Unlocked the schedule: ${row.note}` : "Unlocked the schedule";
    case "schedule.reassign_desks": {
      const old = new Map(
        (Array.isArray(before.desks) ? before.desks : []).map((d) => [bag(d).supplierId, bag(d).desk] as const),
      );
      const moved = (Array.isArray(after.desks) ? after.desks : []).filter((d) => old.get(bag(d).supplierId) !== bag(d).desk);
      return `Reassigned desks alphabetically${Array.isArray(after.desks) ? `. ${plural(moved.length, "desk")} changed` : ""}`;
    }
    case "matching.run": {
      if (after.status === "failed") return `Matching failed${str(after.error) ? `: ${after.error}` : ""}`;
      const kept = num(after.pinnedCount);
      const count = num(after.appointments);
      const warnings = num(after.warningCount);
      const parts = [after.keepExisting ? `Re-ran matching keeping ${plural(kept ?? 0, "existing appointment")}` : "Ran matching"];
      if (count !== null) parts.push(plural(count, "appointment"));
      if (warnings) parts.push(plural(warnings, "warning"));
      return `${parts.join(", ")}${after.isActive ? ". It became the active run" : ""}`;
    }
    case "matching.activate":
      return "Made a different run the active schedule";
  }

  // Roster.
  const personName = (fallback: string) => {
    const fromRow = str(after.name) ?? str(before.name) ?? str(after.displayName);
    const first = str(after.firstName) ?? str(before.firstName);
    const last = str(after.lastName) ?? str(before.lastName);
    return name(row.entityId, fromRow ?? (first || last ? [first, last].filter(Boolean).join(" ") : fallback));
  };
  if (area === "participant" || area === "supplier") {
    const who = personName(area === "participant" ? "a participant" : "a supplier");
    const noun = area === "participant" ? "participant" : "supplier";
    switch (verb) {
      case "create":
        return `Added ${noun} ${who}`;
      case "update":
        return `Edited ${who}${row.note ? `. ${row.note}` : ""}`;
      case "withdraw":
        return `Withdrew ${who}`;
      case "restore":
        return `Restored ${who}`;
      case "biztech_opt_in":
        return after.biztechOptIn ? `Opted ${who} in to biztech` : `Opted ${who} out of biztech`;
      case "desk": {
        const desk = num(after.deskNumber);
        if (desk === null) return `Cleared the desk of ${who}`;
        return `Set ${who} to desk ${desk}${after.deskOverride ? " (kept at lock)" : ""}`;
      }
    }
  }
  if (area === "token") {
    const who = name(after.entityId, "a contact");
    if (verb === "regenerate") return `Sent ${who} a new link. The old one stopped working`;
    if (verb === "revoke") return `Revoked the link for ${who}`;
  }

  // Imports.
  if (area === "import") {
    const kind = IMPORT_KINDS[String(after.kind ?? before.kind)] ?? "a";
    const file = str(after.fileName) ?? str(before.fileName);
    switch (verb) {
      case "create":
        return `Uploaded ${file ?? `a ${kind} file`}${file ? ` (${kind})` : ""}`;
      case "apply": {
        const written = num(after.rankingsWritten);
        const created = num(after.created);
        const detail = written ? `, ${plural(written, "ranking")} written` : created ? `, ${plural(created, "new row")}` : "";
        return `Applied the ${kind} import${detail}`;
      }
      case "delete":
        return `Deleted the import ${file ?? ""}`.trim();
    }
  }
  if (row.action === "alias.save") {
    return `Matched the name "${str(after.raw) ?? "?"}" to ${name(after.entityId, "someone on the roster")}`;
  }

  // Event.
  switch (row.action) {
    case "event.create":
      return "Created the event";
    case "event.update": {
      const fields = changedKeys(before, after, EVENT_FIELDS);
      return fields.length ? `Changed the event ${list(fields)}` : "Edited the event";
    }
    case "event.settings": {
      const fields = changedKeys(before, after, SETTING_LABELS);
      return fields.length ? `Changed the settings: ${list(fields)}` : "Saved the settings";
    }
    case "event.retention":
      return after.retainData
        ? "Turned on keeping participant data after 90 days"
        : "Turned off keeping participant data. It will be deleted 90 days after the event";
    case "event.retention_delete": {
      const counts = bag(after.deleted);
      const parts = [
        num(counts.participants) !== null ? plural(num(counts.participants)!, "participant") : null,
        num(counts.suppliers) !== null ? plural(num(counts.suppliers)!, "supplier") : null,
      ].filter((p): p is string => p !== null);
      return `Deleted participant data 90 days after the event${parts.length ? `: ${list(parts)} and their schedules` : ""}`;
    }
  }

  // Exports and email.
  if (area === "export") return `Downloaded ${EXPORTS[verb] ?? "an export"}`;
  if (area === "email") {
    const campaign = str(after.name) ?? str(after.subject) ?? str(before.name) ?? str(before.subject);
    const quoted = campaign ? `"${campaign}"` : "an email";
    const sent = num(after.sent);
    const failed = num(after.failed);
    const tally = `${sent !== null ? ` to ${plural(sent, "recipient")}` : ""}${failed ? `, ${failed} failed` : ""}`;
    switch (verb) {
      case "create":
        return `Created the email ${quoted}`;
      case "update":
        return `Edited the email ${quoted}`;
      case "duplicate":
        return `Duplicated an email as ${quoted}`;
      case "test":
        return `Sent a test of ${quoted}${str(after.toEmail) ? ` to ${after.toEmail}` : ""}`;
      case "send":
        return `Sent ${quoted}${tally}`;
      case "resend":
        return `Resent ${quoted}${tally}`;
    }
  }

  const words = row.action.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

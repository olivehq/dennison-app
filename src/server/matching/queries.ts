import { and, count, desc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, appointments, matchRuns, participants, rankings, suppliers, type MatchRun } from "@/db/schema";
import type { QualityStats } from "@/engine";
import type { ActionResult } from "@/lib/errors";
import {
  compareRuns,
  diffAppointments,
  failRunsOlderThan,
  findActiveRun,
  findRun,
  RUN_TIMEOUT_MINUTES,
  type RunComparison,
} from "./runs";

/** The jsonb column is typed loosely; the engine owns the shape. */
export function readStats(stats: Record<string, unknown> | null): QualityStats | null {
  return stats ? (stats as QualityStats) : null;
}

export type RunStatsSummary = {
  totalAppointments: number;
  supplierSuccessPct: number;
  buyersInRangePct: number;
  mutualTopNPct: number;
};

export type RunSummary = {
  id: string;
  status: MatchRun["status"];
  isActive: boolean;
  parentRunId: string | null;
  version: number;
  durationMs: number | null;
  warningCount: number;
  createdAt: Date;
  completedAt: Date | null;
  createdBy: string | null;
  createdByName: string | null;
  summary: RunStatsSummary | null;
};

export type RunDetail = MatchRun & { stats: QualityStats | null };

export function summarizeStats(stats: QualityStats | null): RunStatsSummary | null {
  if (!stats) return null;
  return {
    totalAppointments: stats.totalAppointments,
    supplierSuccessPct: stats.supplierSuccessPct,
    buyersInRangePct: stats.buyersInRangePct,
    mutualTopNPct: stats.mutualTopN.pct,
  };
}

/**
 * Every run of an event, newest first, with the headline numbers for the runs
 * table. Runs stuck in `running` past the timeout are marked failed first.
 */
export async function listRuns(eventId: string, db: Db = getDb()): Promise<RunSummary[]> {
  await failRunsOlderThan(db, RUN_TIMEOUT_MINUTES);
  const rows = await db
    .select({ run: matchRuns, createdByName: admins.name })
    .from(matchRuns)
    .leftJoin(admins, eq(admins.id, matchRuns.createdBy))
    .where(eq(matchRuns.eventId, eventId))
    .orderBy(desc(matchRuns.createdAt), desc(matchRuns.id));
  return rows.map(({ run, createdByName }) => ({
    id: run.id,
    status: run.status,
    isActive: run.isActive,
    parentRunId: run.parentRunId,
    version: run.version,
    durationMs: run.durationMs,
    warningCount: run.warnings.length,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    createdBy: run.createdBy,
    createdByName,
    summary: summarizeStats(readStats(run.stats)),
  }));
}

export async function getRun(runId: string, db: Db = getDb()): Promise<RunDetail | null> {
  const run = await findRun(db, runId);
  return run ? { ...run, stats: readStats(run.stats) } : null;
}

export async function getActiveRun(eventId: string, db: Db = getDb()): Promise<RunDetail | null> {
  const run = await findActiveRun(db, eventId);
  return run ? { ...run, stats: readStats(run.stats) } : null;
}

export type MatchingCounts = {
  /** Active participants, the people matching will schedule. */
  buyers: number;
  suppliers: number;
  /** `rankings` rows by who ranked. */
  buyerRankings: number;
  supplierRankings: number;
};

/** What the matching page shows before a run: who is on the roster and how many rankings are loaded. */
export async function getMatchingReadiness(eventId: string, db: Db = getDb()): Promise<MatchingCounts> {
  const [[buyerRow], [supplierRow], rankingRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(participants)
      .where(and(eq(participants.eventId, eventId), eq(participants.status, "active"))),
    db
      .select({ value: count() })
      .from(suppliers)
      .where(and(eq(suppliers.eventId, eventId), eq(suppliers.status, "active"))),
    db
      .select({ rankerType: rankings.rankerType, value: count() })
      .from(rankings)
      .where(eq(rankings.eventId, eventId))
      .groupBy(rankings.rankerType),
  ]);
  const byType = new Map(rankingRows.map((r) => [r.rankerType, Number(r.value)]));
  return {
    buyers: Number(buyerRow?.value ?? 0),
    suppliers: Number(supplierRow?.value ?? 0),
    buyerRankings: byType.get("buyer") ?? 0,
    supplierRankings: byType.get("supplier") ?? 0,
  };
}

/** What activating `runId` would change against the event's active run. */
export async function compareWithActiveRun(
  eventId: string,
  runId: string,
  db: Db = getDb(),
): Promise<ActionResult<RunComparison> | null> {
  const active = await findActiveRun(db, eventId);
  if (!active || active.id === runId) return null;
  return compareRuns(db, { runId, otherRunId: active.id });
}

export type CompareTarget = "parent" | "active";

export type RunComparisonView = {
  /** What the run is compared with. */
  against: CompareTarget;
  otherRunId: string;
  /** Targets the page can switch to: the parent when the run has one, the active run when it is a different run. */
  options: CompareTarget[];
  result: ActionResult<RunComparison>;
};

/**
 * The comparison the matching page shows for one run. A run built with "keep
 * existing" compares with the run it kept from by default, so the diff is what
 * the re-run changed; `against: "active"` compares with the active run, which
 * is what activating would change. Null when there is nothing to compare with.
 */
export async function compareRunForPage(
  eventId: string,
  runId: string,
  against: CompareTarget | undefined,
  db: Db = getDb(),
): Promise<RunComparisonView | null> {
  const run = await findRun(db, runId);
  if (!run || run.eventId !== eventId) return null;
  const [parent, active] = await Promise.all([
    run.parentRunId ? findRun(db, run.parentRunId) : Promise.resolve(null),
    findActiveRun(db, eventId),
  ]);
  const options: CompareTarget[] = [];
  if (parent) options.push("parent");
  if (active && active.id !== run.id && active.id !== parent?.id) options.push("active");
  if (options.length === 0) return null;
  const chosen = against && options.includes(against) ? against : options[0];
  const other = chosen === "parent" ? parent! : active!;
  return { against: chosen, otherRunId: other.id, options, result: await compareRuns(db, { runId, otherRunId: other.id }) };
}

export type ActivationPreview = { added: number; removed: number; countChanges: number };

/**
 * For each completed run that is not active, what activating it would change
 * against the active run, in counts. Shown in the "Activate this run" dialog.
 * One query for every appointment of the event. Empty when no run is active.
 */
export async function activationPreviews(eventId: string, db: Db = getDb()): Promise<Map<string, ActivationPreview>> {
  const previews = new Map<string, ActivationPreview>();
  const active = await findActiveRun(db, eventId);
  if (!active) return previews;
  const [runs, rows] = await Promise.all([
    db
      .select({ id: matchRuns.id })
      .from(matchRuns)
      .where(and(eq(matchRuns.eventId, eventId), eq(matchRuns.status, "completed"), eq(matchRuns.isActive, false))),
    db.select().from(appointments).where(eq(appointments.eventId, eventId)),
  ]);
  const byRun = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const list = byRun.get(row.runId);
    if (list) list.push(row);
    else byRun.set(row.runId, [row]);
  }
  const activeRows = byRun.get(active.id) ?? [];
  const noNames = new Map<string, string>();
  const noSuppliers = new Set<string>();
  for (const run of runs) {
    const diff = diffAppointments(byRun.get(run.id) ?? [], activeRows, noNames, noSuppliers);
    previews.set(run.id, { added: diff.added.length, removed: diff.removed.length, countChanges: diff.countChanges.length });
  }
  return previews;
}

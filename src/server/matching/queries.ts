import { and, count, desc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, matchRuns, participants, rankings, suppliers, type MatchRun } from "@/db/schema";
import type { QualityStats } from "@/engine";
import type { ActionResult } from "@/lib/errors";
import { compareRuns, findActiveRun, findRun, type RunComparison } from "./runs";

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

/** Every run of an event, newest first, with the headline numbers for the runs table. */
export async function listRuns(eventId: string, db: Db = getDb()): Promise<RunSummary[]> {
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

export type MatchingReadiness = {
  /** Active participants, the people matching will schedule. */
  buyers: number;
  suppliers: number;
  /** `rankings` rows by who ranked. */
  buyerRankings: number;
  supplierRankings: number;
};

/** What the matching page shows before a run: who is on the roster and how many rankings are loaded. */
export async function getMatchingReadiness(eventId: string, db: Db = getDb()): Promise<MatchingReadiness> {
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

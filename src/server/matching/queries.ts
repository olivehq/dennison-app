import { desc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, matchRuns, type MatchRun } from "@/db/schema";
import type { QualityStats } from "@/engine";
import { findActiveRun, findRun } from "./runs";

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

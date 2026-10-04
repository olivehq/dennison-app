import { and, count, desc, eq, isNull, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { auditEvents, type AuditEvent } from "@/db/schema";

export type RecordAuditInput = {
  eventId: string | null;
  adminId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string | null;
};

/** Writes one audit row. Pass the transaction handle when the change itself runs in one. */
export async function recordAudit(db: Db, input: RecordAuditInput): Promise<AuditEvent> {
  const [row] = await db
    .insert(auditEvents)
    .values({
      eventId: input.eventId,
      adminId: input.adminId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      note: input.note ?? null,
    })
    .returning();
  return row;
}

export type AuditFilters = {
  adminId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
};

export type ListAuditInput = {
  /** Null lists team and admin changes, which belong to no event. */
  eventId: string | null;
  filters?: AuditFilters;
  page?: number;
  pageSize?: number;
};

export type AuditPage = {
  rows: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
};

export const DEFAULT_AUDIT_PAGE_SIZE = 50;

export async function listAudit(input: ListAuditInput, db: Db = getDb()): Promise<AuditPage> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? DEFAULT_AUDIT_PAGE_SIZE));
  const filters = input.filters ?? {};

  const conditions: SQL[] = [];
  if (input.eventId === null) {
    conditions.push(isNull(auditEvents.eventId));
  } else {
    conditions.push(eq(auditEvents.eventId, input.eventId));
  }
  if (filters.adminId) conditions.push(eq(auditEvents.adminId, filters.adminId));
  if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
  if (filters.entityType) conditions.push(eq(auditEvents.entityType, filters.entityType));
  if (filters.entityId) conditions.push(eq(auditEvents.entityId, filters.entityId));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(auditEvents).where(where),
  ]);

  return { rows, total, page, pageSize };
}

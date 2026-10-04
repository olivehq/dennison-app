import { and, eq, not, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { emailMessages, type EmailDeliveryEvent, type EmailMessageStatus } from "@/db/schema";
import { verifyWebhook } from "@/lib/email/adapter";

/**
 * Resend delivery webhooks (scope 2.7). Each event is appended to the
 * message's `events` and may move its status forward. Recording the same
 * webhook twice changes nothing.
 */

const RESEND_TYPES = [
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "failed",
  "suppressed",
  "opened",
  "clicked",
] as const;
export type DeliveryEventType = (typeof RESEND_TYPES)[number];

export type DeliveryEvent = {
  type: DeliveryEventType;
  /** Resend's email id, which `sendBatch` returned and we stored. */
  providerMessageId: string;
  /** Our email_messages id from the `aw_message` tag, when present. */
  messageId: string | null;
  /** ISO time the event happened. */
  at: string;
  /** Bounce, failure, or suppression reason. */
  detail?: string;
  /** The webhook delivery id (`svix-id`), the same on every retry. */
  webhookId?: string;
};

/** The status an event moves a message to; null means the event is only logged. */
const STATUS_FOR: Record<DeliveryEventType, EmailMessageStatus | null> = {
  sent: "sent",
  delivered: "delivered",
  delivery_delayed: null,
  bounced: "bounced",
  complained: "complained",
  failed: "failed",
  suppressed: "bounced",
  opened: null,
  clicked: null,
};

/** Statuses only move forward: queued, sent, delivered, then one of the final ones. */
const RANK: Record<EmailMessageStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  bounced: 3,
  complained: 3,
  failed: 3,
};

const tagsSchema = z
  .union([
    z.record(z.string(), z.string()),
    z.array(z.object({ name: z.string(), value: z.string() })).transform((tags) =>
      Object.fromEntries(tags.map((t) => [t.name, t.value])),
    ),
  ])
  .optional()
  .catch(undefined);

const payloadSchema = z.object({
  type: z.string(),
  created_at: z.string(),
  data: z.object({
    email_id: z.string().min(1),
    created_at: z.string().optional(),
    tags: tagsSchema,
    bounce: z.object({ message: z.string().optional(), type: z.string().optional(), subType: z.string().optional() }).optional(),
    failed: z.object({ reason: z.string().optional() }).optional(),
    suppressed: z.object({ message: z.string().optional(), type: z.string().optional() }).optional(),
  }),
});

const uuid = z.uuid();

function isDeliveryType(value: string): value is DeliveryEventType {
  return (RESEND_TYPES as readonly string[]).includes(value);
}

/**
 * The parts of a Resend webhook payload we keep, or null for anything that is
 * not an email delivery event (contacts, domains, received mail).
 */
export function parseResendEvent(json: unknown, webhookId?: string): DeliveryEvent | null {
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const { type, created_at, data } = parsed.data;
  if (!type.startsWith("email.")) return null;
  const short = type.slice("email.".length);
  if (!isDeliveryType(short)) return null;
  const at = new Date(created_at);
  const tag = data.tags?.aw_message;
  const detail =
    short === "bounced"
      ? [data.bounce?.type, data.bounce?.subType, data.bounce?.message].filter(Boolean).join(": ")
      : short === "failed"
        ? data.failed?.reason
        : short === "suppressed"
          ? ["Suppressed", data.suppressed?.message].filter(Boolean).join(": ")
          : undefined;
  return {
    type: short,
    providerMessageId: data.email_id,
    messageId: tag && uuid.safeParse(tag).success ? tag : null,
    at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
    ...(webhookId ? { webhookId } : {}),
  };
}

export type RecordOutcome = "recorded" | "duplicate" | "unknown";

function rankOf(column: typeof emailMessages.status): SQL<number> {
  return sql<number>`(case ${column} when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 else 3 end)`;
}

/** Applies one delivery event to its message. Idempotent per webhook id (or type and time). */
export async function recordDeliveryEvent(db: Db, event: DeliveryEvent): Promise<RecordOutcome> {
  const entry: EmailDeliveryEvent = {
    type: event.type,
    at: event.at,
    id: event.webhookId ?? `${event.type}@${event.at}`,
    ...(event.detail ? { detail: event.detail } : {}),
  };
  const target = event.messageId
    ? or(eq(emailMessages.providerMessageId, event.providerMessageId), eq(emailMessages.id, event.messageId))!
    : eq(emailMessages.providerMessageId, event.providerMessageId);
  const status = STATUS_FOR[event.type];
  const seen = sql`${emailMessages.events} @> ${JSON.stringify([{ id: entry.id }])}::jsonb`;

  const updated = await db
    .update(emailMessages)
    .set({
      events: sql`${emailMessages.events} || ${JSON.stringify([entry])}::jsonb`,
      lastEventAt: sql`greatest(${emailMessages.lastEventAt}, ${event.at}::timestamptz)`,
      providerMessageId: sql`coalesce(${emailMessages.providerMessageId}, ${event.providerMessageId})`,
      ...(status
        ? {
            status: sql`case when ${rankOf(emailMessages.status)} < ${RANK[status]} then ${status}::email_message_status else ${emailMessages.status} end`,
          }
        : {}),
    })
    .where(and(target, not(seen)))
    .returning({ id: emailMessages.id });
  if (updated.length > 0) return "recorded";

  const [existing] = await db.select({ id: emailMessages.id }).from(emailMessages).where(target).limit(1);
  return existing ? "duplicate" : "unknown";
}

export type WebhookRequest = {
  payload: string;
  headers: { id: string | null; timestamp: string | null; signature: string | null };
};

export type WebhookResponse = { status: number; body: string };

/**
 * The Route Handler's logic, kept here so it can be tested without a server.
 * 401 for a missing or bad signature. Without a secret: 500 in production,
 * 200 and skip in development and tests (with a warning).
 */
/** Resend webhook bodies are a few KB; anything far larger is not from Resend. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

/**
 * Checked before the body is read: a request without a Content-Length or with
 * one over `WEBHOOK_MAX_BYTES` gets 413, so a large or streamed body is never
 * buffered. Null means the size is fine.
 */
export function webhookSizeProblem(contentLength: string | null): WebhookResponse | null {
  const bytes = contentLength === null || contentLength.trim() === "" ? NaN : Number(contentLength);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { status: 413, body: "A Content-Length header is required." };
  }
  if (bytes > WEBHOOK_MAX_BYTES) return { status: 413, body: "The webhook body is too large." };
  return null;
}

export async function handleResendWebhook(
  db: Db,
  request: WebhookRequest,
  options: { secret: string | undefined; isProduction: boolean },
): Promise<WebhookResponse> {
  if (!options.secret) {
    if (options.isProduction) return { status: 500, body: "RESEND_WEBHOOK_SECRET is not set." };
    console.warn("[email] RESEND_WEBHOOK_SECRET is not set; ignoring a Resend webhook.");
    return { status: 200, body: "Skipped: no webhook secret configured." };
  }
  const { id, timestamp, signature } = request.headers;
  if (!id || !timestamp || !signature) return { status: 401, body: "Missing signature headers." };
  let json: unknown;
  try {
    json = verifyWebhook(request.payload, { id, timestamp, signature }, options.secret);
  } catch {
    return { status: 401, body: "Invalid signature." };
  }
  const event = parseResendEvent(json, id);
  if (!event) return { status: 200, body: "Ignored." };
  const outcome = await recordDeliveryEvent(db, event);
  return { status: 200, body: outcome };
}

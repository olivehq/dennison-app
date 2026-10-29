import { Resend } from "resend";
import { env } from "@/lib/env";

export type EmailMessage = {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  tags?: Record<string, string>;
};

export type SentEmail = { id: string };

export type BatchOptions = {
  /**
   * The same key on a retry makes the provider return the first answer
   * instead of sending again. Resend keeps a key for 24 hours.
   */
  idempotencyKey: string;
};

/**
 * The provider answered and refused the batch, so nothing was sent and a
 * retry under a new key is safe. Any other error from `sendBatch` means the
 * outcome is unknown: the batch may have been accepted.
 */
export class EmailRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailRejectedError";
  }
}

type EmailAdapter = {
  send(message: EmailMessage): Promise<SentEmail>;
  sendBatch(messages: EmailMessage[], options: BatchOptions): Promise<SentEmail[]>;
};

/** Resend's batch API takes at most 100 messages per call. Callers chunk to this size. */
export const RESEND_BATCH_LIMIT = 100;

function toResendPayload(message: EmailMessage) {
  return {
    from: message.from,
    to: message.to,
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tags: message.tags
      ? Object.entries(message.tags).map(([name, value]) => ({ name, value }))
      : undefined,
  };
}

function resendAdapter(apiKey: string): EmailAdapter {
  const resend = new Resend(apiKey);
  return {
    async send(message) {
      const { data, error } = await resend.emails.send(toResendPayload(message));
      if (error || !data) {
        throw new Error(`Resend rejected the email: ${error?.message ?? "no id returned"}`);
      }
      return { id: data.id };
    },
    async sendBatch(messages, options) {
      const { data, error } = await resend.batch.send(messages.map(toResendPayload), {
        idempotencyKey: options.idempotencyKey,
      });
      if (error || !data) {
        const message = `Resend rejected the batch: ${error?.message ?? "no ids returned"}`;
        throw error && isProviderRefusal(error) ? new EmailRejectedError(message) : new Error(message);
      }
      return data.data.map((item) => ({ id: item.id }));
    },
  };
}

/**
 * True when Resend answered with a 4xx that says it did not take the batch.
 * No status (the request never got an answer), a 5xx, a 429 (a rate limit can
 * be checked before the key, so an earlier attempt may have gone), and the two
 * 409s about the idempotency key (the key is in use or was used for another
 * payload) leave the outcome unknown.
 */
export function isProviderRefusal(error: { statusCode: number | null; name: string }): boolean {
  if (error.statusCode === null || error.statusCode < 400 || error.statusCode >= 500 || error.statusCode === 429) return false;
  return error.name !== "concurrent_idempotent_requests" && error.name !== "invalid_idempotent_request";
}

/** The part after the last "@", or "unknown". */
export function recipientDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "unknown" : address.slice(at + 1).replace(/>$/, "").trim().toLowerCase() || "unknown";
}

const loggedEmails: EmailMessage[] = [];
let loggedCounter = 0;
/** Batch answers and payloads by idempotency key, so a retried batch is logged once, as Resend sends it once. */
const loggedBatches = new Map<string, { payload: string; results: SentEmail[] }>();

function loggerAdapter(): EmailAdapter {
  const send = async (message: EmailMessage): Promise<SentEmail> => {
    loggedEmails.push(message);
    loggedCounter += 1;
    if (env.NODE_ENV !== "test") {
      // Server logs outlive the 90-day retention, so no address or subject text.
      console.log(`[email] logged, not sent: to=*@${recipientDomain(message.to)} subjectLength=${message.subject.length}`);
    }
    return { id: `logged-${loggedCounter}` };
  };
  return {
    send,
    async sendBatch(messages, options) {
      const payload = JSON.stringify(messages);
      const earlier = loggedBatches.get(options.idempotencyKey);
      if (earlier) {
        // As Resend does: a known key with another payload is a 409, outcome unknown.
        if (earlier.payload !== payload) throw new Error("Resend rejected the batch: invalid_idempotent_request");
        return earlier.results;
      }
      const results: SentEmail[] = [];
      for (const message of messages) results.push(await send(message));
      loggedBatches.set(options.idempotencyKey, { payload, results });
      return results;
    },
  };
}

let adapter: EmailAdapter | undefined;

/** False when mail goes to the logger adapter instead of Resend (no RESEND_API_KEY). */
export function isEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

function getAdapter(): EmailAdapter {
  if (adapter) return adapter;
  adapter = isEmailConfigured() ? resendAdapter(env.RESEND_API_KEY!) : loggerAdapter();
  return adapter;
}

export function sendEmail(message: EmailMessage): Promise<SentEmail> {
  return getAdapter().send(message);
}

export function sendBatch(messages: EmailMessage[], options: BatchOptions): Promise<SentEmail[]> {
  if (messages.length === 0) return Promise.resolve([]);
  if (messages.length > RESEND_BATCH_LIMIT) {
    return Promise.reject(
      new EmailRejectedError(`A batch holds at most ${RESEND_BATCH_LIMIT} messages, got ${messages.length}.`),
    );
  }
  return getAdapter().sendBatch(messages, options);
}

/** Messages captured by the logger adapter (local dev and tests). */
export function getLoggedEmails(): readonly EmailMessage[] {
  return loggedEmails;
}

export function clearLoggedEmails(): void {
  loggedEmails.length = 0;
}

export type WebhookHeaders = { id: string; timestamp: string; signature: string };

/**
 * Verifies a Resend webhook (Svix-style headers `svix-id`, `svix-timestamp`,
 * `svix-signature`) against the signing secret and returns the parsed JSON.
 * Throws when the signature or timestamp is wrong. Uses the `resend` package's
 * own verifier, so no extra dependency (D62).
 */
export function verifyWebhook(payload: string, headers: WebhookHeaders, secret: string): unknown {
  // Verification is local; the API key is never used, so a placeholder is fine.
  const resend = new Resend(env.RESEND_API_KEY ?? "re_webhook_verify_only");
  return resend.webhooks.verify({ payload, headers, webhookSecret: secret });
}

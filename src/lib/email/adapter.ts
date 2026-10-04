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

type EmailAdapter = {
  send(message: EmailMessage): Promise<SentEmail>;
  sendBatch(messages: EmailMessage[]): Promise<SentEmail[]>;
};

const RESEND_BATCH_LIMIT = 100;

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
    async sendBatch(messages) {
      const ids: SentEmail[] = [];
      for (let i = 0; i < messages.length; i += RESEND_BATCH_LIMIT) {
        const chunk = messages.slice(i, i + RESEND_BATCH_LIMIT);
        const { data, error } = await resend.batch.send(chunk.map(toResendPayload));
        if (error || !data) {
          throw new Error(`Resend rejected the batch: ${error?.message ?? "no ids returned"}`);
        }
        ids.push(...data.data.map((item) => ({ id: item.id })));
      }
      return ids;
    },
  };
}

/** The part after the last "@", or "unknown". */
export function recipientDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "unknown" : address.slice(at + 1).replace(/>$/, "").trim().toLowerCase() || "unknown";
}

const loggedEmails: EmailMessage[] = [];
let loggedCounter = 0;

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
    async sendBatch(messages) {
      const results: SentEmail[] = [];
      for (const message of messages) results.push(await send(message));
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

export function sendBatch(messages: EmailMessage[]): Promise<SentEmail[]> {
  if (messages.length === 0) return Promise.resolve([]);
  return getAdapter().sendBatch(messages);
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

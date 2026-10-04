import { getDb } from "@/db/client";
import { env } from "@/lib/env";
import { handleResendWebhook } from "@/server/email/webhook";

/**
 * Resend delivery webhooks (scope 2.7). Public route; the Svix signature made
 * with RESEND_WEBHOOK_SECRET is the authentication.
 */
export async function POST(request: Request) {
  const payload = await request.text();
  const result = await handleResendWebhook(
    getDb(),
    {
      payload,
      headers: {
        id: request.headers.get("svix-id") ?? request.headers.get("webhook-id"),
        timestamp: request.headers.get("svix-timestamp") ?? request.headers.get("webhook-timestamp"),
        signature: request.headers.get("svix-signature") ?? request.headers.get("webhook-signature"),
      },
    },
    { secret: env.RESEND_WEBHOOK_SECRET, isProduction: env.isProduction },
  );
  return new Response(result.body, { status: result.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

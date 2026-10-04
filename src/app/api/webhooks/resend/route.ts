import { getDb } from "@/db/client";
import { env } from "@/lib/env";
import { handleResendWebhook, webhookSizeProblem } from "@/server/email/webhook";

const PLAIN_TEXT = { "content-type": "text/plain; charset=utf-8" };

/**
 * Resend delivery webhooks (scope 2.7). Public route; the Svix signature made
 * with RESEND_WEBHOOK_SECRET is the authentication. The size check runs before
 * the body is read; the signature is checked before the JSON is parsed.
 */
export async function POST(request: Request) {
  const tooLarge = webhookSizeProblem(request.headers.get("content-length"));
  if (tooLarge) return new Response(tooLarge.body, { status: tooLarge.status, headers: PLAIN_TEXT });
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
  return new Response(result.body, { status: result.status, headers: PLAIN_TEXT });
}

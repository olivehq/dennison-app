"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import type { EmailCampaign } from "@/db/schema";
import { fromZod, ok, type ActionResult } from "@/lib/errors";
import {
  campaignIdInput,
  createCampaignInput,
  duplicateCampaignInput,
  previewCampaignInput,
  sendTestInput,
  updateCampaignInput,
} from "@/lib/schemas/email";
import { requireAdmin } from "@/server/auth/session";
import {
  createCampaign,
  duplicateCampaign,
  previewCampaign,
  resendToBounced,
  sendCampaign,
  sendTest,
  updateCampaign,
  type RenderedEmail,
  type SendResult,
} from "./campaigns";

function revalidateEmails(eventId: string, campaignId?: string) {
  revalidatePath(`/events/${eventId}/emails`);
  if (campaignId) revalidatePath(`/events/${eventId}/emails/${campaignId}`);
}

/** After a send the event status, roster flags, and overview counts change too. */
function revalidateAfterSend(eventId: string) {
  revalidatePath(`/events/${eventId}`, "layout");
}

type CampaignRef = { campaignId: string; eventId: string };

function ref(campaign: EmailCampaign): CampaignRef {
  return { campaignId: campaign.id, eventId: campaign.eventId };
}

export async function createCampaignAction(input: unknown): Promise<ActionResult<CampaignRef>> {
  const admin = await requireAdmin();
  const parsed = createCampaignInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await createCampaign(getDb(), { ...parsed.data, adminId: admin.id });
  if (!result.ok) return result;
  revalidateEmails(result.data.eventId);
  return ok(ref(result.data));
}

export async function updateCampaignAction(input: unknown): Promise<ActionResult<CampaignRef>> {
  const admin = await requireAdmin();
  const parsed = updateCampaignInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await updateCampaign(getDb(), { ...parsed.data, adminId: admin.id });
  if (!result.ok) return result;
  revalidateEmails(result.data.eventId, result.data.id);
  return ok(ref(result.data));
}

export async function duplicateCampaignAction(input: unknown): Promise<ActionResult<CampaignRef>> {
  const admin = await requireAdmin();
  const parsed = duplicateCampaignInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await duplicateCampaign(getDb(), { ...parsed.data, adminId: admin.id });
  if (!result.ok) return result;
  revalidateEmails(result.data.eventId);
  return ok(ref(result.data));
}

/** A read behind an action: the preview follows unsaved editor content. */
export async function previewCampaignAction(input: unknown): Promise<ActionResult<RenderedEmail>> {
  await requireAdmin();
  const parsed = previewCampaignInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  return previewCampaign(getDb(), parsed.data);
}

export async function sendTestAction(
  input: unknown,
): Promise<ActionResult<{ toEmail: string; recipientName: string | null }>> {
  const admin = await requireAdmin();
  const parsed = sendTestInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  return sendTest(getDb(), { ...parsed.data, adminId: admin.id });
}

export async function sendCampaignAction(input: unknown): Promise<ActionResult<SendResult>> {
  const admin = await requireAdmin();
  const parsed = campaignIdInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await sendCampaign(getDb(), { campaignId: parsed.data.campaignId, adminId: admin.id });
  if (result.ok) revalidateAfterSend(result.data.eventId);
  return result;
}

export async function resendToBouncedAction(input: unknown): Promise<ActionResult<SendResult>> {
  const admin = await requireAdmin();
  const parsed = campaignIdInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await resendToBounced(getDb(), { campaignId: parsed.data.campaignId, adminId: admin.id });
  if (result.ok) revalidateAfterSend(result.data.eventId);
  return result;
}

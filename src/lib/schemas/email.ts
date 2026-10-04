import { z } from "zod";

/**
 * Inputs for the email module (scope 2.7). Shared by the campaign editor form
 * and the server actions.
 */

export const EMAIL_AUDIENCES = ["all", "buyers", "suppliers", "selected", "changed_since_last_send"] as const;
export const emailAudienceSchema = z.enum(EMAIL_AUDIENCES);
export type EmailAudience = z.infer<typeof emailAudienceSchema>;

export const EMAIL_CAMPAIGN_KINDS = ["initial", "reminder", "update"] as const;
export const emailCampaignKindSchema = z.enum(EMAIL_CAMPAIGN_KINDS);
export type EmailCampaignKind = z.infer<typeof emailCampaignKindSchema>;

export type RecipientContactType = "buyer" | "supplier_admin" | "supplier_attendee";

/** "buyer:<uuid>", "supplier_admin:<uuid>", "supplier_attendee:<uuid>". */
export const recipientKeySchema = z
  .string()
  .regex(
    /^(buyer|supplier_admin|supplier_attendee):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Expected a recipient key.",
  );

export function recipientKey(contactType: RecipientContactType, entityId: string): string {
  return `${contactType}:${entityId}`;
}

export function parseRecipientKey(key: string): { contactType: RecipientContactType; entityId: string } | null {
  if (!recipientKeySchema.safeParse(key).success) return null;
  const [contactType, entityId] = key.split(":") as [RecipientContactType, string];
  return { contactType, entityId: entityId.toLowerCase() };
}

const address = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address."));

/** The editable fields of a campaign. `replyTo` is required so replies reach a person (scope 2.7). */
export const campaignFieldsSchema = z
  .object({
    name: z.string().trim().min(1, "Name the campaign.").max(120),
    fromName: z.string().trim().min(1, "Add a sender name.").max(120),
    fromEmail: address,
    replyTo: z
      .string({ error: "Add a reply-to address so replies reach a person." })
      .trim()
      .toLowerCase()
      .min(1, "Add a reply-to address so replies reach a person.")
      .pipe(z.email("Enter a valid reply-to address.")),
    subject: z.string().trim().min(1, "Add a subject.").max(200),
    htmlBody: z.string().max(100_000, "The message is too long."),
    audience: emailAudienceSchema,
    selectedRecipients: z.array(recipientKeySchema).max(2000).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.audience === "selected" && value.selectedRecipients.length === 0) {
      ctx.addIssue({ code: "custom", path: ["selectedRecipients"], message: "Pick at least one recipient." });
    }
  });

export type CampaignFieldsInput = z.input<typeof campaignFieldsSchema>;
export type CampaignFields = z.output<typeof campaignFieldsSchema>;

const uuid = z.uuid("Expected an id.");

export const createCampaignInput = z.object({
  eventId: uuid,
  kind: z.enum(["initial", "update"]).default("initial"),
});

export const updateCampaignInput = z.object({ campaignId: uuid, fields: campaignFieldsSchema });

export const duplicateCampaignInput = z.object({ campaignId: uuid, kind: z.enum(["reminder", "update"]) });

export const previewCampaignInput = z.object({
  campaignId: uuid,
  recipient: recipientKeySchema.optional(),
  /** Unsaved editor content, so the preview follows the editor. */
  subject: z.string().max(200).optional(),
  htmlBody: z.string().max(100_000).optional(),
});

export const sendTestInput = z.object({
  campaignId: uuid,
  /** Any well-formed address here; `sendTest` then requires an active admin's email. */
  toEmail: address,
  recipient: recipientKeySchema.optional(),
});

export const campaignIdInput = z.object({ campaignId: uuid });

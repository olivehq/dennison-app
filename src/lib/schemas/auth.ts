import { z } from "zod";
import { emailSchema } from "./roster";

/** Shown when a new password is in Have I Been Pwned's breach list (D189). */
export const BREACHED_PASSWORD_MESSAGE = "This password appears in a known data breach. Choose a different one.";
/** Shown when the breach check could not reach its service, so the password was refused. */
export const BREACH_CHECK_UNAVAILABLE_MESSAGE =
  "We couldn't check this password against known data breaches. Try again in a minute.";
/** Better Auth's message prefix for that failure, which carries no code. */
export const BREACH_CHECK_FAILED_PREFIX = "Failed to check password";

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Use at most 128 characters.");

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const adminInviteSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, "Enter the person's name.").max(120),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1, "Enter your name.").max(120),
  password: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type AdminInviteInput = z.infer<typeof adminInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const profileNameSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(120, "Use at most 120 characters."),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(128, "Use at most 128 characters."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
    revokeOtherSessions: z.boolean(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "The two passwords don't match.",
    path: ["confirmPassword"],
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    message: "Choose a password that's different from the current one.",
    path: ["newPassword"],
  });

export type ProfileNameInput = z.infer<typeof profileNameSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

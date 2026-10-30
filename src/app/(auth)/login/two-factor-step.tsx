"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { AuthFeedbackAlert, AuthSubmitButton, type useAuthFeedback } from "../auth-feedback";
import { normalizeBackupCode, normalizeTotpCode } from "./two-factor-codes";

type Method = "totp" | "backup";

const totpSchema = z.object({
  code: z.string().refine((value) => normalizeTotpCode(value) !== null, "Enter the 6-digit code from your authenticator app."),
});
const backupSchema = z.object({
  code: z.string().refine((value) => normalizeBackupCode(value) !== null, "Enter one of your backup codes, like abcde-12345."),
});

type CodeInput = { code: string };

const COPY: Record<Method, { label: string; description: string; switchTo: string }> = {
  totp: {
    label: "Authentication code",
    description: "Open your authenticator app and enter the 6-digit code for AW appointment matching.",
    switchTo: "Use a backup code instead",
  },
  backup: {
    label: "Backup code",
    description: "Enter one of the backup codes you saved when you turned on two-factor sign-in. Each works once.",
    switchTo: "Use your authenticator app instead",
  },
};

/**
 * The second sign-in step. Better Auth holds the pending sign-in in a signed
 * cookie for 10 minutes and allows 5 wrong codes; after either, the form goes
 * back to email and password with a message.
 */
export function TwoFactorStep({
  feedback: { feedback, waitSeconds, run, clear },
  onSignedIn,
  onRestart,
}: {
  feedback: ReturnType<typeof useAuthFeedback>;
  onSignedIn: () => void;
  onRestart: () => void;
}) {
  const [method, setMethod] = React.useState<Method>("totp");
  const copy = COPY[method];
  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<CodeInput>({
    resolver: zodResolver(method === "totp" ? totpSchema : backupSchema),
    defaultValues: { code: "" },
  });

  const codeInvalid = !!errors.code || feedback?.kind === "error";

  React.useEffect(() => {
    if (feedback?.kind === "error" && !isSubmitting) setFocus("code", { shouldSelect: true });
  }, [feedback, isSubmitting, setFocus]);

  const onSubmit = async ({ code }: CodeInput) => {
    const failed = await run(
      (fetchOptions) =>
        method === "totp"
          ? authClient.twoFactor.verifyTotp({ code: normalizeTotpCode(code)!, fetchOptions })
          : authClient.twoFactor.verifyBackupCode({ code: normalizeBackupCode(code)!, fetchOptions }),
      "The code could not be checked. Try again in a moment.",
    );
    if (!failed) onSignedIn();
    else if (failed.kind === "restart") onRestart();
  };

  const switchMethod = () => {
    clear();
    reset({ code: "" });
    setMethod((current) => (current === "totp" ? "backup" : "totp"));
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <fieldset disabled={isSubmitting} className="min-w-0">
        <FieldGroup>
          <AuthFeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
          <Field data-invalid={codeInvalid}>
            <FieldLabel htmlFor="two-factor-code">{copy.label}</FieldLabel>
            <Input
              key={method}
              id="two-factor-code"
              autoComplete="one-time-code"
              inputMode={method === "totp" ? "numeric" : "text"}
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              aria-invalid={codeInvalid}
              aria-describedby="two-factor-code-description"
              className={method === "totp" ? "font-mono tracking-[0.3em]" : "font-mono"}
              {...register("code")}
            />
            <FieldDescription id="two-factor-code-description">{copy.description}</FieldDescription>
            <FieldError errors={[errors.code]} />
          </Field>
          <AuthSubmitButton pending={isSubmitting} pendingLabel="Verifying" waitSeconds={waitSeconds}>
            Verify
          </AuthSubmitButton>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="link" className="h-auto px-0" onClick={switchMethod}>
              {copy.switchTo}
            </Button>
            <Button
              type="button"
              variant="link"
              className="h-auto px-0 text-muted-foreground"
              onClick={() => {
                clear();
                onRestart();
              }}
            >
              Back to sign in
            </Button>
          </div>
        </FieldGroup>
      </fieldset>
    </form>
  );
}

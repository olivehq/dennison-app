"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheckIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/schemas/auth";
import { AuthFeedbackAlert, AuthSubmitButton, useAuthFeedback } from "../auth-feedback";

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const { feedback, waitSeconds, run, clear } = useAuthFeedback();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: ForgotPasswordInput) => {
    const failed = await run(
      (fetchOptions) => authClient.requestPasswordReset({ email: values.email, redirectTo: "/reset-password", fetchOptions }),
      "",
    );
    if (failed?.kind === "rate-limited" || failed?.kind === "network") return;
    // Any other answer gets the same message, so the form never reveals which emails have accounts
    // (a failed reset email, for example, only happens for an address that has one).
    clear();
    setSentTo(values.email);
  };

  if (sentTo !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <MailCheckIcon />
          <AlertTitle>Check your inbox</AlertTitle>
          <AlertDescription>
            If <span className="font-medium text-foreground">{sentTo}</span> has an account, a reset link is on its
            way. It can take a minute.
          </AlertDescription>
        </Alert>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            reset({ email: "" });
            setSentTo(null);
          }}
        >
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <fieldset disabled={isSubmitting} className="min-w-0">
        <FieldGroup>
          <AuthFeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
          <Field data-invalid={!!errors.email}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              aria-invalid={!!errors.email}
              {...register("email")}
            />
            <FieldError errors={[errors.email]} />
          </Field>
          <AuthSubmitButton pending={isSubmitting} pendingLabel="Sending" waitSeconds={waitSeconds}>
            Send reset link
          </AuthSubmitButton>
        </FieldGroup>
      </fieldset>
    </form>
  );
}

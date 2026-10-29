"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { authClient } from "@/lib/auth-client";
import { loginSchema, type LoginInput } from "@/lib/schemas/auth";
import { AuthFeedbackAlert, AuthNotice, AuthSubmitButton, useAuthFeedback } from "../auth-feedback";

export function LoginForm({ next, sessionEnded }: { next: string; sessionEnded: boolean }) {
  const router = useRouter();
  const { feedback, waitSeconds, run } = useAuthFeedback();
  const [showPassword, setShowPassword] = React.useState(false);
  const [capsLock, setCapsLock] = React.useState(false);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const credentialsInvalid = feedback?.kind === "invalid-credentials";
  const emailInvalid = !!errors.email || credentialsInvalid;
  const passwordInvalid = !!errors.password || credentialsInvalid;

  // The fieldset is disabled while the request runs, so focus can only move once it is enabled again.
  React.useEffect(() => {
    if (credentialsInvalid && !isSubmitting) setFocus("password", { shouldSelect: true });
  }, [credentialsInvalid, isSubmitting, setFocus]);

  const onSubmit = async (values: LoginInput) => {
    const failed = await run(
      (fetchOptions) => authClient.signIn.email({ email: values.email, password: values.password, fetchOptions }),
      "Sign-in failed. Try again in a moment.",
    );
    if (failed) return;
    router.push(next);
    router.refresh();
  };

  const trackCapsLock = (event: React.KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState("CapsLock"));

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <fieldset disabled={isSubmitting} className="min-w-0">
        <FieldGroup>
          {feedback ? (
            <AuthFeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
          ) : sessionEnded ? (
            <AuthNotice>Your session ended. Sign in to continue.</AuthNotice>
          ) : null}
          <Field data-invalid={emailInvalid}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              aria-invalid={emailInvalid}
              {...register("email")}
            />
            <FieldError errors={[errors.email]} />
          </Field>
          <Field data-invalid={passwordInvalid}>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Link
                href="/forgot-password"
                className="rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Forgot password?
              </Link>
            </div>
            <InputGroup>
              <InputGroupInput
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                aria-invalid={passwordInvalid}
                aria-describedby={capsLock ? "password-caps-lock" : undefined}
                onKeyDown={trackCapsLock}
                onKeyUp={trackCapsLock}
                {...register("password")}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((shown) => !shown)}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  <span className="sr-only">Show password</span>
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {capsLock ? <FieldDescription id="password-caps-lock">Caps Lock is on.</FieldDescription> : null}
            <FieldError errors={[errors.password]} />
          </Field>
          <AuthSubmitButton pending={isSubmitting} pendingLabel="Signing in" waitSeconds={waitSeconds}>
            Sign in
          </AuthSubmitButton>
        </FieldGroup>
      </fieldset>
    </form>
  );
}

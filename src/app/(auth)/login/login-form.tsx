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
import { TwoFactorStep } from "./two-factor-step";

/**
 * Email and password, then, for an admin with two-factor sign-in on, a code
 * from their authenticator app or a backup code. Both steps go to `next`,
 * which the page has already made a safe same-site path.
 */
export function LoginForm({ next, sessionEnded }: { next: string; sessionEnded: boolean }) {
  const router = useRouter();
  const authFeedback = useAuthFeedback();
  const { feedback, waitSeconds, run } = authFeedback;
  const [step, setStep] = React.useState<"password" | "two-factor">("password");
  const [showPassword, setShowPassword] = React.useState(false);
  const [capsLock, setCapsLock] = React.useState(false);
  const {
    register,
    handleSubmit,
    setFocus,
    resetField,
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

  const finish = React.useCallback(() => {
    router.push(next);
    router.refresh();
  }, [next, router]);

  const onSubmit = async (values: LoginInput) => {
    let needsCode = false;
    const failed = await run(async (fetchOptions) => {
      const result = await authClient.signIn.email({ email: values.email, password: values.password, fetchOptions });
      needsCode = !!result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect === true;
      return result;
    }, "Sign-in failed. Try again in a moment.");
    if (failed) return;
    if (needsCode) {
      setStep("two-factor");
      return;
    }
    finish();
  };

  if (step === "two-factor") {
    return (
      <TwoFactorStep
        feedback={authFeedback}
        onSignedIn={finish}
        onRestart={() => {
          setStep("password");
          resetField("password");
        }}
      />
    );
  }

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

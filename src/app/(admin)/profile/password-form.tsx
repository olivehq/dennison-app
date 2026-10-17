"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/schemas/auth";
import { changePassword } from "@/server/auth/actions";

const EMPTY: ChangePasswordInput = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
  revokeOtherSessions: true,
};

const FIELDS = ["currentPassword", "newPassword", "confirmPassword"] as const;

export function PasswordForm({ email }: { email: string }) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: EMPTY,
  });

  const onSubmit = async (values: ChangePasswordInput) => {
    const result = await changePassword(values);
    if (!result.ok) {
      const fieldErrors = result.error.fieldErrors ?? {};
      const fields = FIELDS.filter((key) => fieldErrors[key]?.length);
      fields.forEach((key, i) => setError(key, { message: fieldErrors[key][0] }, { shouldFocus: i === 0 }));
      if (!fields.length) toast.error(result.error.message);
      return;
    }
    reset(EMPTY);
    toast.success(
      result.data.otherSessionsSignedOut
        ? "Password changed. Your other sessions are signed out."
        : "Password changed.",
    );
    // Picks up the new session list (see changePassword).
    router.refresh();
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          {/* Lets password managers file the new password under the right account. */}
          <input type="email" name="username" autoComplete="username" value={email} hidden readOnly />
          <FieldGroup>
            <Field data-invalid={!!errors.currentPassword}>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!errors.currentPassword}
                {...register("currentPassword")}
              />
              <FieldError errors={[errors.currentPassword]} />
            </Field>
            <Field data-invalid={!!errors.newPassword}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.newPassword}
                {...register("newPassword")}
              />
              <FieldError errors={[errors.newPassword]} />
            </Field>
            <Field data-invalid={!!errors.confirmPassword}>
              <FieldLabel htmlFor="confirm-password">New password again</FieldLabel>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.confirmPassword}
                {...register("confirmPassword")}
              />
              <FieldError errors={[errors.confirmPassword]} />
            </Field>
            <Controller
              control={control}
              name="revokeOtherSessions"
              render={({ field }) => (
                <Field orientation="horizontal" data-disabled={isSubmitting}>
                  <Checkbox
                    id="revoke-other-sessions"
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                    onBlur={field.onBlur}
                    disabled={isSubmitting}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="revoke-other-sessions">Sign out other sessions</FieldLabel>
                    <FieldDescription>Other browsers and devices will need the new password.</FieldDescription>
                  </FieldContent>
                </Field>
              )}
            />
            <div>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                Change password
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

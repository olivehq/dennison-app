"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { passwordSchema } from "@/lib/schemas/auth";
import { AuthFeedbackAlert, AuthSubmitButton, useAuthFeedback } from "../auth-feedback";

const formSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((values) => values.password === values.confirm, {
    message: "The two passwords don't match.",
    path: ["confirm"],
  });

type FormValues = z.infer<typeof formSchema>;

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const { feedback, waitSeconds, run } = useAuthFeedback();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: "", confirm: "" },
  });

  const onSubmit = async (values: FormValues) => {
    const failed = await run(
      (fetchOptions) => authClient.resetPassword({ newPassword: values.password, token, fetchOptions }),
      "The password could not be changed. Try again.",
    );
    if (failed) return;
    toast.success("Password changed. Sign in with the new one.");
    router.push("/login");
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <fieldset disabled={isSubmitting} className="min-w-0">
        <FieldGroup>
          <AuthFeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
          <Field data-invalid={!!errors.password}>
            <FieldLabel htmlFor="password">New password</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              aria-invalid={!!errors.password}
              {...register("password")}
            />
            <FieldError errors={[errors.password]} />
          </Field>
          <Field data-invalid={!!errors.confirm}>
            <FieldLabel htmlFor="confirm">New password again</FieldLabel>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirm}
              {...register("confirm")}
            />
            <FieldError errors={[errors.confirm]} />
          </Field>
          <AuthSubmitButton pending={isSubmitting} pendingLabel="Changing password" waitSeconds={waitSeconds}>
            Change password
          </AuthSubmitButton>
        </FieldGroup>
      </fieldset>
    </form>
  );
}

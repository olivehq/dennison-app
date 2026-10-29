"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { acceptInviteSchema } from "@/lib/schemas/auth";
import { AuthFeedbackAlert, AuthSubmitButton, useAuthFeedback } from "../../auth-feedback";

const formSchema = acceptInviteSchema
  .omit({ token: true })
  .extend({ confirm: z.string() })
  .refine((values) => values.password === values.confirm, {
    message: "The two passwords don't match.",
    path: ["confirm"],
  });

type FormValues = z.infer<typeof formSchema>;

export function AcceptInviteForm({ token, email, name }: { token: string; email: string; name: string }) {
  const router = useRouter();
  const { feedback, waitSeconds, run } = useAuthFeedback();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name, password: "", confirm: "" },
  });

  const onSubmit = async (values: FormValues) => {
    const failed = await run((fetchOptions) => {
      // The sign-up hook in src/server/auth/auth.ts requires `inviteToken`. Better
      // Auth passes extra body keys through untyped, hence the plain object.
      const body = { email, name: values.name, password: values.password, inviteToken: token, fetchOptions };
      return authClient.signUp.email(body);
    }, "The account could not be created. Try again.");
    if (failed) return;
    router.push("/events");
    router.refresh();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <fieldset disabled={isSubmitting} className="min-w-0">
        <FieldGroup>
          <AuthFeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" type="email" value={email} readOnly />
            <FieldDescription>Set by the invitation. You will sign in with it.</FieldDescription>
          </Field>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...register("name")} />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.password}>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              {...register("password")}
            />
            <FieldDescription>At least 10 characters.</FieldDescription>
            <FieldError errors={[errors.password]} />
          </Field>
          <Field data-invalid={!!errors.confirm}>
            <FieldLabel htmlFor="confirm">Password again</FieldLabel>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirm}
              {...register("confirm")}
            />
            <FieldError errors={[errors.confirm]} />
          </Field>
          <AuthSubmitButton pending={isSubmitting} pendingLabel="Creating account" waitSeconds={waitSeconds}>
            Create account
          </AuthSubmitButton>
        </FieldGroup>
      </fieldset>
    </form>
  );
}

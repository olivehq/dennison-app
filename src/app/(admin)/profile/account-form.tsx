"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { profileNameSchema, type ProfileNameInput } from "@/lib/schemas/auth";
import { updateProfileName } from "@/server/auth/actions";

export function AccountForm({ name, email }: { name: string; email: string }) {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ProfileNameInput>({
    resolver: zodResolver(profileNameSchema),
    values: { name },
  });

  const onSubmit = async (values: ProfileNameInput) => {
    const result = await updateProfileName(values);
    if (!result.ok) {
      const message = result.error.fieldErrors?.name?.[0];
      if (message) setError("name", { message });
      else toast.error(result.error.message);
      return;
    }
    reset({ name: result.data.name });
    toast.success("Name saved.");
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="profile-name">Name</FieldLabel>
              <Input
                id="profile-name"
                autoComplete="name"
                aria-invalid={!!errors.name}
                {...register("name")}
              />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-email">Email</FieldLabel>
              <Input id="profile-email" value={email} readOnly className="bg-muted text-muted-foreground" />
              <FieldDescription>
                Sign-in is invite-only, so changing your address takes a new invite from another admin.
              </FieldDescription>
            </Field>
            <div>
              <Button type="submit" disabled={isSubmitting || !isDirty}>
                {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                Save
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

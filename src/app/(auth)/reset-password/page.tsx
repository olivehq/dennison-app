import Link from "next/link";
import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CardContent } from "@/components/ui/card";
import { AuthHeader, BackToSignIn } from "../auth-shell";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  const usable = Boolean(token) && !error;

  return (
    <>
      <AuthHeader
        title="Choose a new password"
        description="At least 10 characters. You will be signed out everywhere else."
      />
      <CardContent className="flex flex-col gap-4">
        {usable && token ? (
          <ResetPasswordForm token={token} />
        ) : (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>This reset link doesn&apos;t work</AlertTitle>
            <AlertDescription>
              It has expired, was already used, or is incomplete. <Link href="/forgot-password">Request a new link.</Link>
            </AlertDescription>
          </Alert>
        )}
        <BackToSignIn />
      </CardContent>
    </>
  );
}

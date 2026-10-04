import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>At least 10 characters. You will be signed out everywhere else.</CardDescription>
      </CardHeader>
      <CardContent>
        {usable && token ? (
          <ResetPasswordForm token={token} />
        ) : (
          <Alert variant="destructive">
            <AlertTitle>This reset link doesn&apos;t work</AlertTitle>
            <AlertDescription>
              It has expired, was already used, or is incomplete. Request a new one from the sign-in page.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="justify-center">
        <Button variant="link" asChild>
          <Link href={usable ? "/login" : "/forgot-password"}>{usable ? "Back to sign in" : "Request a new link"}</Link>
        </Button>
      </CardFooter>
    </>
  );
}

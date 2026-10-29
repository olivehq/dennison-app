import { CardContent } from "@/components/ui/card";
import { AuthHeader, BackToSignIn } from "../auth-shell";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthHeader title="Reset your password" description="We'll email a link that works for one hour." />
      <CardContent className="flex flex-col gap-4">
        <ForgotPasswordForm />
        <BackToSignIn />
      </CardContent>
    </>
  );
}

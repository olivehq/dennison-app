import { redirect } from "next/navigation";
import { CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getSession } from "@/server/auth/session";
import { safeNextPath } from "../auth-errors";
import { AuthHeader } from "../auth-shell";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const next = safeNextPath(params.next);
  if (session) redirect(next);
  // requireSession sends an ended session here with the page it was on; plain /events is also a first visit.
  const sessionEnded = params.next !== undefined && next !== "/events";

  return (
    <>
      <AuthHeader
        title="Sign in"
        description="For Dennison & Associates staff. Use the email your invite went to."
      />
      <CardContent className="flex flex-col gap-6">
        <LoginForm next={next} sessionEnded={sessionEnded} />
        <Separator />
        <p className="text-xs text-muted-foreground">
          Looking for your appointment schedule? Open the link in the email Dennison &amp; Associates sent you.
        </p>
      </CardContent>
    </>
  );
}

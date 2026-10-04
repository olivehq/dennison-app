import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getInviteByToken } from "@/server/auth/queries";
import { AcceptInviteForm } from "./accept-invite-form";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getInviteByToken(token);

  if (!invite) {
    return (
      <>
        <CardHeader>
          <CardTitle>This invite link doesn&apos;t work</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTitle>Invalid or expired</AlertTitle>
            <AlertDescription>
              Invite links work for 7 days and only once. Ask a colleague to send a new one from the Team page.
            </AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter className="justify-center">
          <Button variant="link" asChild>
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardFooter>
      </>
    );
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Create your admin account</CardTitle>
        <CardDescription>Set a password to finish accepting the invitation for {invite.email}.</CardDescription>
      </CardHeader>
      <CardContent>
        <AcceptInviteForm token={token} email={invite.email} name={invite.name} />
      </CardContent>
    </>
  );
}

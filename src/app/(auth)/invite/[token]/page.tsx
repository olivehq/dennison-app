import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CardContent } from "@/components/ui/card";
import { getInviteByToken } from "@/server/auth/queries";
import { AuthHeader, BackToSignIn } from "../../auth-shell";
import { AcceptInviteForm } from "./accept-invite-form";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getInviteByToken(token);

  if (!invite) {
    return (
      <>
        <AuthHeader title="This invite link doesn't work" />
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Invalid or expired</AlertTitle>
            <AlertDescription>
              Invite links work for 7 days and only once. Ask a colleague to send a new one from the Team page.
            </AlertDescription>
          </Alert>
          <BackToSignIn />
        </CardContent>
      </>
    );
  }

  return (
    <>
      <AuthHeader
        title="Create your admin account"
        description={`Set a password to finish accepting the invitation for ${invite.email}.`}
      />
      <CardContent className="flex flex-col gap-4">
        <AcceptInviteForm token={token} email={invite.email} name={invite.name} />
        <BackToSignIn />
      </CardContent>
    </>
  );
}

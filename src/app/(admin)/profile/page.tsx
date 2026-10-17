import { PageHeader } from "@/components/app/page-header";
import { listAdminSessions } from "@/server/auth/queries";
import { requireSession } from "@/server/auth/session";
import { AccountForm } from "./account-form";
import { AppearanceCard } from "./appearance-card";
import { PasswordForm } from "./password-form";
import { ProfileSection } from "./profile-section";
import { SessionsCard } from "./sessions-card";

export default async function ProfilePage() {
  const { user, session } = await requireSession();
  const sessions = await listAdminSessions({ adminId: user.id, currentSessionId: session.id });
  const hasOtherSessions = sessions.some((s) => !s.current);

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <PageHeader title="Your profile" />
      <div className="flex flex-col gap-8">
        <ProfileSection id="account-title" title="Account">
          <AccountForm name={user.name} email={user.email} />
        </ProfileSection>
        <ProfileSection
          id="appearance-title"
          title="Appearance"
          description="System follows your device's light or dark setting. Saved in this browser."
        >
          <AppearanceCard />
        </ProfileSection>
        <ProfileSection id="password-title" title="Password" description="Use at least 10 characters.">
          <PasswordForm email={user.email} />
        </ProfileSection>
        <ProfileSection
          id="sessions-title"
          title="Where you're signed in"
          description={
            hasOtherSessions
              ? "Sign out anywhere you don't recognize, or a shared computer you've finished with."
              : "Only in this browser."
          }
        >
          <SessionsCard sessions={sessions} />
        </ProfileSection>
      </div>
    </div>
  );
}

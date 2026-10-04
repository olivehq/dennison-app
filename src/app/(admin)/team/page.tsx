import { PageHeader } from "@/components/app/page-header";
import { listAdmins } from "@/server/auth/queries";
import { requireSession } from "@/server/auth/session";
import { InviteAdminDialog } from "./invite-admin-dialog";
import { TeamTable, type TeamRow } from "./team-table";

export default async function TeamPage() {
  const [{ user }, { admins, invites }] = await Promise.all([requireSession(), listAdmins()]);

  const rows: TeamRow[] = [
    ...admins.map<TeamRow>((admin) => ({
      id: admin.id,
      kind: "admin",
      name: admin.name,
      email: admin.email,
      state: admin.disabledAt ? "disabled" : "active",
      expiresAt: null,
      expired: false,
      isSelf: admin.id === user.id,
    })),
    ...invites.map<TeamRow>((invite) => ({
      id: invite.id,
      kind: "invite",
      name: invite.name,
      email: invite.email,
      state: "invited",
      expiresAt: invite.expiresAt,
      expired: invite.expired,
      isSelf: false,
    })),
  ];

  return (
    <>
      <PageHeader
        title="Team"
        description="Everyone here has the same access. Disabling an account signs that person out everywhere."
        actions={<InviteAdminDialog />}
      />
      <TeamTable rows={rows} />
    </>
  );
}

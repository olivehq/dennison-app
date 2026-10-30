"use client";

import * as React from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { signOutSessions } from "@/server/auth/actions";
import type { AdminSessionItem } from "@/server/auth/queries";
import { useIsClient } from "./use-is-client";


function When({ label, at }: { label: string; at: Date }) {
  return (
    <span>
      {label} <time dateTime={at.toISOString()}>{format(at, "MMM d, yyyy, h:mm:ss a OOOO")}</time>
    </span>
  );
}

/** Times show in the viewer's own timezone, which only the browser knows, so the server renders none. */
function SessionTimes({ session }: { session: AdminSessionItem }) {
  const isClient = useIsClient();
  if (!isClient) return <span aria-hidden="true">&nbsp;</span>;
  return (
    <>
      <When label="Last active" at={session.lastActiveAt} />
      <When label="Signed in" at={session.signedInAt} />
    </>
  );
}

export function SessionsCard({ sessions }: { sessions: AdminSessionItem[] }) {
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const others = sessions.filter((s) => !s.current).length;

  const signOutOne = async (session: AdminSessionItem) => {
    setPendingId(session.id);
    try {
      const result = await signOutSessions(session.id);
      if (result.ok) toast.success(`Signed out ${session.device}.`);
      else toast.error(result.error.message);
    } finally {
      setPendingId(null);
    }
  };

  const signOutOthers = async () => {
    const result = await signOutSessions();
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(
      result.data.count === 1 ? "Signed out 1 other session." : `Signed out ${result.data.count} other sessions.`,
    );
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y rounded-lg border">
          {sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{session.device}</span>
                  {session.current ? <Badge variant="secondary">This session</Badge> : null}
                </div>
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                  <SessionTimes session={session} />
                  <span>IP address: {session.ipAddress ?? "Not recorded"}</span>
                </div>
              </div>
              {session.current ? null : (
                <ConfirmDialog
                  title="Sign out this session?"
                  description="That browser will need to sign in again."
                  confirmLabel="Sign out"
                  onConfirm={() => signOutOne(session)}
                  trigger={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pendingId !== null}
                      aria-label={`Sign out ${session.device}`}
                    >
                      {pendingId === session.id ? <Spinner data-icon="inline-start" /> : null}
                      Sign out
                    </Button>
                  }
                />
              )}
            </li>
          ))}
        </ul>
        {others > 0 ? (
          <div>
            <ConfirmDialog
              title="Sign out other sessions?"
              description={`This signs you out of ${others === 1 ? "1 other session" : `${others} other sessions`}. This browser stays signed in.`}
              confirmLabel="Sign out other sessions"
              onConfirm={signOutOthers}
              trigger={<Button variant="outline">Sign out other sessions</Button>}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

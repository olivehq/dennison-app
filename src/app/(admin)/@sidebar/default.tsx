import { cookies } from "next/headers";
import { LAST_EVENT_COOKIE } from "../events/[id]/event-sections";
import { EventSidebar } from "./event-sidebar";

/** Pages outside an event (Events, Team, Profile) keep the last event the admin opened. */
export default async function WorkspaceSidebar() {
  const lastEventId = (await cookies()).get(LAST_EVENT_COOKIE)?.value;
  return <EventSidebar eventId={lastEventId} />;
}

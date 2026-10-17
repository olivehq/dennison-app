import { EventSidebar } from "../../event-sidebar";

/**
 * The sidebar inside an event. A slot page renders again on every navigation
 * and after each action's revalidatePath, so the counts stay current (the
 * (admin) layout does not).
 */
export default async function EventSidebarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventSidebar eventId={id} />;
}

import { cookies } from "next/headers";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { requireSession } from "@/server/auth/session";
import { SidebarUserProvider } from "./app-sidebar";
import { SessionKeepAlive } from "./session-keep-alive";

/**
 * `sidebar` is a parallel route slot (`@sidebar`): its event pages load the
 * event switcher and counts for the URL's event, and `default.tsx` covers
 * every other page. The account menu's user comes from here, so the
 * sidebar's error state can show it too.
 */
export default async function AdminLayout({ children, sidebar }: { children: React.ReactNode; sidebar: React.ReactNode }) {
  const [{ user }, cookieStore] = await Promise.all([requireSession(), cookies()]);
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <SessionKeepAlive />
      <SidebarUserProvider user={{ name: user.name, email: user.email }}>{sidebar}</SidebarUserProvider>
      <SidebarInset className="min-w-0">
        <div className="flex h-12 items-center justify-between gap-2 border-b px-3 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <span className="font-display text-sm font-bold">AW appointment matching</span>
          </div>
          <ThemeToggle />
        </div>
        <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

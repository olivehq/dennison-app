import { cookies } from "next/headers";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { requireSession } from "@/server/auth/session";
import { AppSidebar } from "./app-sidebar";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const [{ user }, cookieStore] = await Promise.all([requireSession(), cookies()]);
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar user={{ name: user.name, email: user.email }} />
      <SidebarInset>
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

"use client";

import * as Sentry from "@sentry/nextjs";
import { cn } from "cn";
import {
  CalendarDaysIcon,
  CalendarIcon,
  ChevronsUpDownIcon,
  EllipsisVerticalIcon,
  LogOutIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { catchError, type ErrorInfo } from "next/error";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";
import { initials } from "@/lib/names";
import type { EventStatus } from "@/lib/schemas/event";
import type { EventNavCounts } from "@/server/events/nav-counts";
import { EventStatusBadge } from "./events/event-status-badge";
import {
  EVENT_SECTION_GROUPS,
  eventSectionHref,
  LAST_EVENT_COOKIE,
  sectionForPath,
  type EventSection,
} from "./events/[id]/event-sections";

export type SidebarEventSummary = { id: string; name: string; dateLabel: string; status: EventStatus };

/**
 * The event the URL is in (or the last one opened), the other events for the
 * switcher, and the live counts. The counts stream in after the links, so a
 * navigation never waits for them; null when the event is gone.
 */
export type SidebarEvent = {
  current: SidebarEventSummary;
  others: SidebarEventSummary[];
  counts: Promise<EventNavCounts | null>;
};

type SidebarUser = { name: string; email: string };

const SidebarUserContext = React.createContext<SidebarUser | null>(null);

type NavCount = { text: string; problem: boolean; srLabel?: string };

function countFor(segment: EventSection, counts: EventNavCounts): NavCount | null {
  switch (segment) {
    case "participants":
      return { text: String(counts.participants), problem: false };
    case "suppliers":
      return { text: String(counts.suppliers), problem: false };
    case "imports":
      return counts.importsWaiting > 0 ? { text: `${counts.importsWaiting} waiting`, problem: true } : null;
    case "schedule":
      return counts.scheduleProblems
        ? { text: String(counts.scheduleProblems), problem: true, srLabel: " with count problems" }
        : null;
    default:
      return null;
  }
}

const LAST_EVENT_MAX_AGE = 60 * 60 * 24 * 365;

// Approved shell (decision 1): the active row gets the muted fill plus a 2px primary bar on its inside edge.
const ACTIVE_ROW = "data-active:font-semibold data-active:shadow-[inset_2px_0_0_var(--color-sidebar-primary)]";

// Collapsed to the icon rail, group labels slide up by their own height (shadcn assumes h-8)
// and fade out. They then sit over the row above, so they must not take its clicks.
const GROUP_LABEL = "h-6 group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:-mt-6";

// Hides text that only fits the full sidebar.
const EXPANDED_ONLY = "group-data-[collapsible=icon]:hidden";

/**
 * Labels belong only on the collapsed desktop rail. Elsewhere a mounted tooltip
 * opens (hidden) on focus and takes the first Escape meant for the mobile sheet.
 */
function useRailCollapsed(): boolean {
  const { state, isMobile } = useSidebar();
  return state === "collapsed" && !isMobile;
}

/** `SidebarMenuButton tooltip` for a dropdown trigger: wrap the trigger in a `TooltipTrigger` inside this. */
function RailTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const collapsed = useRailCollapsed();
  const [open, setOpen] = React.useState(false);
  return (
    <Tooltip open={collapsed && open} onOpenChange={setOpen}>
      {children}
      <TooltipContent side="right" align="center">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

type NavLinkProps = {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  count?: NavCount | null;
  onNavigate: () => void;
};

function NavLink({ href, label, icon: Icon, active, count, onNavigate }: NavLinkProps) {
  const collapsed = useRailCollapsed();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        className={ACTIVE_ROW}
        tooltip={collapsed ? (count ? `${label}, ${count.text}${count.srLabel ?? ""}` : label) : undefined}
      >
        <Link href={href} aria-current={active ? "page" : undefined} onClick={onNavigate}>
          <Icon aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count ? (
            <span
              className={cn(
                "shrink-0 text-xs tabular-nums",
                EXPANDED_ONLY,
                count.problem ? "font-semibold text-destructive" : "text-muted-foreground",
              )}
            >
              {count.text}
              {count.srLabel ? <span className="sr-only">{count.srLabel}</span> : null}
            </span>
          ) : null}
        </Link>
      </SidebarMenuButton>
      {count?.problem ? (
        <span
          className="pointer-events-none absolute top-1 left-6 hidden size-1.5 rounded-full bg-destructive group-data-[collapsible=icon]:block"
          aria-hidden="true"
        />
      ) : null}
    </SidebarMenuItem>
  );
}

/** A section link once the streamed counts arrive. Its Suspense fallback is the same link without a count. */
function CountedNavLink({
  counts,
  segment,
  ...link
}: Omit<NavLinkProps, "count"> & { counts: Promise<EventNavCounts | null>; segment: EventSection }) {
  const resolved = React.use(counts);
  return <NavLink {...link} count={resolved ? countFor(segment, resolved) : null} />;
}

function EventSwitcher({ event, onNavigate }: { event: SidebarEvent; onNavigate: () => void }) {
  const { current, others } = event;
  return (
    <DropdownMenu>
      <RailTooltip label={current.name}>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="h-auto border py-2 data-open:bg-sidebar-accent group-data-[collapsible=icon]:justify-center"
              aria-label={`${current.name}, ${current.dateLabel}. Switch event`}
            >
              <span
                className="hidden text-xs font-bold group-data-[collapsible=icon]:inline"
                aria-hidden="true"
              >
                {initials(current.name)}
              </span>
              <span className={cn("flex min-w-0 flex-1 flex-col gap-1", EXPANDED_ONLY)}>
                <span className="truncate font-semibold">{current.name}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {current.dateLabel}
                  <EventStatusBadge status={current.status} />
                </span>
              </span>
              <ChevronsUpDownIcon className={cn("text-muted-foreground", EXPANDED_ONLY)} aria-hidden="true" />
            </SidebarMenuButton>
          </TooltipTrigger>
        </DropdownMenuTrigger>
      </RailTooltip>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Switch event</DropdownMenuLabel>
        {others.length === 0 ? (
          <DropdownMenuItem disabled>No other events</DropdownMenuItem>
        ) : (
          others.map((other) => (
            <DropdownMenuItem key={other.id} asChild>
              <Link href={eventSectionHref(other.id, "")} onClick={onNavigate} className="flex-col items-start gap-0.5">
                <span className="w-full truncate font-medium">{other.name}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {other.dateLabel}
                  <EventStatusBadge status={other.status} />
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/events" onClick={onNavigate}>
            All events
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RecentEvents({ events, onNavigate }: { events: SidebarEventSummary[]; onNavigate: () => void }) {
  const collapsed = useRailCollapsed();
  return (
    <nav aria-label="Recent events">
      <SidebarGroup className="py-0.5">
        <SidebarGroupLabel className={GROUP_LABEL}>Recent events</SidebarGroupLabel>
        <SidebarGroupContent>
          {events.length === 0 ? (
            <p className={cn("px-2 py-1 text-xs text-muted-foreground", EXPANDED_ONLY)}>
              No events yet. Create one from All events.
            </p>
          ) : (
            <SidebarMenu>
              {events.map((event) => (
                <SidebarMenuItem key={event.id}>
                  <SidebarMenuButton asChild className="h-auto items-start py-1.5" tooltip={collapsed ? event.name : undefined}>
                    <Link href={eventSectionHref(event.id, "")} onClick={onNavigate}>
                      <CalendarIcon className="mt-0.5 group-data-[collapsible=icon]:mt-0" aria-hidden="true" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-medium">{event.name}</span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {event.dateLabel}
                          <EventStatusBadge status={event.status} />
                        </span>
                      </span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </nav>
  );
}

function AccountMenu({ user, onNavigate }: { user: SidebarUser; onNavigate: () => void }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  const signOut = async () => {
    setSigningOut(true);
    const { error } = await authClient.signOut();
    if (error) {
      setSigningOut(false);
      toast.error("Sign-out failed. Try again.");
      return;
    }
    router.push("/login");
    router.refresh();
  };

  return (
    <DropdownMenu>
      <RailTooltip label={user.name}>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-open:bg-sidebar-accent group-data-[collapsible=icon]:justify-center"
              aria-label={`Account: ${user.name}`}
            >
              <Avatar size="sm">
                <AvatarFallback className="font-semibold text-foreground">{initials(user.name, user.email)}</AvatarFallback>
              </Avatar>
              <span className={cn("flex min-w-0 flex-1 flex-col", EXPANDED_ONLY)}>
                <span className="truncate font-semibold">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </span>
              <EllipsisVerticalIcon className={cn("text-muted-foreground", EXPANDED_ONLY)} aria-hidden="true" />
            </SidebarMenuButton>
          </TooltipTrigger>
        </DropdownMenuTrigger>
      </RailTooltip>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuItem asChild>
          <Link href="/profile" onClick={onNavigate}>
            <UserRoundIcon aria-hidden="true" />
            Profile
          </Link>
        </DropdownMenuItem>
        <ThemeToggle variant="menu" />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(e) => {
            e.preventDefault();
            void signOut();
          }}
        >
          {signingOut ? <Spinner /> : <LogOutIcon aria-hidden="true" />}
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar({
  event,
  recent = [],
  fallback,
}: {
  event?: SidebarEvent;
  /** Shown instead of the event when there is none to remember. */
  recent?: SidebarEventSummary[];
  /** The slot's error state: the URL's event sections without switcher or counts, and a retry. */
  fallback?: { eventId?: string; retry: () => void };
}) {
  const pathname = usePathname();
  const user = React.useContext(SidebarUserContext);
  const { setOpenMobile } = useSidebar();
  const collapsed = useRailCollapsed();
  const closeMobile = () => setOpenMobile(false);
  const eventId = event?.current.id ?? fallback?.eventId;
  // Outside the event (Team, Profile, or a soft navigation the slot doesn't match)
  // the event stays in the sidebar, but a section is active only while the URL is inside it.
  const section = eventId ? sectionForPath(pathname, eventId) : null;
  const rememberId = event?.current.id;
  const insideEvent = section !== null;

  React.useEffect(() => {
    if (!rememberId || !insideEvent) return;
    document.cookie = `${LAST_EVENT_COOKIE}=${rememberId}; path=/; max-age=${LAST_EVENT_MAX_AGE}; samesite=lax`;
  }, [rememberId, insideEvent]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3">
        {/* On the rail the logo and switcher tiles are both size-8; keep a gap between them. */}
        <SidebarMenu className="group-data-[collapsible=icon]:gap-2">
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={collapsed ? "All events" : undefined}>
              <Link href="/events" onClick={closeMobile}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary font-display text-sm font-bold text-primary-foreground">
                  AW
                </span>
                <span className="font-display text-base font-bold tracking-[-0.01em]">AW appointment matching</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {event ? (
            <SidebarMenuItem>
              <EventSwitcher event={event} onNavigate={closeMobile} />
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {fallback ? (
          <div role="alert" className={cn("flex flex-col items-start gap-2 px-4 py-2 text-xs text-muted-foreground", EXPANDED_ONLY)}>
            <p>The event list and counts didn&apos;t load.</p>
            <Button variant="outline" size="sm" onClick={() => fallback.retry()}>
              Try again
            </Button>
          </div>
        ) : null}
        {eventId ? (
          <nav aria-label="Event sections">
            {EVENT_SECTION_GROUPS.map((group) => (
              <SidebarGroup key={group.label ?? "overview"} className="py-0.5">
                {group.label ? <SidebarGroupLabel className={GROUP_LABEL}>{group.label}</SidebarGroupLabel> : null}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.sections.map((s) => {
                      const link = {
                        href: eventSectionHref(eventId, s.segment),
                        label: s.label,
                        icon: s.icon,
                        active: section?.segment === s.segment,
                        onNavigate: closeMobile,
                      };
                      return event ? (
                        <React.Suspense key={s.segment} fallback={<NavLink {...link} />}>
                          <CountedNavLink {...link} segment={s.segment} counts={event.counts} />
                        </React.Suspense>
                      ) : (
                        <NavLink key={s.segment} {...link} />
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </nav>
        ) : fallback ? null : (
          <RecentEvents events={recent} onNavigate={closeMobile} />
        )}
        <nav aria-label="Workspace">
          <SidebarGroup className="py-0.5">
            <SidebarGroupLabel className={GROUP_LABEL}>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavLink
                  href="/events"
                  label="All events"
                  icon={CalendarDaysIcon}
                  active={pathname === "/events"}
                  onNavigate={closeMobile}
                />
                <NavLink
                  href="/team"
                  label="Team"
                  icon={UsersRoundIcon}
                  active={pathname === "/team" || pathname.startsWith("/team/")}
                  onNavigate={closeMobile}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <SidebarMenu>
          {/* Collapsed to the rail, the toggle sits above the avatar. */}
          <SidebarMenuItem className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col-reverse">
            {user ? <AccountMenu user={user} onNavigate={closeMobile} /> : null}
            <SidebarTrigger className="hidden shrink-0 md:inline-flex" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Wraps the sidebar inside each `@sidebar` page, so a failed read keeps the
 * sidebar usable: the URL's event links without counts, the account menu, and
 * a retry. A slot-root error.tsx wouldn't cover `default.tsx`.
 */
export const SidebarErrorBoundary = catchError(function SidebarFallback(_props: object, { error, retry }: ErrorInfo) {
  const { id } = useParams<{ id?: string }>();
  React.useEffect(() => {
    console.error(error);
    // The boundary catches the error, so report it here (a no-op without a DSN).
    Sentry.captureException(error);
  }, [error]);
  return <AppSidebar fallback={{ eventId: id, retry }} />;
});

/** The signed-in admin for the account menu. The (admin) layout provides it, so the error state has it too. */
export function SidebarUserProvider({ user, children }: { user: SidebarUser; children: React.ReactNode }) {
  return <SidebarUserContext value={user}>{children}</SidebarUserContext>;
}

"use client";

import { cn } from "cn";
import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ThemeToggleProps = {
  /** `icon` is a small ghost button. `menu` renders a sidebar menu row and must sit inside a SidebarMenuItem. */
  variant?: "icon" | "menu";
  className?: string;
};

/** Both icons render and CSS picks one, so the server markup matches the client with no mounted flag. */
function ThemeIcons() {
  return (
    <>
      <SunIcon className="dark:hidden" aria-hidden="true" />
      <MoonIcon className="hidden dark:block" aria-hidden="true" />
    </>
  );
}

export function ThemeToggle({ variant = "icon", className }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const toggle = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");

  if (variant === "menu") {
    return (
      <SidebarMenuButton onClick={toggle} tooltip="Switch theme" className={className}>
        <ThemeIcons />
        <span>Switch theme</span>
      </SidebarMenuButton>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={toggle} className={cn(className)} aria-label="Switch theme">
          <ThemeIcons />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Switch theme</TooltipContent>
    </Tooltip>
  );
}

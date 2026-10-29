"use client";

import { cn } from "cn";
import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ThemeToggleProps = {
  /** `icon` is a small ghost button. `menu` renders a dropdown menu item and must sit inside a DropdownMenuContent. */
  variant?: "icon" | "menu";
  className?: string;
};

/** Both icons render and CSS picks one, so the server markup matches the client with no mounted flag. */
function ThemeIcons() {
  return (
    <>
      <MoonIcon className="dark:hidden" aria-hidden="true" />
      <SunIcon className="hidden dark:block" aria-hidden="true" />
    </>
  );
}

export function ThemeToggle({ variant = "icon", className }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const toggle = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");

  if (variant === "menu") {
    return (
      <DropdownMenuItem onSelect={toggle} className={className}>
        <ThemeIcons />
        <span className="dark:hidden">Use dark theme</span>
        <span className="hidden dark:inline">Use light theme</span>
      </DropdownMenuItem>
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

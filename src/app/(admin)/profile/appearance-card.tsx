"use client";

import { useTheme } from "next-themes";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsClient } from "./use-is-client";

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

export function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  // The saved choice lives in this browser's storage, so the server can't mark one.
  const isClient = useIsClient();

  return (
    <Card>
      <CardContent>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={isClient ? (theme ?? "light") : ""}
          onValueChange={(value) => value && setTheme(value)}
          aria-labelledby="appearance-title"
        >
          {THEMES.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} className="px-3 text-muted-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardContent>
    </Card>
  );
}

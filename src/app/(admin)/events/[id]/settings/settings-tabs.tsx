"use client";

import * as React from "react";
import { cn } from "cn";
import { PageHeader } from "@/components/app/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FORM_TABS, SETTINGS_TABS, type SettingsTab } from "./settings-tab";

const SettingsTabContext = React.createContext<{ tab: SettingsTab; setTab: (tab: SettingsTab) => void } | null>(null);

export function useSettingsTab() {
  const context = React.useContext(SettingsTabContext);
  if (!context) throw new Error("useSettingsTab must be used inside SettingsTabs");
  const { tab, setTab } = context;
  return { tab, setTab, isFormTab: FORM_TABS.includes(tab) };
}

/**
 * The page title and tab bar. It is not keyed, so the selected tab survives the settings form
 * remounting after a save. The tab is mirrored to `?tab=` without a navigation, so a reload or a
 * shared link opens the same tab.
 */
export function SettingsTabs({ initialTab, children }: { initialTab: SettingsTab; children: React.ReactNode }) {
  const [tab, setTabState] = React.useState(initialTab);
  const setTab = React.useCallback((next: SettingsTab) => {
    setTabState(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const value = React.useMemo(() => ({ tab, setTab }), [tab, setTab]);

  return (
    <SettingsTabContext.Provider value={value}>
      <Tabs value={tab} onValueChange={(next) => setTab(next as SettingsTab)} className="gap-6">
        <PageHeader
          title="Settings"
          description="Event details, slots, matching rules, the schedule page look, and data retention."
        />
        <TabsList variant="line" aria-label="Settings sections" className="max-w-full justify-start overflow-x-auto border-b">
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex-none px-3">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {children}
      </Tabs>
    </SettingsTabContext.Provider>
  );
}

/** One tab's content. Hidden panels stay mounted so unsaved edits and the form's inputs survive a tab switch. */
export function SettingsPanel({ value, className, children }: { value: SettingsTab; className?: string; children: React.ReactNode }) {
  return (
    <TabsContent value={value} forceMount className={cn("flex flex-col gap-6 data-[state=inactive]:hidden", className)}>
      {children}
    </TabsContent>
  );
}

"use client";

import * as React from "react";
import { XIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AUDIT_ACTION_GROUPS, isAuditActionGroup } from "@/server/audit/describe";
import type { ActivityOption, ActivityParams } from "@/server/audit/queries";
import { activityQuery, isFiltered, type ActivityFilterParams } from "./activity-view";

type OptionGroup = { value: string; items: ActivityOption[] };

const ALL = "all";

const CHIP =
  "rounded-full px-3 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90";

/** Filters live in the URL so a filtered log can be shared; each change goes back to page 1. */
export function ActivityFilters({
  params,
  people,
  admins,
}: {
  params: ActivityParams;
  people: ActivityOption[];
  admins: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();

  const groups = React.useMemo<OptionGroup[]>(
    () =>
      (["Buyers", "Suppliers"] as const)
        .map((group) => ({ value: group, items: people.filter((p) => p.group === group) }))
        .filter((g) => g.items.length > 0),
    [people],
  );
  const selectedPerson = people.find((p) => p.value === params.person) ?? null;

  // Two edits in quick succession (a paste, autofill) both arrive before the page for the first one renders.
  // Each edit builds on the last URL pushed, not on the props, which are still the old page until the
  // navigation settles. Once it has, the props are the truth again (Back, Forward, a shortcut link).
  const latest = React.useRef(params);
  React.useEffect(() => {
    if (!pending) latest.current = params;
  }, [pending, params]);

  const navigate = (changes: Partial<ActivityFilterParams>) => {
    const next = { ...latest.current, ...changes };
    latest.current = next;
    startTransition(() => router.push(`${pathname}${activityQuery(next)}`, { scroll: false }));
  };

  const filtered = isFiltered(params);

  return (
    <div className="flex flex-col gap-3" aria-busy={pending}>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={1}
        aria-label="Area"
        className="flex-wrap"
        value={params.type ?? ALL}
        onValueChange={(value) => {
          // Clicking the chip that is already on leaves it on rather than turning every chip off.
          if (!value || value === (params.type ?? ALL)) return;
          navigate({ type: isAuditActionGroup(value) ? value : undefined });
        }}
      >
        <ToggleGroupItem value={ALL} className={CHIP}>
          All
        </ToggleGroupItem>
        {Object.entries(AUDIT_ACTION_GROUPS).map(([value, group]) => (
          <ToggleGroupItem key={value} value={value} className={CHIP}>
            {group.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-full sm:w-72">
          <FieldLabel htmlFor="activity-person">Person</FieldLabel>
          <Combobox
            items={groups}
            value={selectedPerson}
            onValueChange={(value) => navigate({ person: (value as ActivityOption | null)?.value })}
            itemToStringLabel={(item: ActivityOption) => item.label}
            isItemEqualToValue={(item: ActivityOption, value: ActivityOption) => item.value === value.value}
          >
            <ComboboxInput id="activity-person" placeholder="Anyone" className="w-full" showClear={selectedPerson !== null} />
            <ComboboxContent>
              <ComboboxEmpty>No buyer or supplier matches.</ComboboxEmpty>
              <ComboboxList>
                {(group: OptionGroup) => (
                  <ComboboxGroup key={group.value} items={group.items}>
                    <ComboboxLabel>{group.value}</ComboboxLabel>
                    <ComboboxCollection>
                      {(item: ActivityOption) => (
                        <ComboboxItem key={item.value} value={item}>
                          {item.label}
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                  </ComboboxGroup>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </Field>

        <Field className="w-full sm:w-44">
          <FieldLabel htmlFor="activity-admin">Admin</FieldLabel>
          <Select value={params.admin ?? ALL} onValueChange={(value) => navigate({ admin: value === ALL ? undefined : value })}>
            <SelectTrigger id="activity-admin" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All admins</SelectItem>
                {admins.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {/* From and To wrap as one pair so "To" never sits alone on a row. */}
        <div className="flex w-full gap-3 sm:w-auto">
          <Field className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <FieldLabel htmlFor="activity-from">From</FieldLabel>
            <Input
              id="activity-from"
              type="date"
              value={params.from ?? ""}
              max={params.to}
              onChange={(e) => navigate({ from: e.target.value || undefined })}
            />
          </Field>
          <Field className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <FieldLabel htmlFor="activity-to">To</FieldLabel>
            <Input
              id="activity-to"
              type="date"
              value={params.to ?? ""}
              min={params.from}
              onChange={(e) => navigate({ to: e.target.value || undefined })}
            />
          </Field>
        </div>

        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => startTransition(() => router.push(pathname, { scroll: false }))}
            disabled={pending}
          >
            <XIcon data-icon="inline-start" />
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}

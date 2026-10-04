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
import { AUDIT_ACTION_GROUPS } from "@/server/audit/describe";
import type { ActivityOption, ActivityParams } from "@/server/audit/queries";

type OptionGroup = { value: string; items: ActivityOption[] };

const ALL = "all";

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

  const navigate = (changes: Partial<Record<"person" | "admin" | "type" | "from" | "to", string | undefined>>) => {
    const next = { ...params, ...changes };
    const query = new URLSearchParams();
    for (const key of ["person", "admin", "type", "from", "to"] as const) {
      const value = next[key];
      if (value) query.set(key, value);
    }
    const search = query.toString();
    startTransition(() => router.push(search ? `${pathname}?${search}` : pathname, { scroll: false }));
  };

  const filtered = Boolean(params.person || params.admin || params.type || params.from || params.to);

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
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

      <Field className="w-full sm:w-44">
        <FieldLabel htmlFor="activity-type">Type of change</FieldLabel>
        <Select value={params.type ?? ALL} onValueChange={(value) => navigate({ type: value === ALL ? undefined : value })}>
          <SelectTrigger id="activity-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All changes</SelectItem>
              {Object.entries(AUDIT_ACTION_GROUPS).map(([value, group]) => (
                <SelectItem key={value} value={value}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <Field className="w-[calc(50%-0.375rem)] sm:w-40">
        <FieldLabel htmlFor="activity-from">From</FieldLabel>
        <Input
          id="activity-from"
          type="date"
          value={params.from ?? ""}
          max={params.to}
          onChange={(e) => navigate({ from: e.target.value || undefined })}
        />
      </Field>
      <Field className="w-[calc(50%-0.375rem)] sm:w-40">
        <FieldLabel htmlFor="activity-to">To</FieldLabel>
        <Input
          id="activity-to"
          type="date"
          value={params.to ?? ""}
          min={params.from}
          onChange={(e) => navigate({ to: e.target.value || undefined })}
        />
      </Field>

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
  );
}

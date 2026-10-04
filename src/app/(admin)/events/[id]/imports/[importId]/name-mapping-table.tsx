"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ActionResult } from "@/lib/errors";
import type { EntityType, ImportKind, ImportState, UnknownName } from "@/lib/schemas/import";
import { saveAliasAction, saveAliasesAction } from "@/server/imports/actions";
import { plural } from "../import-labels";

export type EntityOption = { value: string; label: string; hint?: string };
type OptionGroup = { value: string; items: EntityOption[] };

type Revalidated = { importId: string; kind: ImportKind; state: ImportState }[];

const ENTITY_NOUN: Record<EntityType, { one: string; many: string }> = {
  buyer: { one: "participant", many: "participants" },
  supplier: { one: "supplier", many: "suppliers" },
};

function percent(score: number): string {
  return `${Math.round(score * 100)}% match`;
}

/** Suggestions first, labelled with their score, then everyone else on the roster. */
function groupsFor(name: UnknownName, entities: EntityOption[]): OptionGroup[] {
  const suggested = name.suggestions.map((s) => ({ value: s.entityId, label: s.name, hint: percent(s.score) }));
  const suggestedIds = new Set(suggested.map((s) => s.value));
  const groups: OptionGroup[] = [];
  if (suggested.length > 0) groups.push({ value: "Suggested", items: suggested });
  groups.push({ value: `All ${ENTITY_NOUN[name.entityType].many}`, items: entities.filter((e) => !suggestedIds.has(e.value)) });
  return groups;
}

function rowsLabel(rows: number[]): string {
  if (rows.length <= 4) return rows.join(", ");
  return `${rows.slice(0, 4).join(", ")} and ${rows.length - 4} more`;
}

/** Toasts the outcome for this import after a mapping re-validated it. */
function reportState(importId: string, revalidated: Revalidated): void {
  const mine = revalidated.find((entry) => entry.importId === importId);
  if (mine?.state === "ready") toast.success("Every name is mapped. This file is ready to apply.");
  else if (mine?.state === "needs_fixes") toast.warning("Names are mapped, but the file still has errors to fix.");
}

function MappingRow({
  eventId,
  importId,
  name,
  entities,
  disabled,
}: {
  eventId: string;
  importId: string;
  name: UnknownName;
  entities: EntityOption[];
  disabled: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<EntityOption | null>(null);
  const [pending, startTransition] = React.useTransition();
  const groups = React.useMemo(() => groupsFor(name, entities), [name, entities]);
  const noun = ENTITY_NOUN[name.entityType].one;
  const inputId = React.useId();

  const save = () => {
    if (!selected) return;
    startTransition(async () => {
      const result = await saveAliasAction({ eventId, raw: name.raw, entityType: name.entityType, entityId: selected.value });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(`Mapped “${name.raw}” to ${selected.label}.`);
      reportState(importId, result.data.imports);
      router.refresh();
    });
  };

  return (
    <TableRow>
      <TableCell className="font-medium whitespace-normal">{name.raw}</TableCell>
      <TableCell className="text-muted-foreground">
        {name.role === "ranker" ? `Ranker, a ${noun}` : `Choice, a ${noun}`}
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">{rowsLabel(name.rows)}</TableCell>
      <TableCell className="min-w-72">
        <label htmlFor={inputId} className="sr-only">
          {noun} for {name.raw}
        </label>
        <Combobox
          items={groups}
          value={selected}
          onValueChange={(value) => setSelected(value as EntityOption | null)}
          itemToStringLabel={(item: EntityOption) => item.label}
          isItemEqualToValue={(item: EntityOption, value: EntityOption) => item.value === value.value}
          disabled={disabled || pending}
        >
          <ComboboxInput id={inputId} placeholder={`Choose a ${noun}`} className="w-full" disabled={disabled || pending} />
          <ComboboxContent>
            <ComboboxEmpty>No {ENTITY_NOUN[name.entityType].many} match.</ComboboxEmpty>
            <ComboboxList>
              {(group: OptionGroup) => (
                <ComboboxGroup key={group.value} items={group.items}>
                  <ComboboxLabel>{group.value}</ComboboxLabel>
                  <ComboboxCollection>
                    {(item: EntityOption) => (
                      <ComboboxItem key={`${group.value}-${item.value}`} value={item}>
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                          <span className="truncate">{item.label}</span>
                          {item.hint ? <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span> : null}
                        </span>
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" onClick={save} disabled={!selected || disabled || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

type NameMappingTableProps = {
  eventId: string;
  importId: string;
  names: UnknownName[];
  entities: Record<EntityType, EntityOption[]>;
  lockedReason: string | null;
};

export function NameMappingTable({ eventId, importId, names, entities, lockedReason }: NameMappingTableProps) {
  const router = useRouter();
  const withSuggestion = names.filter((name) => name.suggestions.length > 0);
  const locked = lockedReason !== null;

  const saveAllSuggested = async () => {
    const result: ActionResult<{ imports: Revalidated }> = await saveAliasesAction({
      eventId,
      aliases: withSuggestion.map((name) => ({
        raw: name.raw,
        entityType: name.entityType,
        entityId: name.suggestions[0].entityId,
      })),
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(`Mapped ${plural(withSuggestion.length, "name")} to their top suggestion.`);
    reportState(importId, result.data.imports);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Pick who each name means. Saved names are remembered for this event, so next year&apos;s file maps itself.
        </p>
        {withSuggestion.length > 0 ? (
          <ConfirmDialog
            title={`Map ${plural(withSuggestion.length, "name")} to their top suggestion?`}
            description={
              <span className="flex flex-col gap-2">
                <span>Check these before you continue. You can change a mapping later by saving a different choice.</span>
                <span className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                  {withSuggestion.map((name) => (
                    <span key={`${name.entityType}-${name.raw}`}>
                      “{name.raw}” to {name.suggestions[0].name} ({percent(name.suggestions[0].score)})
                    </span>
                  ))}
                </span>
              </span>
            }
            confirmLabel="Save all suggested"
            onConfirm={saveAllSuggested}
            trigger={
              <Button variant="outline" size="sm" disabled={locked}>
                Save all suggested
              </Button>
            }
          />
        ) : null}
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name in the file</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Maps to</TableHead>
              <TableHead>
                <span className="sr-only">Save</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.map((name) => (
              <MappingRow
                key={`${name.entityType}-${name.raw}`}
                eventId={eventId}
                importId={importId}
                name={name}
                entities={entities[name.entityType]}
                disabled={locked}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

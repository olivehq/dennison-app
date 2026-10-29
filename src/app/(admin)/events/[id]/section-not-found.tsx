"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { eventSectionHref } from "./event-sections";

/**
 * The not-found page for something inside a real event (an import, a campaign).
 * The root page says the event may be gone, which is wrong here: the event is
 * fine and only this item is missing.
 */
export function SectionNotFound({ message, backLabel, section }: { message: string; backLabel: string; section: string }) {
  const { id } = useParams<{ id: string }>();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle className="font-display text-xl font-bold">{message}</EmptyTitle>
        <EmptyDescription>It may have been deleted, or the link is out of date.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href={eventSectionHref(id, section)}>{backLabel}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

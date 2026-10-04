import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyTitle className="font-display text-xl font-bold">Page not found</EmptyTitle>
          <EmptyDescription>
            The link may be out of date, or the event it pointed at was deleted.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href="/events">Go to events</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}

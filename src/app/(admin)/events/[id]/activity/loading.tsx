import { Skeleton } from "@/components/ui/skeleton";

/** The activity page's shape while it loads: header, four stats, chips, and a day of entries. */
export default function ActivityLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading activity">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-full" />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <div className="flex flex-col rounded-lg border bg-card px-4">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-start gap-3 border-t py-3 first:border-t-0">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

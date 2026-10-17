import { Skeleton } from "@/components/ui/skeleton";

function SectionSkeleton({ fields }: { fields: number }) {
  return (
    <div className="grid gap-4 not-first:border-t not-first:pt-8 md:grid-cols-3 md:gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full max-w-60" />
      </div>
      <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 md:col-span-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
        <Skeleton className="h-8 w-32" />
      </div>
    </div>
  );
}

export default function ProfileLoading() {
  return (
    <div className="flex max-w-4xl flex-col gap-8" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-48" />
      <div className="flex flex-col gap-8">
        <SectionSkeleton fields={2} />
        <SectionSkeleton fields={1} />
        <SectionSkeleton fields={3} />
        <SectionSkeleton fields={2} />
      </div>
    </div>
  );
}

import type * as React from "react";

type ProfileSectionProps = {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
};

/** A settings row: title and description beside the card on wide screens, stacked below md. */
export function ProfileSection({ id, title, description, children }: ProfileSectionProps) {
  return (
    <section aria-labelledby={id} className="grid gap-4 not-first:border-t not-first:pt-8 md:grid-cols-3 md:gap-8">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="font-heading text-base leading-snug font-medium">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="min-w-0 md:col-span-2">{children}</div>
    </section>
  );
}

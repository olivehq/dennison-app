import { cn } from "cn";

type PageHeaderProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A status badge rendered beside the title. */
  status?: React.ReactNode;
  /** Buttons for the page, rendered on the right. */
  actions?: React.ReactNode;
  className?: string;
};

export function PageHeader({ title, description, status, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="font-display text-[22px] leading-tight font-bold tracking-[-0.01em] text-balance sm:text-[26px]">
            {title}
          </h1>
          {status}
        </div>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

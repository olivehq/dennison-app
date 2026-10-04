import { ChevronDownIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** Long lists are cut here; the count in the heading stays exact. */
const MAX_ITEMS = 200;

type ReportSectionProps = {
  title: string;
  count: number;
  /** One sentence on what the section means and what to do. */
  hint: string;
  icon: React.ReactNode;
  tone?: "default" | "destructive";
  items: string[];
  defaultOpen?: boolean;
};

/** One part of the validation report: an Alert whose list collapses under the heading. */
export function ReportSection({ title, count, hint, icon, tone = "default", items, defaultOpen = false }: ReportSectionProps) {
  const shown = items.slice(0, MAX_ITEMS);
  return (
    <Collapsible defaultOpen={defaultOpen} asChild>
      <Alert variant={tone}>
        {icon}
        <AlertTitle>
          <CollapsibleTrigger className="group/trigger flex w-full items-center justify-between gap-2 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <span>
              {title} <span className="tabular-nums">({count})</span>
            </span>
            <ChevronDownIcon
              className="size-4 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <p>{hint}</p>
          <CollapsibleContent>
            <ul className="flex flex-col gap-0.5">
              {shown.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
              {items.length > shown.length ? <li>and {items.length - shown.length} more</li> : null}
            </ul>
          </CollapsibleContent>
        </AlertDescription>
      </Alert>
    </Collapsible>
  );
}

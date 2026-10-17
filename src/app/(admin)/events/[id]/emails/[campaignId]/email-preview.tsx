import { cn } from "cn";
import { inertLinks } from "./inert-links";

/**
 * Email HTML shown in the page. The caller passes HTML that the server already
 * ran through `sanitizeEmailHtml` (the preview action does, and so does the
 * sent-campaign page); this component does not clean it again, because a
 * merged schedule link is http in development and would be stripped.
 * Links show as links but can't be opened (`inertLinks`).
 */
export function EmailPreview({ sanitizedHtml, className }: { sanitizedHtml: string; className?: string }) {
  return (
    <div
      className={cn(
        "overflow-x-auto text-sm leading-relaxed break-words [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_img]:max-w-full [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: inertLinks(sanitizedHtml) }}
    />
  );
}

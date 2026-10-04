"use client";

import * as React from "react";
import { cn } from "cn";
import { sanitizeEmailHtml } from "./sanitize-email-html";

const noop = () => () => {};

/**
 * Email HTML shown in the page, sanitized first. Renders nothing on the
 * server, where there is no DOMParser.
 */
export function EmailPreview({ html, className }: { html: string; className?: string }) {
  const isClient = React.useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const safe = React.useMemo(() => (isClient ? sanitizeEmailHtml(html) : ""), [html, isClient]);
  return (
    <div
      className={cn(
        "text-sm leading-relaxed break-words [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
      // Sanitized above: formatting tags and http, https, and mailto links only.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

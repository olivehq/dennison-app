"use client";

import * as React from "react";
import type { Editor } from "@tiptap/react";
import { cn } from "cn";
import { BracesIcon, CodeXmlIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { MERGE_FIELDS } from "@/server/email/merge";

/**
 * The campaign body editor (scope 2.7). Tiptap, client only, loaded by the
 * campaign page alone. Merge fields go in as plain `{{field}}` text.
 *
 * "Edit HTML" swaps the editor for a textarea holding the source, for designed
 * HTML (tables, inline styles) that Tiptap would flatten. The form value is
 * the text as typed while in HTML mode; the server cleans it on save. The
 * editor is only given the source back when the admin switches to the visual
 * editor, so opening a campaign or typing source never rewrites it.
 *
 * This module is the light part: the mode switch, the toolbar frame, and the
 * source textarea. Tiptap lives in `visual-editor.tsx`, which loads on demand,
 * so a campaign that opens in HTML mode never downloads or starts it. The
 * HTML compatibility check (parse5) loads when the admin switches back.
 */

const VisualEditor = dynamic(() => import("./visual-editor").then((m) => m.VisualEditor), {
  ssr: false,
  loading: () => <div aria-hidden="true" className="min-h-56" />,
});
const FormattingTools = dynamic(() => import("./visual-editor").then((m) => m.FormattingTools), { ssr: false });

function MergeFieldMenu({
  disabled,
  onInsert,
  onCloseAutoFocus,
}: {
  disabled?: boolean;
  onInsert: (text: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled}>
          <BracesIcon data-icon="inline-start" />
          Insert merge field
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuLabel>Filled in for each recipient</DropdownMenuLabel>
        <DropdownMenuGroup>
          {MERGE_FIELDS.map((field) => (
            <DropdownMenuItem
              key={field.key}
              onSelect={() => onInsert(`{{${field.key}}}`)}
              className="flex-col items-start gap-0.5"
            >
              <span className="font-medium">{field.label}</span>
              <span className="text-xs text-muted-foreground">{field.description}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type RichTextEditorProps = {
  id?: string;
  value: string;
  /** Start in HTML mode: the saved HTML has markup the visual editor would drop. */
  initialHtmlMode?: boolean;
  onChange: (html: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
};

export function RichTextEditor({
  id,
  value,
  initialHtmlMode = false,
  onChange,
  onBlur,
  invalid,
  disabled,
  ...aria
}: RichTextEditorProps) {
  const [htmlMode, setHtmlMode] = React.useState(initialHtmlMode);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [editor, setEditor] = React.useState<Editor | null>(null);
  /** The visual editor mounts on first use; a campaign that opens in HTML mode waits until the admin switches. */
  const [visualWanted, setVisualWanted] = React.useState(!initialHtmlMode);
  /** A switch to the visual editor that is waiting for its code to load. */
  const pendingSwitch = React.useRef<{ adoptEditorHtml: boolean } | null>(null);
  const sourceRef = React.useRef<HTMLTextAreaElement>(null);
  /** Where focus goes when the merge field menu closes after an insert: the source caret, or the visual editor. */
  const afterInsertFocus = React.useRef<number | "editor" | null>(null);

  /** Hands the typed source to the editor. `adoptEditorHtml` makes the form follow what the editor kept. */
  const showVisualEditor = React.useCallback(
    (adoptEditorHtml: boolean) => {
      if (!editor) {
        pendingSwitch.current = { adoptEditorHtml };
        setVisualWanted(true);
        return;
      }
      // Not an edit: the form already holds `value`, and the adopt branch below writes the cleaned HTML itself.
      editor.commands.setContent(value, { emitUpdate: false });
      if (adoptEditorHtml) onChange(editor.isEmpty ? "" : editor.getHTML());
      setHtmlMode(false);
    },
    [editor, value, onChange],
  );

  // Finish a switch that started before the editor existed.
  React.useEffect(() => {
    const pending = pendingSwitch.current;
    if (!editor || !pending) return;
    pendingSwitch.current = null;
    showVisualEditor(pending.adoptEditorHtml);
  }, [editor, showVisualEditor]);

  const toggleHtml = async () => {
    if (!htmlMode) {
      setHtmlMode(true);
      return;
    }
    const { isEditorCompatibleHtml } = await import("@/lib/email/sanitize-html");
    if (isEditorCompatibleHtml(value)) showVisualEditor(false);
    else setConfirmOpen(true);
  };

  const insertMergeField = (text: string) => {
    if (!htmlMode) {
      afterInsertFocus.current = "editor";
      editor?.chain().focus().insertContent(text).run();
      return;
    }
    const source = sourceRef.current;
    const start = source?.selectionStart ?? value.length;
    const end = source?.selectionEnd ?? start;
    onChange(value.slice(0, start) + text + value.slice(end));
    afterInsertFocus.current = start + text.length;
  };

  /** Radix returns focus to the menu button on close; after an insert, put it back where the text went. */
  const onMergeMenuCloseAutoFocus = (event: Event) => {
    const target = afterInsertFocus.current;
    afterInsertFocus.current = null;
    if (target === null) return;
    event.preventDefault();
    if (target === "editor") {
      editor?.commands.focus();
      return;
    }
    sourceRef.current?.focus();
    sourceRef.current?.setSelectionRange(target, target);
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        invalid && "border-destructive ring-destructive/20",
        disabled && "opacity-60",
      )}
    >
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b p-1">
        {editor && !htmlMode ? <FormattingTools editor={editor} disabled={disabled} /> : null}
        <MergeFieldMenu
          disabled={disabled || (!htmlMode && !editor)}
          onInsert={insertMergeField}
          onCloseAutoFocus={onMergeMenuCloseAutoFocus}
        />
        <Toggle
          size="sm"
          className="ml-auto"
          aria-label="Edit HTML"
          pressed={htmlMode}
          disabled={disabled || (!htmlMode && !editor)}
          onPressedChange={() => void toggleHtml()}
        >
          <CodeXmlIcon data-icon="inline-start" />
          Edit HTML
        </Toggle>
      </div>
      {visualWanted ? (
        <VisualEditor
          id={id}
          value={value}
          htmlMode={htmlMode}
          onChange={onChange}
          onBlur={onBlur}
          onEditor={setEditor}
          invalid={invalid}
          disabled={disabled}
          aria-describedby={aria["aria-describedby"]}
        />
      ) : null}
      {htmlMode ? (
        <Textarea
          ref={sourceRef}
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => onBlur?.()}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          aria-label="Message HTML"
          aria-invalid={invalid || undefined}
          aria-describedby={aria["aria-describedby"]}
          className="min-h-56 rounded-none border-0 bg-transparent font-mono text-xs focus-visible:ring-0"
        />
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Switch to the visual editor?"
        description="The visual editor can't show tables, colors, or other designed layout. If you switch, that formatting is removed from the message. Stay in Edit HTML to keep it."
        confirmLabel="Switch and remove formatting"
        destructive
        onConfirm={() => showVisualEditor(true)}
      />
    </div>
  );
}

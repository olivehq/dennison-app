"use client";

import * as React from "react";
import Link from "@tiptap/extension-link";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { cn } from "cn";
import { BoldIcon, BracesIcon, ItalicIcon, LinkIcon, ListIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { MERGE_FIELDS } from "@/server/email/merge";

/**
 * The campaign body editor (scope 2.7). Tiptap, client only, loaded by the
 * campaign page alone. Merge fields go in as plain `{{field}}` text.
 */

const SCHEDULE_LINK = "{{schedule_link}}";

const extensions = [
  StarterKit.configure({ code: false, codeBlock: false, link: false }),
  Link.configure({
    openOnClick: false,
    autolink: true,
    defaultProtocol: "https",
    // `{{schedule_link}}` is filled in per recipient when the email is rendered.
    isAllowedUri: (url, ctx) => url === SCHEDULE_LINK || ctx.defaultValidate(url),
  }),
];

function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = React.useState(false);
  const [href, setHref] = React.useState("");
  const inputId = React.useId();
  const active = useEditorState({ editor, selector: ({ editor: e }) => e.isActive("link") });

  const onOpenChange = (next: boolean) => {
    if (next) setHref((editor.getAttributes("link").href as string | undefined) ?? "");
    setOpen(next);
  };
  const apply = (value: string) => {
    const url = value.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url === "") chain.unsetLink().run();
    else chain.setLink({ href: url }).run();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Toggle size="sm" pressed={active} aria-label="Link">
          <LinkIcon />
        </Toggle>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply(href);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={inputId}>Link address</FieldLabel>
              <Input
                id={inputId}
                value={href}
                onChange={(event) => setHref(event.target.value)}
                placeholder="https://"
                autoComplete="off"
                autoFocus
              />
              <FieldDescription>Select text first to turn it into a link.</FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm">
                Apply
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => apply(SCHEDULE_LINK)}>
                Link to their schedule
              </Button>
              {active ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => apply("")}>
                  Remove link
                </Button>
              ) : null}
            </div>
          </FieldGroup>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function Toolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      bulletList: e.isActive("bulletList"),
    }),
  });
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b p-1">
      <Toggle
        size="sm"
        aria-label="Bold"
        pressed={state.bold}
        disabled={disabled}
        onPressedChange={() => editor.chain().focus().toggleBold().run()}
      >
        <BoldIcon />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="Italic"
        pressed={state.italic}
        disabled={disabled}
        onPressedChange={() => editor.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="Bullet list"
        pressed={state.bulletList}
        disabled={disabled}
        onPressedChange={() => editor.chain().focus().toggleBulletList().run()}
      >
        <ListIcon />
      </Toggle>
      <LinkButton editor={editor} />
      <Separator orientation="vertical" className="mx-1 h-5" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" disabled={disabled}>
            <BracesIcon data-icon="inline-start" />
            Insert merge field
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Filled in for each recipient</DropdownMenuLabel>
          <DropdownMenuGroup>
            {MERGE_FIELDS.map((field) => (
              <DropdownMenuItem
                key={field.key}
                onSelect={() => editor.chain().focus().insertContent(`{{${field.key}}}`).run()}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-medium">{field.label}</span>
                <span className="text-xs text-muted-foreground">{field.description}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type RichTextEditorProps = {
  id?: string;
  value: string;
  onChange: (html: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
};

export function RichTextEditor({ id, value, onChange, onBlur, invalid, disabled, ...aria }: RichTextEditorProps) {
  const editor = useEditor({
    extensions,
    content: value,
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? "" : e.getHTML()),
    onBlur: () => onBlur?.(),
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message",
        ...(aria["aria-describedby"] ? { "aria-describedby": aria["aria-describedby"] } : {}),
        ...(invalid ? { "aria-invalid": "true" } : {}),
        class:
          "min-h-56 px-3 py-2 text-sm outline-none [&_a]:text-primary [&_a]:underline [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
      },
    },
  });

  return (
    <div
      className={cn(
        "rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        invalid && "border-destructive ring-destructive/20",
        disabled && "opacity-60",
      )}
    >
      {editor ? <Toolbar editor={editor} disabled={disabled} /> : <div className="h-9 border-b" aria-hidden="true" />}
      <EditorContent editor={editor} />
    </div>
  );
}

"use client";

import * as React from "react";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { BoldIcon, ImageIcon, ItalicIcon, LinkIcon, ListIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";

/**
 * The Tiptap half of the campaign body editor. `rich-text-editor.tsx` loads
 * this module with `next/dynamic`, so Tiptap and ProseMirror stay out of the
 * page until the visual editor is needed.
 */

const SCHEDULE_LINK = "{{schedule_link}}";

const extensions = [
  StarterKit.configure({ code: false, codeBlock: false, link: false }),
  Link.configure({
    openOnClick: false,
    autolink: true,
    defaultProtocol: "https",
    // `{{schedule_link}}` is filled in per recipient when the email is rendered.
    // Emails only keep https and mailto links; the server drops the rest.
    isAllowedUri: (url, ctx) => url === SCHEDULE_LINK || (ctx.defaultValidate(url) && /^(https:|mailto:)/i.test(url)),
  }),
  Image.configure({ allowBase64: false }),
];

/** "example.com" becomes "https://example.com"; anything with its own scheme is left alone. */
function withScheme(value: string): string {
  const url = value.trim();
  return url === "" || url === SCHEDULE_LINK || /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = React.useState(false);
  const [href, setHref] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const inputId = React.useId();
  const active = useEditorState({ editor, selector: ({ editor: e }) => e.isActive("link") });

  const onOpenChange = (next: boolean) => {
    if (next) {
      setHref((editor.getAttributes("link").href as string | undefined) ?? "");
      setError(null);
    }
    setOpen(next);
  };
  const apply = (value: string) => {
    const url = withScheme(value);
    if (url !== "" && url !== SCHEDULE_LINK && !/^(https:|mailto:)/i.test(url)) {
      setError("Links must start with https:// or mailto:");
      return;
    }
    setError(null);
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
        {/* Not a <form>: React bubbles a submit through the portal to the
            campaign form around the editor, which would save the campaign. */}
        <div>
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={inputId}>Link address</FieldLabel>
              <Input
                id={inputId}
                value={href}
                onChange={(event) => setHref(event.target.value)}
                aria-invalid={!!error}
                placeholder="https://"
                autoComplete="off"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  apply(href);
                }}
              />
              {error ? <FieldError>{error}</FieldError> : null}
              <FieldDescription>Select text first to turn it into a link.</FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => apply(href)}>
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
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ImageButton({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [src, setSrc] = React.useState("");
  const [alt, setAlt] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const srcId = React.useId();
  const altId = React.useId();

  const onOpenChange = (next: boolean) => {
    if (next) {
      setSrc("");
      setAlt("");
      setError(null);
    }
    setOpen(next);
  };
  const insert = () => {
    const url = src.trim();
    if (!/^https:\/\/[^\s/?#]\S*$/i.test(url)) {
      setError("Enter an image address that starts with https://");
      return;
    }
    editor.chain().focus().setImage({ src: url, alt: alt.trim() }).run();
    setOpen(false);
  };
  const insertOnEnter = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    insert();
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Image" disabled={disabled}>
          <ImageIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        {/* Not a <form>, for the same reason as the link popover. */}
        <div>
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={srcId}>Image address</FieldLabel>
              <Input
                id={srcId}
                value={src}
                onChange={(event) => setSrc(event.target.value)}
                aria-invalid={!!error}
                placeholder="https://"
                autoComplete="off"
                autoFocus
                onKeyDown={insertOnEnter}
              />
              {error ? <FieldError>{error}</FieldError> : null}
              <FieldDescription>
                The image has to be hosted online. Many email apps hide images until the reader allows them.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={altId}>Description</FieldLabel>
              <Input
                id={altId}
                value={alt}
                onChange={(event) => setAlt(event.target.value)}
                autoComplete="off"
                onKeyDown={insertOnEnter}
              />
              <FieldDescription>Shown when the image is hidden, and read aloud by screen readers.</FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={insert}>
                Insert image
              </Button>
            </div>
          </FieldGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Bold, italic, list, link, and image: the toolbar buttons that need the editor. */
export function FormattingTools({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      bulletList: e.isActive("bulletList"),
    }),
  });
  return (
    <>
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
      <ImageButton editor={editor} disabled={disabled} />
      <Separator orientation="vertical" className="mx-1 h-5" />
    </>
  );
}

type VisualEditorProps = {
  id?: string;
  value: string;
  /** The source textarea is showing, so this editor is hidden and does not carry the label's id. */
  htmlMode: boolean;
  onChange: (html: string) => void;
  onBlur?: () => void;
  /** Hands the editor to the shell, which inserts merge fields and swaps content. Null on unmount. */
  onEditor: (editor: Editor | null) => void;
  invalid?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
};

export function VisualEditor({ id, value, htmlMode, onChange, onBlur, onEditor, invalid, disabled, ...aria }: VisualEditorProps) {
  const describedBy = aria["aria-describedby"];
  const editorProps = React.useMemo(
    () => ({
      attributes: {
        ...(id && !htmlMode ? { id } : {}),
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message",
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(invalid ? { "aria-invalid": "true" } : {}),
        class:
          "min-h-56 px-3 py-2 text-sm outline-none [&_a]:text-primary [&_a]:underline [&_img]:max-w-full [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
      },
    }),
    [id, htmlMode, describedBy, invalid],
  );
  const editor = useEditor({
    extensions,
    content: value,
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? "" : e.getHTML()),
    onBlur: () => onBlur?.(),
    editorProps,
  });

  React.useEffect(() => {
    editor?.setOptions({ editorProps });
  }, [editor, editorProps]);

  React.useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);

  return (
    <div hidden={htmlMode}>
      <EditorContent editor={editor} />
    </div>
  );
}

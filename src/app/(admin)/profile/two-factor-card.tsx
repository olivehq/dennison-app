"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { CopyIcon, DownloadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import {
  backupCodesText,
  describeTwoFactorError,
  groupSecret,
  qrPath,
  secretFromTotpUri,
} from "./two-factor-setup";

type Flow = "enable" | "disable" | "backup-codes";

/** Where the dialog is. Turning on goes password, then scan and verify, then the backup codes. */
type Step =
  | { kind: "password" }
  | { kind: "scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

const passwordSchema = z.object({ password: z.string().min(1, "Enter your password.") });
const codeSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s/g, ""))
    .pipe(z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.")),
});

const PASSWORD_COPY: Record<Flow, { title: string; description: string; submit: string; pending: string }> = {
  enable: {
    title: "Turn on two-factor sign-in",
    description: "Confirm your password. Then you'll scan a QR code with an authenticator app, such as Google Authenticator, 1Password, or Microsoft Authenticator.",
    submit: "Continue",
    pending: "Checking",
  },
  disable: {
    title: "Turn off two-factor sign-in?",
    description: "Signing in will only need your password. Your authenticator app entry and backup codes stop working.",
    submit: "Turn off",
    pending: "Turning off",
  },
  "backup-codes": {
    title: "Make new backup codes",
    description: "Confirm your password. Your old backup codes stop working.",
    submit: "Make new codes",
    pending: "Making codes",
  },
};

/**
 * Two-factor sign-in on the profile page. Calls Better Auth's two-factor
 * routes from the browser, so their rate limit applies; the auth module audits
 * turning it on and off. Each call that changes it rotates this browser's
 * session cookie, and the page refreshes to show the new state.
 */
export function TwoFactorCard({ enabled, email }: { enabled: boolean; email: string }) {
  const router = useRouter();
  const [flow, setFlow] = React.useState<Flow | null>(null);
  const [step, setStep] = React.useState<Step>({ kind: "password" });

  const open = (next: Flow) => {
    setStep({ kind: "password" });
    setFlow(next);
  };

  const close = () => {
    const changed = step.kind === "codes";
    setFlow(null);
    if (changed) router.refresh();
  };

  const confirmPassword = async (password: string): Promise<string | null> => {
    if (flow === "enable") {
      const { data, error } = await authClient.twoFactor.enable({ password });
      if (error) return describeTwoFactorError(error);
      if (!data || !("totpURI" in data) || !data.totpURI || !data.backupCodes) {
        return "Something went wrong. Try again in a moment.";
      }
      setStep({ kind: "scan", totpURI: data.totpURI, backupCodes: data.backupCodes });
      return null;
    }
    if (flow === "disable") {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) return describeTwoFactorError(error);
      setFlow(null);
      toast.success("Two-factor sign-in is off.");
      router.refresh();
      return null;
    }
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    if (error) return describeTwoFactorError(error);
    setStep({ kind: "codes", backupCodes: data.backupCodes });
    return null;
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Authenticator app</span>
          <Badge variant={enabled ? "secondary" : "outline"}>{enabled ? "On" : "Off"}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {enabled
            ? "After your password, sign-in asks for a code from your authenticator app. If you don't have your phone, use a backup code."
            : "Add a code from an authenticator app to your password, so a stolen password alone can't open your account."}
        </p>
        <div className="flex flex-wrap gap-2">
          {enabled ? (
            <>
              <Button variant="outline" onClick={() => open("backup-codes")}>
                Make new backup codes
              </Button>
              <Button variant="destructive" onClick={() => open("disable")}>
                Turn off
              </Button>
            </>
          ) : (
            <Button onClick={() => open("enable")}>Turn on</Button>
          )}
        </div>
      </CardContent>
      <Dialog open={flow !== null} onOpenChange={(isOpen) => (isOpen ? null : close())}>
        <DialogContent
          className="sm:max-w-md"
          // A stray click outside shouldn't lose a QR code or codes that are shown once.
          onInteractOutside={(event) => (step.kind === "password" ? undefined : event.preventDefault())}
        >
          {flow === null ? null : step.kind === "password" ? (
            <PasswordStep copy={PASSWORD_COPY[flow]} email={email} destructive={flow === "disable"} onSubmit={confirmPassword} onCancel={close} />
          ) : step.kind === "scan" ? (
            <ScanStep
              totpURI={step.totpURI}
              onVerified={() => setStep({ kind: "codes", backupCodes: step.backupCodes })}
              onCancel={close}
            />
          ) : (
            <BackupCodesStep codes={step.backupCodes} email={email} fresh={flow === "enable"} onDone={close} />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PasswordStep({
  copy,
  email,
  destructive,
  onSubmit,
  onCancel,
}: {
  copy: (typeof PASSWORD_COPY)[Flow];
  email: string;
  destructive: boolean;
  onSubmit: (password: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: "" },
  });

  const submit = async ({ password }: z.infer<typeof passwordSchema>) => {
    let message: string | null;
    try {
      message = await onSubmit(password);
    } catch {
      message = "Couldn't reach the server. Check your connection and try again.";
    }
    if (message) setError("password", { message }, { shouldFocus: true });
  };

  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      {/* Lets password managers offer the right account. */}
      <input type="email" name="username" autoComplete="username" value={email} hidden readOnly />
      <FieldGroup>
        <Field data-invalid={!!errors.password}>
          <FieldLabel htmlFor="two-factor-password">Password</FieldLabel>
          <Input
            id="two-factor-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            disabled={isSubmitting}
            aria-invalid={!!errors.password}
            {...register("password")}
          />
          <FieldError errors={[errors.password]} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={isSubmitting}>
          {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
          {isSubmitting ? copy.pending : copy.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ScanStep({ totpURI, onVerified, onCancel }: { totpURI: string; onVerified: () => void; onCancel: () => void }) {
  const qr = React.useMemo(() => qrPath(totpURI), [totpURI]);
  const secret = secretFromTotpUri(totpURI);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof codeSchema>, unknown, z.output<typeof codeSchema>>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: "" },
  });

  const submit = async ({ code }: z.output<typeof codeSchema>) => {
    let message: string | null = null;
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code });
      if (error) message = describeTwoFactorError(error);
    } catch {
      message = "Couldn't reach the server. Check your connection and try again.";
    }
    if (message) setError("code", { message }, { shouldFocus: true });
    else onVerified();
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Key copied.");
    } catch {
      toast.error("Couldn't copy. Select the key and copy it instead.");
    }
  };

  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Scan the QR code</DialogTitle>
        <DialogDescription>
          In your authenticator app, add an account and scan this code. Then enter the 6-digit code the app shows.
        </DialogDescription>
      </DialogHeader>
      {/* A QR code needs dark modules on a light background in either theme, so its colors are fixed. */}
      <svg
        role="img"
        aria-label="QR code for your authenticator app"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
        className="size-48 self-center rounded-md border"
      >
        <rect width={qr.size} height={qr.size} fill="#ffffff" />
        <path d={qr.path} fill="#000000" />
      </svg>
      {secret ? (
        <div className="flex flex-col gap-2">
          <p id="two-factor-secret-label" className="text-sm font-medium">
            Can&apos;t scan? Enter this key
          </p>
          <div className="flex items-start gap-2">
            <code
              aria-labelledby="two-factor-secret-label"
              className="flex-1 rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-sm break-words select-all"
            >
              {groupSecret(secret)}
            </code>
            <Button type="button" variant="outline" size="icon" onClick={copySecret}>
              <CopyIcon />
              <span className="sr-only">Copy key</span>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Choose a time-based key if the app asks.</p>
        </div>
      ) : null}
      <FieldGroup>
        <Field data-invalid={!!errors.code}>
          <FieldLabel htmlFor="two-factor-setup-code">6-digit code</FieldLabel>
          <Input
            id="two-factor-setup-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            disabled={isSubmitting}
            aria-invalid={!!errors.code}
            className="font-mono tracking-[0.3em]"
            {...register("code")}
          />
          <FieldError errors={[errors.code]} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
          {isSubmitting ? "Turning on" : "Turn on"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function BackupCodesStep({
  codes,
  email,
  fresh,
  onDone,
}: {
  codes: string[];
  email: string;
  fresh: boolean;
  onDone: () => void;
}) {
  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success("Backup codes copied.");
    } catch {
      toast.error("Couldn't copy. Use Download instead.");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([backupCodesText(codes, email)], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "aw-appointment-matching-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{fresh ? "Two-factor sign-in is on" : "Your new backup codes"}</DialogTitle>
        <DialogDescription>
          Save these backup codes somewhere safe, like a password manager. Each one signs you in once if you
          can&apos;t use your authenticator app. They won&apos;t be shown again.
        </DialogDescription>
      </DialogHeader>
      <ul aria-label="Backup codes" className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border bg-muted/50 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={copyCodes}>
          <CopyIcon data-icon="inline-start" />
          Copy
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          <DownloadIcon data-icon="inline-start" />
          Download
        </Button>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          I saved my codes
        </Button>
      </DialogFooter>
    </div>
  );
}

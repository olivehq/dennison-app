"use client";

import * as React from "react";
import { CircleAlertIcon, ClockIcon, InfoIcon, WifiOffIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  classifyAuthError,
  formatCountdown,
  parseRetryAfter,
  secondsUntil,
  waitCopy,
  type AuthClientError,
  type AuthFeedback,
} from "./auth-errors";

/** Passed as `fetchOptions` so the hook can read `X-Retry-After`, which the error object drops. */
export type AuthFetchOptions = { onError: (context: { response: Response }) => void };

type AuthCall = (fetchOptions: AuthFetchOptions) => Promise<{ error: AuthClientError | null }>;

/**
 * Runs one Better Auth client call and keeps what the form should show after it:
 * the classified error, and while rate limited, the seconds left to wait. The
 * alert clears itself when the wait runs out.
 */
export function useAuthFeedback() {
  const [state, setState] = React.useState<{ feedback: AuthFeedback | null; now: number }>({
    feedback: null,
    now: 0,
  });
  const retryAt = state.feedback?.kind === "rate-limited" ? state.feedback.retryAt : null;

  React.useEffect(() => {
    if (retryAt === null) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setState((current) => (now >= retryAt ? { feedback: null, now } : { ...current, now }));
    }, 1000);
    return () => window.clearInterval(id);
  }, [retryAt]);

  const run = React.useCallback(async (call: AuthCall, fallback: string): Promise<AuthFeedback | null> => {
    setState({ feedback: null, now: Date.now() });
    let retryAfter: number | null = null;
    const fetchOptions: AuthFetchOptions = {
      onError: ({ response }) => {
        retryAfter = parseRetryAfter(response.headers.get("X-Retry-After"));
      },
    };
    let feedback: AuthFeedback | null;
    try {
      const { error } = await call(fetchOptions);
      feedback = error ? classifyAuthError(error, fallback, retryAfter, Date.now()) : null;
    } catch {
      // Better Auth's client returns server errors; it only throws when fetch itself fails.
      feedback = { kind: "network" };
    }
    setState({ feedback, now: Date.now() });
    return feedback;
  }, []);

  const clear = React.useCallback(() => setState((current) => ({ ...current, feedback: null })), []);

  return {
    feedback: state.feedback,
    waitSeconds: retryAt === null ? null : secondsUntil(retryAt, state.now),
    run,
    clear,
  };
}

/** The one alert an auth form shows after a failed request. */
export function AuthFeedbackAlert({ feedback, waitSeconds }: { feedback: AuthFeedback | null; waitSeconds: number | null }) {
  if (!feedback) return null;
  switch (feedback.kind) {
    case "invalid-credentials":
      return (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Email and password don&apos;t match</AlertTitle>
          <AlertDescription>Check both and try again. Passwords are case sensitive.</AlertDescription>
        </Alert>
      );
    case "rate-limited":
      return (
        <Alert>
          <ClockIcon />
          <AlertTitle>Too many attempts</AlertTitle>
          <AlertDescription>{waitCopy(waitSeconds)}</AlertDescription>
        </Alert>
      );
    case "network":
      return (
        <Alert variant="destructive">
          <WifiOffIcon />
          <AlertTitle>Couldn&apos;t reach the server</AlertTitle>
          <AlertDescription>Check your connection and try again.</AlertDescription>
        </Alert>
      );
    case "restart":
    case "error":
      return (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      );
  }
}

/** A quiet notice, such as "Your session ended", that is not an error. */
export function AuthNotice({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="bg-muted/50">
      <InfoIcon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** Full-width submit: a spinner while pending, a countdown while rate limited. */
export function AuthSubmitButton({
  pending,
  pendingLabel,
  waitSeconds,
  children,
}: {
  pending: boolean;
  pendingLabel: string;
  waitSeconds: number | null;
  children: React.ReactNode;
}) {
  const waiting = waitSeconds !== null && waitSeconds > 0;
  return (
    <Button type="submit" className="w-full" disabled={pending || waiting}>
      {pending ? (
        <>
          <Spinner data-icon="inline-start" />
          {pendingLabel}
        </>
      ) : waiting ? (
        <>
          Try again in
          <span className="tabular-nums">{formatCountdown(waitSeconds)}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
}

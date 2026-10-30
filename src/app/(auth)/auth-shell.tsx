import Link from "next/link";
import { cn } from "cn";
import { BrandMark } from "@/components/app/brand-mark";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The brand mark from the admin sidebar, with the product name beside it. */
export function AwMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="font-display text-base font-bold tracking-[-0.01em]">AW appointment matching</span>
    </div>
  );
}

/** Page title and one line under it, the same on every auth screen. */
export function AuthHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <CardHeader className="gap-1.5">
      <CardTitle>
        <h1 className="font-display text-2xl font-bold tracking-[-0.015em]">{title}</h1>
      </CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
  );
}

export function BackToSignIn() {
  return (
    <Button variant="link" className="self-center" asChild>
      <Link href="/login">Back to sign in</Link>
    </Button>
  );
}

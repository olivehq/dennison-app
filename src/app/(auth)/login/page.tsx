import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getSession } from "@/server/auth/session";
import { safeNextPath } from "../auth-errors";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const next = safeNextPath(params.next);
  if (session) redirect(next);

  return (
    <>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the email and password for your admin account.</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm next={next} />
      </CardContent>
      <CardFooter className="justify-center">
        <Button variant="link" asChild>
          <Link href="/forgot-password">Forgot your password?</Link>
        </Button>
      </CardFooter>
    </>
  );
}

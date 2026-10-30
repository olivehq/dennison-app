import { env } from "@/lib/env";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

// The one response for every link that does not work (D44), sent with status 404.
export default function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col justify-center gap-6 px-4 py-10">
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="font-display text-xl font-bold">This link is not valid</EmptyTitle>
          <EmptyDescription>
            It may have expired or been replaced. Contact {env.SUPPORT_EMAIL ? (
              <a href={`mailto:${env.SUPPORT_EMAIL}`}>the AW team</a>
            ) : "the AW team"} for a new one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <footer className="pt-2 text-center text-xs text-muted-foreground">Sent by Dennison &amp; Associates</footer>
    </main>
  );
}

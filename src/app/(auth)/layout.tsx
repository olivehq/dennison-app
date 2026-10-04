import { Card } from "@/components/ui/card";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <p className="font-display text-xl font-bold tracking-[-0.01em]">AW appointment matching</p>
      <Card className="w-full max-w-sm">{children}</Card>
    </main>
  );
}

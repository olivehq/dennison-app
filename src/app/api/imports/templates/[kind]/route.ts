import type { NextRequest } from "next/server";
import { importKindSchema } from "@/lib/schemas/import";
import { getSession } from "@/server/auth/session";
import { templateWorkbook } from "@/server/imports/templates";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** An empty workbook with the template headers for one import kind. Admins only. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/imports/templates/[kind]">) {
  const session = await getSession();
  if (!session) return new Response("Sign in to download templates.", { status: 401 });

  const { kind } = await ctx.params;
  const parsed = importKindSchema.safeParse(kind);
  if (!parsed.success) return new Response("Unknown template.", { status: 404 });

  const body = templateWorkbook(parsed.data);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="AW_${parsed.data}_template.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}

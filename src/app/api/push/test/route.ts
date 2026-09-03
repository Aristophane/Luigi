import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/dal";
import { getWebPushConfiguration, sendTestWebPush } from "@/lib/web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!getWebPushConfiguration().configured) {
    return NextResponse.json({ error: "Web Push is not configured." }, { status: 503 });
  }

  const parsed = z.object({ endpoint: z.string().url().max(2048) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid subscription." }, { status: 400 });

  const result = await sendTestWebPush(session.user.id, parsed.data.endpoint);
  if (!result.delivered) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === "not_found" ? 404 : 502 });
  }
  return NextResponse.json({ delivered: true });
}

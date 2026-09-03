import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const script = await readFile(path.join(process.cwd(), "agent", "install.sh"), "utf8");
  return new Response(script, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

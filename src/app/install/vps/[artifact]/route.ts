import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const artifacts = {
  "agent.py": { filename: "luigi_agent.py", contentType: "text/x-python; charset=utf-8" },
  service: { filename: "luigi-agent.service", contentType: "text/plain; charset=utf-8" },
  timer: { filename: "luigi-agent.timer", contentType: "text/plain; charset=utf-8" },
} as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ artifact: string }> },
) {
  const { artifact } = await params;
  const selected = artifacts[artifact as keyof typeof artifacts];
  if (!selected) notFound();

  const body = await readFile(path.join(process.cwd(), "agent", selected.filename), "utf8");
  return new Response(body, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": selected.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

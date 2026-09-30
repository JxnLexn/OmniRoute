import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { errorResponse } from "@omniroute/open-sse/utils/error";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const denied = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (denied) return denied;
  try {
    const script = await readFile(join(process.cwd(), "scripts/cli/chatgpt-login.mjs"), "utf8");
    return new Response(script, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Disposition": 'attachment; filename="chatgpt-login.mjs"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return errorResponse(503, "The local sign-in helper is unavailable in this build.");
  }
}

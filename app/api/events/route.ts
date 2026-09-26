// GET /api/events?limit=50  — latest relay switching events

import { db, dbConfigured, jsonError, table } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!dbConfigured()) return jsonError("Database not configured", 503);

  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 50));
  const sql = db();

  try {
    const rows = await sql<{ ts: Date; load_id: number; state: boolean; source: string }[]>`
      select ts, load_id, state, source
      from ${table("relay_events")}
      order by ts desc
      limit ${limit}`;

    return Response.json({
      events: rows.map((r) => ({
        ts: Math.floor(new Date(r.ts).getTime() / 1000),
        load: r.load_id,
        on: r.state,
        src: r.source,
      })),
    });
  } catch (err) {
    console.error("[events] db error:", err);
    return jsonError("Database error", 500);
  }
}

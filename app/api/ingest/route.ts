// POST /api/ingest  — called by the ESP32 every ~10 s
//
// Header:  x-api-key: <INGEST_KEY from .env>
// Body (kept compact for the ESP32):
// {
//   "s": [                                  samples (oldest first)
//     { "ts": 1790425981,                   epoch seconds
//       "b": 0,                             1 = was buffered while offline
//       "l": [ [on, v, i, p, pf, eTotKwh, derived], x3 loads ] }
//   ],
//   "e": [ { "ts": 1790425981, "load": 1, "on": true, "src": "dashboard" } ]
// }

import { db, dbConfigured, jsonError, table } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LoadTuple = [number | boolean, number, number, number, number, number, number | boolean];
interface Sample { ts: number; b?: number; l: LoadTuple[] }
interface Ev { ts: number; load: number; on: boolean; src?: string }

const MIN_TS = 1704067200; // 2024-01-01: anything older means the ESP32 clock was not set

function validTs(ts: unknown): ts is number {
  const now = Date.now() / 1000;
  return typeof ts === "number" && ts > MIN_TS && ts < now + 86400;
}
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

export async function POST(req: Request) {
  if (!dbConfigured()) return jsonError("Database not configured", 503);

  const key = process.env.INGEST_KEY;
  if (!key || req.headers.get("x-api-key") !== key) return jsonError("Unauthorized", 401);

  let body: { s?: Sample[]; e?: Ev[] };
  try {
    body = await req.json();
  } catch {
    return jsonError("Bad JSON", 400);
  }

  const rows: Record<string, unknown>[] = [];
  for (const s of body.s ?? []) {
    if (!validTs(s?.ts) || !Array.isArray(s.l)) continue;
    const ts = new Date(s.ts * 1000);
    s.l.slice(0, 3).forEach((t, k) => {
      if (!Array.isArray(t)) return;
      rows.push({
        ts,
        load_id: k + 1,
        relay_on: !!t[0],
        voltage_v: num(t[1]),
        current_a: num(t[2]),
        power_w: num(t[3]),
        power_factor: num(t[4]),
        energy_total_kwh: num(t[5]),
        derived: !!t[6],
        buffered: !!s.b,
      });
    });
  }

  const events = (body.e ?? [])
    .filter((e) => validTs(e?.ts) && e.load >= 1 && e.load <= 3 && typeof e.on === "boolean")
    .map((e) => ({
      ts: new Date(e.ts * 1000),
      load_id: e.load,
      state: e.on,
      source: String(e.src ?? "unknown").slice(0, 20),
    }));

  const sql = db();
  try {
    if (rows.length)
      await sql`insert into ${table("measurements")} ${sql(rows)} on conflict (load_id, ts) do nothing`;
    if (events.length)
      await sql`insert into ${table("relay_events")} ${sql(events)} on conflict (load_id, ts, state) do nothing`;
  } catch (err) {
    console.error("[ingest] db error:", err);
    return jsonError("Database error", 500);
  }

  // The ESP32 only removes samples from its buffer after it sees ok:true
  return Response.json({ ok: true, samples: rows.length / 3, events: events.length });
}

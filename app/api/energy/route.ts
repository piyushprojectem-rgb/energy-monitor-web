// GET /api/energy?period=hourly|daily
//   hourly: kWh per load for each of the last 24 hours (IST)
//   daily:  kWh per load for each of the last 14 days (IST)
// Computed from the ESP32's running kWh counter (see view energy_deltas).

import { db, dbConfigured, jsonError, table, TZ } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!dbConfigured()) return jsonError("Database not configured", 503);

  const period = new URL(req.url).searchParams.get("period") ?? "hourly";
  if (period !== "hourly" && period !== "daily") return jsonError("period must be hourly or daily", 400);

  const hourly = period === "hourly";
  const unit = hourly ? "hour" : "day";
  const count = hourly ? 24 : 14;
  const sql = db();

  try {
    // Bucket label is local (IST) time, e.g. "2026-09-26 14:00" or "2026-09-26"
    const fmt = hourly ? "YYYY-MM-DD HH24:00" : "YYYY-MM-DD";
    const rows = await sql<{ bucket: string; load_id: number; kwh: number }[]>`
      select
        to_char(date_trunc(${unit}, ts at time zone ${TZ}), ${fmt}) as bucket,
        load_id,
        sum(kwh)::double precision as kwh
      from ${table("energy_deltas")}
      where ts >= (date_trunc(${unit}, now() at time zone ${TZ}) - ${`${count - 1} ${unit}s`}::interval) at time zone ${TZ}
      group by 1, 2`;

    // Build the full list of buckets (so empty hours/days show as 0)
    const buckets: string[] = [];
    const [{ now_local }] = await sql<{ now_local: string }[]>`
      select to_char(now() at time zone ${TZ}, 'YYYY-MM-DD"T"HH24:MI:SS') as now_local`;
    const base = new Date(now_local + "Z"); // treat local wall time as UTC for arithmetic
    for (let n = count - 1; n >= 0; n--) {
      const d = new Date(base);
      if (hourly) d.setUTCHours(d.getUTCHours() - n, 0, 0, 0);
      else d.setUTCDate(d.getUTCDate() - n);
      const iso = d.toISOString();
      buckets.push(hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10));
    }

    const map = new Map(buckets.map((b) => [b, { bucket: b, l1: 0, l2: 0, l3: 0, total: 0 }]));
    for (const r of rows) {
      const b = map.get(r.bucket);
      if (!b) continue;
      (b as Record<string, number | string>)[`l${r.load_id}`] = r.kwh;
      b.total += r.kwh;
    }

    return Response.json({ period, rows: [...map.values()] });
  } catch (err) {
    console.error("[energy] db error:", err);
    return jsonError("Database error", 500);
  }
}

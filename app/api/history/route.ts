// GET /api/history?range=1h|6h|24h|7d
// Average power per load, bucketed so the chart has ~120-300 points.
// Periods with no data come back as null so the chart shows a gap.

import { db, dbConfigured, jsonError, table } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RANGES: Record<string, { seconds: number; bucket: number }> = {
  "1h": { seconds: 3600, bucket: 60 },
  "6h": { seconds: 6 * 3600, bucket: 120 },
  "24h": { seconds: 24 * 3600, bucket: 300 },
  "7d": { seconds: 7 * 86400, bucket: 3600 },
};

export async function GET(req: Request) {
  if (!dbConfigured()) return jsonError("Database not configured", 503);

  const range = new URL(req.url).searchParams.get("range") ?? "1h";
  const r = RANGES[range];
  if (!r) return jsonError("range must be one of " + Object.keys(RANGES).join(", "), 400);

  const sql = db();
  const bucket = `${r.bucket} seconds`;
  const span = `${r.seconds} seconds`;

  try {
    const rows = await sql<{ t: string; load_id: number; p: number; i: number; pf: number | null; v: number | null }[]>`
      select
        extract(epoch from date_bin(${bucket}::interval, ts, timestamptz '2000-01-01'))::bigint as t,
        load_id,
        avg(case when relay_on then power_w else 0 end)::real       as p,
        avg(case when relay_on then current_a else 0 end)::real     as i,
        avg(case when relay_on and current_a > 0 then power_factor end)::real as pf,
        avg(voltage_v)::real                                         as v
      from ${table("measurements")}
      where ts > now() - ${span}::interval
      group by 1, 2
      order by 1`;

    // Pivot into one row per time bucket: { t, p1, i1, v1, pf1, p2, ... }
    type Pt = { t: number } & Record<string, number | null>;
    const empty = (t: number): Pt => {
      const pt: Pt = { t };
      for (const n of [1, 2, 3]) for (const m of ["p", "i", "v", "pf"]) pt[`${m}${n}`] = null;
      return pt;
    };
    const byT = new Map<number, Pt>();
    for (const row of rows) {
      const t = Number(row.t) * 1000;
      if (!byT.has(t)) byT.set(t, empty(t));
      const pt = byT.get(t)!;
      const n = row.load_id;
      pt[`p${n}`] = row.p;
      pt[`i${n}`] = row.i;
      pt[`v${n}`] = row.v;
      pt[`pf${n}`] = row.pf;
    }

    // Fill empty buckets with nulls (device offline -> visible gap)
    const step = r.bucket * 1000;
    const end = Math.floor(Date.now() / step) * step;
    const start = end - r.seconds * 1000;
    const points = [];
    for (let t = start; t <= end; t += step) {
      points.push(byT.get(t) ?? empty(t));
    }

    return Response.json({ range, bucketSeconds: r.bucket, points });
  } catch (err) {
    console.error("[history] db error:", err);
    return jsonError("Database error", 500);
  }
}

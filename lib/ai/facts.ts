// Server-only. Collects the facts the AI is allowed to talk about.
//
// All numbers are computed HERE, from the database, with plain SQL.
// Gemini only explains them in words — it never calculates on its own.
// That keeps answers accurate (no made-up numbers) and is easy to
// explain in a viva: "rule-based analysis + language model".

import { db, table, TZ } from "@/lib/db";

export const TARIFF = Number(process.env.TARIFF_INR_PER_KWH || 8); // ₹ per kWh
const LOAD_NAMES = (process.env.LOAD_NAMES || "Load 1,Load 2,Load 3").split(",").map((s) => s.trim());

export interface LoadToday {
  load: number;
  name: string;
  is_on_now: boolean;
  power_now_w: number | null;
  kwh_today: number;
  cost_today_inr: number;
  hours_on_today: number;
  kwh_yesterday: number;
  hours_on_yesterday: number;
  avg_daily_kwh_prev_7d: number | null;
  avg_hours_on_prev_7d: number | null;
  avg_power_when_on_w_24h: number | null;
  max_power_w_24h: number | null;
  avg_power_factor_24h: number | null;
  on_since: string | null; // local time, if currently ON
}

export interface Finding {
  level: "alert" | "warning" | "info";
  code: string;
  load?: number;
  message: string; // plain, factual — the AI rewrites it nicely
}

export interface EnergyFacts {
  now_local: string;
  timezone: string;
  tariff_inr_per_kwh: number;
  device_last_data_local: string | null;
  device_online: boolean;
  totals: {
    kwh_today: number;
    cost_today_inr: number;
    kwh_yesterday: number;
    cost_yesterday_inr: number;
    kwh_last_7d: number;
    cost_last_7d_inr: number;
  };
  voltage_24h: { min: number | null; avg: number | null; max: number | null };
  loads: LoadToday[];
  daily_kwh_last_8_days: { date: string; l1: number; l2: number; l3: number; total: number }[];
  hourly_kwh_today: { hour: string; l1: number; l2: number; l3: number }[];
  hourly_kwh_yesterday: { hour: string; l1: number; l2: number; l3: number }[];
  relay_events_last_24h: { time: string; load: number; state: "ON" | "OFF"; source: string }[];
  findings: Finding[];
}

const r = (x: number | null | undefined, d = 3) => (x == null ? null : Math.round(Number(x) * 10 ** d) / 10 ** d);
const n = (x: unknown) => Number(x ?? 0);

export async function getEnergyFacts(): Promise<EnergyFacts> {
  const sql = db();
  const M = table("measurements");
  const D = table("energy_deltas");
  const E = table("relay_events");

  // ---------- energy per day per load (last 8 local days, incl. today) ----------
  const daily = await sql<{ day: string; load_id: number; kwh: number }[]>`
    select to_char((ts at time zone ${TZ})::date, 'YYYY-MM-DD') as day, load_id, sum(kwh)::float8 as kwh
    from ${D}
    where ts >= ((now() at time zone ${TZ})::date - 7)::timestamp at time zone ${TZ}
    group by 1, 2`;

  // ---------- hourly energy today + yesterday ----------
  const hourly = await sql<{ day: string; hour: string; load_id: number; kwh: number }[]>`
    select to_char((ts at time zone ${TZ})::date, 'YYYY-MM-DD') as day,
           to_char(date_trunc('hour', ts at time zone ${TZ}), 'HH24:00') as hour,
           load_id, sum(kwh)::float8 as kwh
    from ${D}
    where ts >= ((now() at time zone ${TZ})::date - 1)::timestamp at time zone ${TZ}
    group by 1, 2, 3`;

  // ---------- hours ON per day per load (gaps between samples, capped at 2 min) ----------
  const onTime = await sql<{ day: string; load_id: number; hours: number }[]>`
    select to_char((ts at time zone ${TZ})::date, 'YYYY-MM-DD') as day, load_id,
           (sum(least(gap, 120)) / 3600.0)::float8 as hours
    from (
      select ts, load_id, relay_on,
             extract(epoch from lead(ts) over (partition by load_id order by ts) - ts) as gap
      from ${M}
      where ts >= ((now() at time zone ${TZ})::date - 7)::timestamp at time zone ${TZ}
    ) x
    where relay_on and gap is not null
    group by 1, 2`;

  // ---------- power stats over the last 24 h (only while ON) ----------
  const stats = await sql<{ load_id: number; avg_p: number; max_p: number; avg_pf: number }[]>`
    select load_id,
           avg(power_w) filter (where relay_on and power_w > 0.5)::float8 as avg_p,
           max(power_w)::float8 as max_p,
           avg(power_factor) filter (where relay_on and power_w > 0.5)::float8 as avg_pf
    from ${M}
    where ts > now() - interval '24 hours'
    group by 1`;

  const [volt] = await sql<{ vmin: number; vavg: number; vmax: number }[]>`
    select min(voltage_v) filter (where voltage_v > 50)::float8 as vmin,
           avg(voltage_v) filter (where voltage_v > 50)::float8 as vavg,
           max(voltage_v)::float8 as vmax
    from ${M} where ts > now() - interval '24 hours'`;

  // ---------- latest reading per load ----------
  const latest = await sql<{ load_id: number; ts: Date; relay_on: boolean; power_w: number }[]>`
    select distinct on (load_id) load_id, ts, relay_on, power_w
    from ${M} where ts > now() - interval '2 days'
    order by load_id, ts desc`;

  // ---------- relay events ----------
  const events = await sql<{ ts: Date; load_id: number; state: boolean; source: string }[]>`
    select ts, load_id, state, source from ${E}
    where ts > now() - interval '24 hours' order by ts desc limit 40`;

  // Last ON event per load (to know how long it has been on)
  const lastOn = await sql<{ load_id: number; ts: Date }[]>`
    select distinct on (load_id) load_id, ts from ${E}
    where state = true order by load_id, ts desc`;

  const [{ now_local, today, yesterday }] = await sql<{ now_local: string; today: string; yesterday: string }[]>`
    select to_char(now() at time zone ${TZ}, 'YYYY-MM-DD HH24:MI') as now_local,
           to_char((now() at time zone ${TZ})::date, 'YYYY-MM-DD') as today,
           to_char((now() at time zone ${TZ})::date - 1, 'YYYY-MM-DD') as yesterday`;

  // ----------------- assemble -----------------
  const fmtLocal = (d: Date) =>
    new Date(d).toLocaleString("en-IN", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

  const days: string[] = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const kwh = (day: string, load: number) => n(daily.find((x) => x.day === day && x.load_id === load)?.kwh);
  const hrs = (day: string, load: number) => n(onTime.find((x) => x.day === day && x.load_id === load)?.hours);
  const prevDays = days.filter((d) => d !== today); // the 7 full days before today

  const lastTs = latest.reduce<Date | null>((a, x) => (!a || x.ts > a ? x.ts : a), null);
  const online = !!lastTs && Date.now() - new Date(lastTs).getTime() < 5 * 60_000;

  const loads: LoadToday[] = [1, 2, 3].map((k) => {
    const lt = latest.find((x) => x.load_id === k);
    const st = stats.find((x) => x.load_id === k);
    const prevK = prevDays.map((d) => kwh(d, k));
    const prevH = prevDays.map((d) => hrs(d, k));
    const daysWithData = prevDays.filter((d) => daily.some((x) => x.day === d));
    const avg = (a: number[]) => (daysWithData.length ? a.reduce((s, x) => s + x, 0) / daysWithData.length : null);
    const isOn = online && !!lt?.relay_on;
    const onEv = lastOn.find((x) => x.load_id === k);
    return {
      load: k,
      name: LOAD_NAMES[k - 1] || `Load ${k}`,
      is_on_now: isOn,
      power_now_w: online ? r(lt?.power_w ?? 0, 1) : null,
      kwh_today: r(kwh(today, k))!,
      cost_today_inr: r(kwh(today, k) * TARIFF, 2)!,
      hours_on_today: r(hrs(today, k), 2)!,
      kwh_yesterday: r(kwh(yesterday, k))!,
      hours_on_yesterday: r(hrs(yesterday, k), 2)!,
      avg_daily_kwh_prev_7d: r(avg(prevK)),
      avg_hours_on_prev_7d: r(avg(prevH), 2),
      avg_power_when_on_w_24h: r(st?.avg_p, 1),
      max_power_w_24h: r(st?.max_p, 1),
      avg_power_factor_24h: r(st?.avg_pf, 2),
      on_since: isOn && onEv ? fmtLocal(onEv.ts) : null,
    };
  });

  const dayRow = (d: string) => {
    const l1 = kwh(d, 1), l2 = kwh(d, 2), l3 = kwh(d, 3);
    return { date: d, l1: r(l1)!, l2: r(l2)!, l3: r(l3)!, total: r(l1 + l2 + l3)! };
  };
  const hourRows = (day: string) => {
    const hours = [...new Set(hourly.filter((h) => h.day === day).map((h) => h.hour))].sort();
    const get = (h: string, k: number) => r(n(hourly.find((x) => x.day === day && x.hour === h && x.load_id === k)?.kwh))!;
    return hours.map((h) => ({ hour: h, l1: get(h, 1), l2: get(h, 2), l3: get(h, 3) }));
  };

  const sum = (f: (k: number) => number) => f(1) + f(2) + f(3);
  const kToday = sum((k) => kwh(today, k));
  const kYest = sum((k) => kwh(yesterday, k));
  const k7 = days.slice(1).reduce((s, d) => s + sum((k) => kwh(d, k)), 0);

  const facts: EnergyFacts = {
    now_local,
    timezone: "IST (UTC+05:30)",
    tariff_inr_per_kwh: TARIFF,
    device_last_data_local: lastTs ? fmtLocal(lastTs) : null,
    device_online: online,
    totals: {
      kwh_today: r(kToday)!, cost_today_inr: r(kToday * TARIFF, 2)!,
      kwh_yesterday: r(kYest)!, cost_yesterday_inr: r(kYest * TARIFF, 2)!,
      kwh_last_7d: r(k7)!, cost_last_7d_inr: r(k7 * TARIFF, 2)!,
    },
    voltage_24h: { min: r(volt?.vmin, 1), avg: r(volt?.vavg, 1), max: r(volt?.vmax, 1) },
    loads,
    daily_kwh_last_8_days: days.map(dayRow),
    hourly_kwh_today: hourRows(today),
    hourly_kwh_yesterday: hourRows(yesterday),
    relay_events_last_24h: events.map((e) => ({
      time: fmtLocal(e.ts), load: e.load_id, state: e.state ? "ON" : "OFF", source: e.source,
    })),
    findings: [],
  };
  facts.findings = detectFindings(facts);
  return facts;
}

// ------------------------------------------------------------
// Rule-based anomaly detection (deterministic, explainable)
// ------------------------------------------------------------
export function detectFindings(f: EnergyFacts): Finding[] {
  const out: Finding[] = [];

  if (!f.device_online) {
    out.push({
      level: "alert", code: "device_offline",
      message: f.device_last_data_local
        ? `No data from the device since ${f.device_last_data_local}.`
        : "No data has been received from the device yet.",
    });
  }

  const vmin = f.voltage_24h.min, vmax = f.voltage_24h.max;
  if (vmax != null && vmax > 253) out.push({ level: "warning", code: "over_voltage", message: `Mains voltage reached ${vmax} V in the last 24 h (above 253 V, +10% of 230 V).` });
  if (vmin != null && vmin < 207) out.push({ level: "warning", code: "under_voltage", message: `Mains voltage dropped to ${vmin} V in the last 24 h (below 207 V, -10% of 230 V).` });

  for (const l of f.loads) {
    // Already ON longer today than it usually is in a whole day
    if (l.avg_hours_on_prev_7d != null && l.avg_hours_on_prev_7d > 0.25 &&
        l.hours_on_today > l.avg_hours_on_prev_7d * 1.5 && l.hours_on_today - l.avg_hours_on_prev_7d > 1) {
      out.push({
        level: "warning", code: "long_runtime", load: l.load,
        message: `${l.name} has been ON ${l.hours_on_today} h today, vs a usual ${l.avg_hours_on_prev_7d} h per day (7-day average).`,
      });
    }
    // Energy today well above its normal full-day usage
    if (l.avg_daily_kwh_prev_7d != null && l.avg_daily_kwh_prev_7d > 0.005 &&
        l.kwh_today > l.avg_daily_kwh_prev_7d * 1.5) {
      out.push({
        level: "warning", code: "high_energy", load: l.load,
        message: `${l.name} used ${l.kwh_today} kWh today, ${Math.round((l.kwh_today / l.avg_daily_kwh_prev_7d) * 100)}% of its usual daily ${l.avg_daily_kwh_prev_7d} kWh.`,
      });
    }
    // Low power factor (only meaningful for loads that draw real power)
    if (l.avg_power_factor_24h != null && l.avg_power_when_on_w_24h != null &&
        l.avg_power_when_on_w_24h > 5 && l.avg_power_factor_24h < 0.7) {
      out.push({
        level: "info", code: "low_pf", load: l.load,
        message: `${l.name} has a low average power factor of ${l.avg_power_factor_24h} (typical of LED drivers, chargers and motors).`,
      });
    }
    // Currently ON for many hours
    if (l.is_on_now && l.hours_on_today >= 6) {
      out.push({ level: "info", code: "on_long", load: l.load, message: `${l.name} is ON now and has run ${l.hours_on_today} h today${l.on_since ? ` (on since ${l.on_since})` : ""}.` });
    }
  }

  // Biggest consumer today
  const top = [...f.loads].sort((a, b) => b.kwh_today - a.kwh_today)[0];
  if (top && f.totals.kwh_today > 0) {
    out.push({
      level: "info", code: "top_consumer", load: top.load,
      message: `${top.name} is the biggest consumer today: ${top.kwh_today} kWh of ${f.totals.kwh_today} kWh (${Math.round((top.kwh_today / f.totals.kwh_today) * 100)}%).`,
    });
  }
  return out;
}

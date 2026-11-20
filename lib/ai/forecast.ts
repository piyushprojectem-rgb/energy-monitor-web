// Server-only. Predicts this month's electricity bill (1st -> last day).
//
// Method (simple, explainable, no black box):
//   1. Actual energy so far this month (from the ESP32's kWh counter).
//   2. Typical daily usage = average of the last 7 complete days that have data.
//   3. Rest of today = on the last 7 days, how much was used AFTER the current
//      time of day (because usage depends on the hour: evenings are heavier).
//   4. Projection = so far + rest of today + typical daily × remaining days.
//   5. Range: ± one standard deviation of daily usage over the last 14 days.
// Bill = kWh × tariff + fixed monthly charge.

import { db, table, TZ } from "@/lib/db";
import { TARIFF } from "./facts";

export const FIXED_CHARGE = Number(process.env.FIXED_CHARGE_INR_PER_MONTH || 0);
const LOAD_NAMES = (process.env.LOAD_NAMES || "Load 1,Load 2,Load 3").split(",").map((s) => s.trim());

export interface Forecast {
  month: string;              // "2026-11"
  month_label: string;        // "November 2026"
  day_of_month: number;
  days_in_month: number;
  days_left_after_today: number;
  tariff_inr_per_kwh: number;
  fixed_charge_inr: number;
  monitoring_started: string | null; // first date with data this month, if after the 1st
  so_far: { kwh: number; bill_inr: number };
  projected: { kwh: number; bill_inr: number; low_kwh: number; high_kwh: number; low_bill_inr: number; high_bill_inr: number };
  typical_daily_kwh: number;
  rest_of_today_kwh: number;
  history_days_used: number;
  confidence: "high" | "medium" | "low";
  per_load: { load: number; name: string; so_far_kwh: number; projected_kwh: number; projected_bill_inr: number; share_pct: number }[];
  last_month: { month_label: string; kwh: number; bill_inr: number; days_with_data: number } | null;
  daily: { date: string; day: number; kwh: number | null; cumulative: number | null; projected_cumulative: number | null; low_cumulative: number | null; high_cumulative: number | null }[];
}

const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const bill = (kwh: number) => r(kwh * TARIFF + FIXED_CHARGE, 2);

export async function getForecast(): Promise<Forecast> {
  const sql = db();
  const D = table("energy_deltas");

  const [{ today, now_time }] = await sql<{ today: string; now_time: string }[]>`
    select to_char((now() at time zone ${TZ})::date, 'YYYY-MM-DD') as today,
           to_char(now() at time zone ${TZ}, 'HH24:MI:SS') as now_time`;

  // Daily kWh per load from the 1st of LAST month to today (a row exists for every day that has data)
  const daily = await sql<{ day: string; load_id: number; kwh: number }[]>`
    select to_char((ts at time zone ${TZ})::date, 'YYYY-MM-DD') as day, load_id, sum(kwh)::float8 as kwh
    from ${D}
    where ts >= (date_trunc('month', (now() at time zone ${TZ})::date) - interval '1 month') at time zone ${TZ}
    group by 1, 2`;

  // Energy used AFTER the current time of day, on each of the last 7 days
  const rest = await sql<{ day: string; load_id: number; kwh: number }[]>`
    select to_char((ts at time zone ${TZ})::date, 'YYYY-MM-DD') as day, load_id, sum(kwh)::float8 as kwh
    from ${D}
    where ts >= ((now() at time zone ${TZ})::date - 7)::timestamp at time zone ${TZ}
      and ts <  ((now() at time zone ${TZ})::date)::timestamp at time zone ${TZ}
      and (ts at time zone ${TZ})::time > ${now_time}::time
    group by 1, 2`;

  // ---------- calendar ----------
  const [y, m, dToday] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthKey = today.slice(0, 7);
  const prevDate = new Date(Date.UTC(y, m - 2, 1));
  const prevKey = prevDate.toISOString().slice(0, 7);
  const monthName = (dt: Date) => dt.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  const kwhOf = (day: string, load: number) => daily.find((x) => x.day === day && x.load_id === load)?.kwh ?? 0;
  const hasData = (day: string) => daily.some((x) => x.day === day);
  const dayStr = (n: number) => `${monthKey}-${String(n).padStart(2, "0")}`;
  const addDays = (s: string, n: number) => {
    const d = new Date(s + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // ---------- history: last 14 complete days with data ----------
  const hist: string[] = [];
  for (let i = 1; i <= 60 && hist.length < 14; i++) {
    const d = addDays(today, -i);
    if (hasData(d)) hist.push(d);
  }
  const hist7 = hist.slice(0, 7);
  const loads = [1, 2, 3];
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

  // Typical daily kWh per load (last 7 days with data)
  let ratePer = loads.map((k) => mean(hist7.map((d) => kwhOf(d, k))));

  // Rest of today per load (average over the same days)
  let restPer = loads.map((k) => mean(hist7.map((d) => rest.find((x) => x.day === d && x.load_id === k)?.kwh ?? 0)));

  // No history yet: extrapolate today's usage by the fraction of the day elapsed
  const todaySoFarPer = loads.map((k) => kwhOf(today, k));
  if (!hist7.length) {
    const [hh, mm] = now_time.split(":").map(Number);
    const frac = Math.max((hh * 60 + mm) / 1440, 0.05);
    ratePer = todaySoFarPer.map((x) => x / frac);
    restPer = todaySoFarPer.map((x, i) => Math.max(ratePer[i] - x, 0));
  }

  // ---------- this month ----------
  const firstDataDay = Array.from({ length: dToday }, (_, i) => dayStr(i + 1)).find(hasData) ?? null;
  const soFarPer = loads.map((k) => Array.from({ length: dToday }, (_, i) => kwhOf(dayStr(i + 1), k)).reduce((s, x) => s + x, 0));
  const daysLeft = daysInMonth - dToday;
  const projPer = loads.map((_, i) => soFarPer[i] + restPer[i] + ratePer[i] * daysLeft);

  const soFar = soFarPer.reduce((s, x) => s + x, 0);
  const rate = ratePer.reduce((s, x) => s + x, 0);
  const restToday = restPer.reduce((s, x) => s + x, 0);
  const proj = projPer.reduce((s, x) => s + x, 0);

  // Range from the day-to-day variation (last 14 days)
  const totals = hist.map((d) => loads.reduce((s, k) => s + kwhOf(d, k), 0));
  let sd: number;
  if (totals.length >= 3) {
    const mu = mean(totals);
    sd = Math.sqrt(totals.reduce((s, x) => s + (x - mu) ** 2, 0) / (totals.length - 1));
  } else {
    sd = rate * 0.3; // little history: assume ±30%
  }
  // Uncertainty of the AVERAGE over the remaining days shrinks with more days, but
  // habits can shift too, so use the plain daily sd (conservative and easy to explain).
  const lowK = Math.max(soFar + Math.max(restToday + (rate - sd) * daysLeft, 0), soFar);
  const highK = soFar + restToday + (rate + sd) * daysLeft;

  // ---------- last month ----------
  const prevDays = daily.filter((x) => x.day.startsWith(prevKey));
  const prevKwh = prevDays.reduce((s, x) => s + x.kwh, 0);
  const prevDaysWithData = new Set(prevDays.map((x) => x.day)).size;

  // ---------- daily series for the chart ----------
  const series: Forecast["daily"] = [];
  let cum = 0;
  for (let n = 1; n <= daysInMonth; n++) {
    const ds = dayStr(n);
    if (n <= dToday) {
      const k = loads.reduce((s, l) => s + kwhOf(ds, l), 0);
      cum += k;
      const last = n === dToday ? r(cum) : null;
      series.push({ date: ds, day: n, kwh: r(k), cumulative: r(cum), projected_cumulative: last, low_cumulative: last, high_cumulative: last });
    } else {
      const k = n - dToday;
      series.push({
        date: ds, day: n, kwh: null, cumulative: null,
        projected_cumulative: r(soFar + restToday + rate * k),
        low_cumulative: r(Math.max(soFar + restToday + (rate - sd) * k, soFar)),
        high_cumulative: r(soFar + restToday + (rate + sd) * k),
      });
    }
  }

  return {
    month: monthKey,
    month_label: monthName(new Date(Date.UTC(y, m - 1, 1))),
    day_of_month: dToday,
    days_in_month: daysInMonth,
    days_left_after_today: daysLeft,
    tariff_inr_per_kwh: TARIFF,
    fixed_charge_inr: FIXED_CHARGE,
    monitoring_started: firstDataDay && firstDataDay !== dayStr(1) ? firstDataDay : null,
    so_far: { kwh: r(soFar), bill_inr: bill(soFar) },
    projected: {
      kwh: r(proj), bill_inr: bill(proj),
      low_kwh: r(lowK), high_kwh: r(highK),
      low_bill_inr: bill(lowK), high_bill_inr: bill(highK),
    },
    typical_daily_kwh: r(rate),
    rest_of_today_kwh: r(restToday),
    history_days_used: hist7.length,
    confidence: hist7.length >= 7 ? "high" : hist7.length >= 3 ? "medium" : "low",
    per_load: loads.map((k, i) => ({
      load: k,
      name: LOAD_NAMES[i] || `Load ${k}`,
      so_far_kwh: r(soFarPer[i]),
      projected_kwh: r(projPer[i]),
      projected_bill_inr: r(projPer[i] * TARIFF, 2),
      share_pct: proj > 0 ? Math.round((projPer[i] / proj) * 100) : 0,
    })),
    last_month: prevDaysWithData
      ? { month_label: monthName(prevDate), kwh: r(prevKwh), bill_inr: bill(prevKwh), days_with_data: prevDaysWithData }
      : null,
    daily: series,
  };
}

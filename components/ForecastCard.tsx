"use client";

import { useCallback, useEffect, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES, useCssVars } from "./charts";

interface Day { date: string; day: number; kwh: number | null; cumulative: number | null; projected_cumulative: number | null; low_cumulative: number | null; high_cumulative: number | null }
interface Forecast {
  month_label: string; day_of_month: number; days_in_month: number; days_left_after_today: number;
  tariff_inr_per_kwh: number; fixed_charge_inr: number; monitoring_started: string | null;
  so_far: { kwh: number; bill_inr: number };
  projected: { kwh: number; bill_inr: number; low_kwh: number; high_kwh: number; low_bill_inr: number; high_bill_inr: number };
  typical_daily_kwh: number; history_days_used: number; confidence: "high" | "medium" | "low";
  per_load: { load: number; name: string; so_far_kwh: number; projected_kwh: number; projected_bill_inr: number; share_pct: number }[];
  last_month: { month_label: string; kwh: number; bill_inr: number; days_with_data: number } | null;
  daily: Day[];
}
interface Resp { forecast: Forecast; explanation: string; tip: string; ai: boolean; note?: string }

const inr = (x: number) => "₹" + (x >= 100 ? Math.round(x).toLocaleString("en-IN") : x.toFixed(2));

// ------------------------------------------------------------
// Demo data (shown with ?demo)
// ------------------------------------------------------------
function demoResp(): Resp {
  const now = new Date();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const d = now.getDate();
  const tariff = 8, rate = 0.62, sd = 0.07;
  const daily: Day[] = [];
  let cum = 0;
  for (let n = 1; n <= dim; n++) {
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(n).padStart(2, "0")}`;
    if (n <= d) {
      const k = n === d ? 0.45 : rate + Math.sin(n * 1.7) * 0.06;
      cum += k;
      const last = n === d ? cum : null;
      daily.push({ date, day: n, kwh: k, cumulative: cum, projected_cumulative: last, low_cumulative: last, high_cumulative: last });
    } else {
      const k = n - d, base = cum + 0.15;
      daily.push({ date, day: n, kwh: null, cumulative: null, projected_cumulative: base + rate * k, low_cumulative: base + (rate - sd) * k, high_cumulative: base + (rate + sd) * k });
    }
  }
  const proj = daily[dim - 1].projected_cumulative!, lo = daily[dim - 1].low_cumulative!, hi = daily[dim - 1].high_cumulative!;
  const shares = [0.74, 0.19, 0.07];
  return {
    ai: true,
    explanation: `So far you have used ${cum.toFixed(1)} kWh (${inr(cum * tariff)}). At your usual 0.62 kWh a day, this month should end at about ${proj.toFixed(1)} kWh — a bill of roughly ${inr(proj * tariff)} (between ${inr(lo * tariff)} and ${inr(hi * tariff)}). Load 1 drives about three-quarters of it.`,
    tip: "Running Load 1 one hour less each evening would save about 3 kWh (≈₹24) over the rest of the month.",
    forecast: {
      month_label: now.toLocaleString("en-IN", { month: "long", year: "numeric" }), day_of_month: d, days_in_month: dim, days_left_after_today: dim - d,
      tariff_inr_per_kwh: tariff, fixed_charge_inr: 0, monitoring_started: null,
      so_far: { kwh: cum, bill_inr: cum * tariff },
      projected: { kwh: proj, bill_inr: proj * tariff, low_kwh: lo, high_kwh: hi, low_bill_inr: lo * tariff, high_bill_inr: hi * tariff },
      typical_daily_kwh: rate, history_days_used: 7, confidence: "high",
      per_load: [1, 2, 3].map((k, i) => ({ load: k, name: `Load ${k}`, so_far_kwh: cum * shares[i], projected_kwh: proj * shares[i], projected_bill_inr: proj * shares[i] * tariff, share_pct: Math.round(shares[i] * 100) })),
      last_month: { month_label: "Last month", kwh: 17.9, bill_inr: 143.2, days_with_data: 30 },
      daily,
    },
  };
}

// ============================================================
export default function ForecastCard({ demo, ready }: { demo: boolean; ready: boolean }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = useCssVars(["--series-1", "--grid", "--text-3", "--text-2", "--surface"]);

  const load = useCallback(async (refresh = false) => {
    if (demo) { setData(demoResp()); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/ai/forecast${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(r.status === 503 ? "Database not connected." : j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [demo]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const f = data?.forecast;
  const t = f?.tariff_inr_per_kwh ?? 0;
  const chart = f?.daily.map((d) => ({
    day: d.day,
    actual: d.cumulative != null ? d.cumulative * t : null,
    projected: d.projected_cumulative != null ? d.projected_cumulative * t : null,
    range: d.low_cumulative != null && d.high_cumulative != null ? [d.low_cumulative * t, d.high_cumulative * t] : null,
    kwh: d.kwh,
  })) ?? [];
  const vsLast = f?.last_month && f.last_month.days_with_data >= 20
    ? Math.round(((f.projected.bill_inr - f.last_month.bill_inr) / f.last_month.bill_inr) * 100)
    : null;

  return (
    <div className="card fc-card">
      <div className="card-head">
        <div>
          <h2 className="section-title"><span className="ai-badge">AI</span> Bill forecast · {f?.month_label ?? "this month"}</h2>
          <p className="section-sub">Actual bill so far and predicted month-end total{f ? ` at ₹${t}/kWh` : ""}</p>
        </div>
        <button className="btn-small" onClick={() => load(true)} disabled={loading}>
          {loading ? <><span className="spinner" />Updating…</> : "Refresh"}
        </button>
      </div>

      {error && <div className="card-note bad"><span>{error}</span></div>}
      {!f && !error && <div className="empty">{loading ? "Calculating forecast…" : "Loading…"}</div>}

      {f && (
        <div className="fc-grid">
          {/* ---------- numbers ---------- */}
          <div className="fc-stats">
            <div className="fc-big">
              <div className="stat-label">Predicted bill</div>
              <div className="fc-amount">{inr(f.projected.bill_inr)}</div>
              <div className="stat-sub">
                Likely {inr(f.projected.low_bill_inr)} – {inr(f.projected.high_bill_inr)} · {f.projected.kwh.toFixed(1)} kWh
              </div>
            </div>

            <div className="fc-row">
              <div>
                <div className="stat-label">So far</div>
                <div className="fc-mid">{inr(f.so_far.bill_inr)}</div>
                <div className="stat-sub">{f.so_far.kwh.toFixed(2)} kWh</div>
              </div>
              <div>
                <div className="stat-label">Per day</div>
                <div className="fc-mid">{inr(f.typical_daily_kwh * t)}</div>
                <div className="stat-sub">{f.typical_daily_kwh.toFixed(2)} kWh typical</div>
              </div>
              {f.last_month && (
                <div>
                  <div className="stat-label">{f.last_month.month_label.split(" ")[0]}</div>
                  <div className="fc-mid">{inr(f.last_month.bill_inr)}</div>
                  <div className="stat-sub">
                    {vsLast != null ? `${vsLast > 0 ? "+" : ""}${vsLast}% this month` : `only ${f.last_month.days_with_data} days of data`}
                  </div>
                </div>
              )}
            </div>

            <div className="fc-progress">
              <div className="fc-progress-label">
                <span>Day {f.day_of_month} of {f.days_in_month}</span>
                <span className={`pill ${f.confidence === "high" ? "good" : f.confidence === "medium" ? "warn" : "bad"}`}>
                  {f.confidence} confidence
                </span>
              </div>
              <div className="fc-bar"><i style={{ width: `${(f.day_of_month / f.days_in_month) * 100}%` }} /></div>
            </div>

            <div className="fc-loads">
              <div className="fc-stack">
                {f.per_load.map((l) => (
                  <i key={l.load} style={{ width: `${l.share_pct}%`, background: `var(${SERIES[l.load - 1].cssVar})` }} title={`${l.name}: ${l.share_pct}%`} />
                ))}
              </div>
              {f.per_load.map((l) => (
                <div className="fc-load" key={l.load}>
                  <span><i className="swatch" style={{ background: `var(${SERIES[l.load - 1].cssVar})` }} />{l.name}</span>
                  <span>{inr(l.projected_bill_inr)} <em>{l.share_pct}%</em></span>
                </div>
              ))}
            </div>
          </div>

          {/* ---------- chart ---------- */}
          <div className="fc-chart">
            <div className="legend">
              <span><i className="swatch" style={{ background: "var(--series-1)" }} />Actual</span>
              <span><i className="swatch dashed" />Predicted</span>
              <span><i className="swatch band" />Likely range</span>
            </div>
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
                  <CartesianGrid stroke={c["--grid"]} vertical={false} />
                  <XAxis dataKey="day" stroke={c["--text-3"]} tickLine={false} axisLine={false} fontSize={11.5} interval="preserveStartEnd" minTickGap={18} />
                  <YAxis stroke={c["--text-3"]} tickLine={false} axisLine={false} fontSize={11.5} width={48}
                    tickFormatter={(v: number) => `₹${Math.round(v)}`} />
                  <Tooltip
                    isAnimationActive={false}
                    cursor={{ stroke: c["--text-3"], strokeDasharray: "3 3" }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload as (typeof chart)[number];
                      return (
                        <div className="tooltip">
                          <div className="t">Day {p.day}</div>
                          {p.actual != null && <div className="row"><span>Bill so far</span><span>{inr(p.actual)}</span></div>}
                          {p.kwh != null && <div className="row"><span>Used this day</span><span>{p.kwh.toFixed(2)} kWh</span></div>}
                          {p.actual == null && p.projected != null && <div className="row"><span>Predicted</span><span>{inr(p.projected)}</span></div>}
                          {p.actual == null && p.range && <div className="row"><span>Range</span><span>{inr(p.range[0])}–{inr(p.range[1])}</span></div>}
                        </div>
                      );
                    }}
                  />
                  <Area dataKey="range" stroke="none" fill={c["--series-1"]} fillOpacity={0.16} isAnimationActive={false} connectNulls={false} activeDot={false} />
                  <Area dataKey="actual" type="monotone" stroke={c["--series-1"]} strokeWidth={2} fill={c["--series-1"]} fillOpacity={0.18} isAnimationActive={false} dot={false} connectNulls={false} />
                  <Line dataKey="projected" type="monotone" stroke={c["--series-1"]} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {data && (
        <div className="fc-text">
          <p>{data.explanation}</p>
          {data.tip && <p className="fc-tip"><span className="ai-level tip">Tip</span> {data.tip}</p>}
          <p className="ai-note">
            {data.ai ? "Explained by Gemini. " : (data.note ? data.note + " " : "")}
            Prediction = used so far + your average of the last {f?.history_days_used || 0} days × days left
            {f?.fixed_charge_inr ? ` + ₹${f.fixed_charge_inr} fixed charge` : ""}.
            {f?.monitoring_started ? ` Monitoring started on ${f.monitoring_started}, so earlier days count as 0.` : ""}
          </p>
        </div>
      )}
    </div>
  );
}

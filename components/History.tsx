"use client";

import { useState } from "react";
import { ChartControls, EnergyBars, hasData, LoadChips, METRICS, MetricChart, Tabs, useChartView } from "./charts";
import type { LoadState, Period, Range } from "@/lib/useHistory";
import type { EnergyRow, MetricPoint } from "./charts";

const RANGES: { id: Range; label: string }[] = [
  { id: "1h", label: "1 h" }, { id: "6h", label: "6 h" }, { id: "24h", label: "24 h" }, { id: "7d", label: "7 days" },
];
const PERIODS: { id: Period; label: string }[] = [
  { id: "hourly", label: "Hourly · 24 h" }, { id: "daily", label: "Daily · 14 days" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const dayMonth = (t: number) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const full = (t: number) => `${dayMonth(t)}, ${hm(t)}`;

// bucket strings from the API: "2026-09-26 14:00" or "2026-09-26"
const bucketDay = (b: string) => `${Number(b.slice(8, 10))} ${MONTHS[Number(b.slice(5, 7)) - 1]}`;
const bucketLabel = (period: Period) => (b: string) => (period === "hourly" ? b.slice(11, 16) : bucketDay(b));
const bucketTooltip = (period: Period) => (b: string) =>
  period === "hourly" ? `${bucketDay(b)}, ${b.slice(11, 16)}–${String((Number(b.slice(11, 13)) + 1) % 24).padStart(2, "0")}:00` : bucketDay(b);

function StateMsg({ state, msg, empty }: { state: LoadState; msg?: string; empty: boolean }) {
  if (state === "loading" && empty) return <div className="empty">Loading…</div>;
  if (state === "no-db")
    return <div className="empty">Database not connected. Set <code>DATABASE_URL</code> in <code>.env</code> and restart.</div>;
  if (state === "error") return <div className="empty">Could not load history{msg ? `: ${msg}` : ""}.</div>;
  return null;
}

// ============================================================
export default function History(props: {
  range: Range; setRange: (r: Range) => void;
  period: Period; setPeriod: (p: Period) => void;
  power: { state: LoadState; points: MetricPoint[]; msg?: string };
  energy: { state: LoadState; rows: EnergyRow[]; msg?: string };
}) {
  const { range, period, power, energy } = props;
  const cv = useChartView();
  const [energyVisible, setEnergyVisible] = useState<boolean[]>([true, true, true]);
  const toggleEnergy = (k: number) =>
    setEnergyVisible((v) => { const n = [...v]; n[k] = !n[k]; return n.some(Boolean) ? n : v; });
  const m = METRICS[cv.view.metric];
  const hasPower = hasData(power.points, cv.view);
  const hasEnergy = energy.rows.some((r) => r.total > 0);
  const total = energy.rows.reduce((s, r) => s + (energyVisible[0] ? r.l1 : 0) + (energyVisible[1] ? r.l2 : 0) + (energyVisible[2] ? r.l3 : 0), 0);
  const tick = range === "7d" ? dayMonth : hm;

  return (
    <section className="history">
      {/* ---------- power history ---------- */}
      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="section-title">{m.label} history</h2>
            <p className="section-sub">Average per load{m.unit ? ` (${m.unit})` : ""}. Gaps = device offline.</p>
          </div>
          <Tabs items={RANGES} value={range} onChange={props.setRange} />
        </div>
        <ChartControls {...cv} />
        <div className="chart-box">
          {power.state === "ok" || (power.state === "loading" && hasPower) ? (
            hasPower ? (
              <MetricChart data={power.points} view={cv.view} tick={tick} tooltipTime={full} />
            ) : (
              <div className="empty">No {m.label.toLowerCase()} data for the selected loads in this period.</div>
            )
          ) : (
            <StateMsg state={power.state} msg={power.msg} empty={!hasPower} />
          )}
        </div>
      </div>

      {/* ---------- energy ---------- */}
      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="section-title">Energy consumption</h2>
            <p className="section-sub">
              kWh per load{energy.state === "ok" && hasEnergy ? ` · ${total.toFixed(3)} kWh in this period` : ""}
            </p>
          </div>
          <Tabs items={PERIODS} value={period} onChange={props.setPeriod} />
        </div>
        <div className="chart-controls"><LoadChips visible={energyVisible} onToggle={toggleEnergy}
          onOnly={(k) => setEnergyVisible([k === 0, k === 1, k === 2])} onAll={() => setEnergyVisible([true, true, true])} /></div>
        {energy.state === "ok" || (energy.state === "loading" && hasEnergy) ? (
          hasEnergy ? (
            <>
              <div className="chart-box short">
                <EnergyBars rows={energy.rows} visible={energyVisible} label={bucketLabel(period)} tooltipLabel={bucketTooltip(period)} />
              </div>
              <div className="table-wrap">
                <table className="energy-table">
                  <thead>
                    <tr>
                      <th>{period === "hourly" ? "Hour" : "Date"}</th>
                      <th>Load 1</th><th>Load 2</th><th>Load 3</th><th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...energy.rows].reverse().map((r) => (
                      <tr key={r.bucket}>
                        <td>{period === "hourly" ? bucketTooltip("hourly")(r.bucket) : bucketDay(r.bucket)}</td>
                        <td>{r.l1.toFixed(3)}</td><td>{r.l2.toFixed(3)}</td><td>{r.l3.toFixed(3)}</td>
                        <td><b>{r.total.toFixed(3)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="chart-box short"><div className="empty">No energy recorded in this period yet.</div></div>
          )
        ) : (
          <div className="chart-box short"><StateMsg state={energy.state} msg={energy.msg} empty={!hasEnergy} /></div>
        )}
      </div>
    </section>
  );
}

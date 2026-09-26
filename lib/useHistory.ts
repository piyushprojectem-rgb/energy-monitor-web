"use client";

import { useCallback, useEffect, useState } from "react";
import type { EnergyRow, PowerPoint } from "@/components/charts";
import type { EventPayload } from "./types";

export type Range = "1h" | "6h" | "24h" | "7d";
export type Period = "hourly" | "daily";
export type LoadState = "loading" | "ok" | "no-db" | "error";

const REFRESH_MS = 60_000;

async function getJson<T>(url: string): Promise<{ state: LoadState; data?: T; msg?: string }> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 503) return { state: "no-db" };
    const j = await r.json();
    if (!r.ok) return { state: "error", msg: j.error ?? `HTTP ${r.status}` };
    return { state: "ok", data: j as T };
  } catch (e) {
    return { state: "error", msg: (e as Error).message };
  }
}

// ------------------------------------------------------------
// Demo mode: plausible fake history so the page can be shown
// without a database.
// ------------------------------------------------------------
const RANGE_S: Record<Range, [number, number]> = {
  "1h": [3600, 60], "6h": [6 * 3600, 120], "24h": [86400, 300], "7d": [7 * 86400, 3600],
};
function demoOn(k: number, t: number) {
  const h = new Date(t).getHours();
  return k === 0 ? h >= 7 && h < 23 : k === 1 ? h >= 18 && h < 22 : h % 3 === 0;
}
function demoPower(range: Range): PowerPoint[] {
  const [span, step] = RANGE_S[range];
  const end = Math.floor(Date.now() / (step * 1000)) * step * 1000;
  const pts: PowerPoint[] = [];
  for (let t = end - span * 1000; t <= end; t += step * 1000) {
    const pt: PowerPoint = { t };
    const v = 230 + Math.sin(t / 3.6e6) * 4;
    [[60, 0.99], [45, 0.82], [9, 0.55]].forEach(([base, pf], k) => {
      const on = demoOn(k, t);
      const p = on ? base * (1 + (Math.random() - 0.5) * 0.04) : 0;
      pt[`p${k + 1}`] = p;
      pt[`i${k + 1}`] = on ? p / (v * pf) : 0;
      pt[`v${k + 1}`] = v + (Math.random() - 0.5);
      pt[`pf${k + 1}`] = on ? pf : null;
    });
    pts.push(pt);
  }
  return pts;
}
function demoEnergy(period: Period): EnergyRow[] {
  const rows: EnergyRow[] = [];
  const n = period === "hourly" ? 24 : 14;
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    if (period === "hourly") d.setHours(d.getHours() - i, 0, 0, 0); else d.setDate(d.getDate() - i);
    const pad = (x: number) => String(x).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    let l1, l2, l3;
    if (period === "hourly") {
      const t = d.getTime();
      l1 = demoOn(0, t) ? 0.06 : 0; l2 = demoOn(1, t) ? 0.045 : 0; l3 = demoOn(2, t) ? 0.009 : 0;
    } else {
      const f = 0.85 + Math.random() * 0.3;
      l1 = 0.96 * f; l2 = 0.18 * f; l3 = 0.07 * f;
      if (i === 0) { const part = new Date().getHours() / 24; l1 *= part; l2 *= part; l3 *= part; }
    }
    rows.push({ bucket: period === "hourly" ? `${day} ${pad(d.getHours())}:00` : day, l1, l2, l3, total: l1 + l2 + l3 });
  }
  return rows;
}
function demoEvents(): EventPayload[] {
  const now = Math.floor(Date.now() / 1000);
  return [
    { load: 2, on: false, src: "dashboard", ts: now - 1800 },
    { load: 3, on: true, src: "serial", ts: now - 5400 },
    { load: 1, on: true, src: "dashboard", ts: now - 9000 },
    { load: 2, on: true, src: "dashboard", ts: now - 12600 },
  ];
}

// ------------------------------------------------------------
export function useHistory(demo: boolean, ready: boolean) {
  const [range, setRange] = useState<Range>("1h");
  const [period, setPeriod] = useState<Period>("hourly");

  const [power, setPower] = useState<{ state: LoadState; points: PowerPoint[]; msg?: string }>({ state: "loading", points: [] });
  const [energy, setEnergy] = useState<{ state: LoadState; rows: EnergyRow[]; msg?: string }>({ state: "loading", rows: [] });
  const [events, setEvents] = useState<EventPayload[]>([]);

  const loadPower = useCallback(async () => {
    if (demo) return setPower({ state: "ok", points: demoPower(range) });
    const r = await getJson<{ points: PowerPoint[] }>(`/api/history?range=${range}`);
    setPower({ state: r.state, points: r.data?.points ?? [], msg: r.msg });
  }, [demo, range]);

  const loadEnergy = useCallback(async () => {
    if (demo) return setEnergy({ state: "ok", rows: demoEnergy(period) });
    const r = await getJson<{ rows: EnergyRow[] }>(`/api/energy?period=${period}`);
    setEnergy({ state: r.state, rows: r.data?.rows ?? [], msg: r.msg });
  }, [demo, period]);

  const loadEvents = useCallback(async () => {
    if (demo) return setEvents(demoEvents());
    const r = await getJson<{ events: EventPayload[] }>(`/api/events?limit=50`);
    if (r.data) setEvents(r.data.events);
  }, [demo]);

  useEffect(() => {
    if (!ready) return;
    setPower((p) => ({ ...p, state: "loading" }));
    loadPower();
    const id = setInterval(loadPower, REFRESH_MS);
    return () => clearInterval(id);
  }, [ready, loadPower]);

  useEffect(() => {
    if (!ready) return;
    setEnergy((e) => ({ ...e, state: "loading" }));
    loadEnergy();
    const id = setInterval(loadEnergy, REFRESH_MS);
    return () => clearInterval(id);
  }, [ready, loadEnergy]);

  useEffect(() => {
    if (!ready) return;
    loadEvents();
    const id = setInterval(loadEvents, REFRESH_MS);
    return () => clearInterval(id);
  }, [ready, loadEvents]);

  return { range, setRange, period, setPeriod, power, energy, dbEvents: events };
}

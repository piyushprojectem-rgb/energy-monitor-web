"use client";

import { useEffect, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// SVG attributes can't read CSS variables, so resolve them in JS
// (and re-resolve when the OS switches light/dark).
export function useCssVars(names: string[]) {
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setVals(Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()])));
    };
    read();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return vals;
}

export const SERIES = [
  { n: 1, name: "Load 1", cssVar: "--series-1" },
  { n: 2, name: "Load 2", cssVar: "--series-2" },
  { n: 3, name: "Load 3", cssVar: "--series-3" },
] as const;

const COLOR_VARS = ["--series-1", "--series-2", "--series-3", "--grid", "--text-3", "--surface"];

// ------------------------------------------------------------
// What can be plotted
// ------------------------------------------------------------
export type Metric = "p" | "i" | "v" | "pf";

export const METRICS: Record<Metric, { label: string; unit: string; digits: number; stackable: boolean }> = {
  p: { label: "Power", unit: "W", digits: 1, stackable: true },
  i: { label: "Current", unit: "A", digits: 3, stackable: false },
  v: { label: "Voltage", unit: "V", digits: 1, stackable: false },
  pf: { label: "Power factor", unit: "", digits: 2, stackable: false },
};

// A point: t + keys like p1, i2, v3, pf1 (null = no data)
export type MetricPoint = { t: number } & Record<string, number | null>;
/** @deprecated kept for older imports */
export type PowerPoint = MetricPoint;

export interface ChartView {
  metric: Metric;
  visible: [boolean, boolean, boolean];
  stacked: boolean;
}
export const DEFAULT_VIEW: ChartView = { metric: "p", visible: [true, true, true], stacked: true };

export function useChartView(initial: ChartView = DEFAULT_VIEW) {
  const [view, setView] = useState<ChartView>(initial);
  const toggleLoad = (k: number) =>
    setView((v) => {
      const next = [...v.visible] as ChartView["visible"];
      next[k] = !next[k];
      if (!next.some(Boolean)) return v; // keep at least one load
      return { ...v, visible: next };
    });
  const onlyLoad = (k: number) =>
    setView((v) => ({ ...v, visible: [k === 0, k === 1, k === 2] }));
  const showAll = () => setView((v) => ({ ...v, visible: [true, true, true] }));
  return {
    view,
    setMetric: (metric: Metric) => setView((v) => ({ ...v, metric })),
    setStacked: (stacked: boolean) => setView((v) => ({ ...v, stacked })),
    toggleLoad, onlyLoad, showAll,
  };
}

// ------------------------------------------------------------
// Controls: metric tabs + load chips + stacked/lines
// ------------------------------------------------------------
export function Tabs<T extends string>(props: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`tabs${props.small ? " small" : ""}`} role="tablist">
      {props.items.map((it) => (
        <button key={it.id} role="tab" aria-selected={props.value === it.id}
          className={props.value === it.id ? "active" : ""} onClick={() => props.onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function LoadChips(props: {
  visible: boolean[];
  onToggle: (k: number) => void;
  onOnly?: (k: number) => void;
  onAll?: () => void;
}) {
  const all = props.visible.every(Boolean);
  return (
    <div className="chips">
      {SERIES.map((s, k) => (
        <button
          key={s.n}
          className={`chip${props.visible[k] ? " on" : ""}`}
          aria-pressed={props.visible[k]}
          onClick={() => props.onToggle(k)}
          onDoubleClick={() => props.onOnly?.(k)}
          title="Click to show/hide · double-click to show only this load"
        >
          <i className="swatch" style={{ background: props.visible[k] ? `var(${s.cssVar})` : "transparent", borderColor: `var(${s.cssVar})` }} />
          {s.name}
        </button>
      ))}
      {!all && props.onAll && (
        <button className="chip link" onClick={props.onAll}>Show all</button>
      )}
    </div>
  );
}

const METRIC_TABS = (Object.keys(METRICS) as Metric[]).map((id) => ({ id, label: METRICS[id].label }));

export function ChartControls(props: ReturnType<typeof useChartView>) {
  const { view } = props;
  const nVisible = view.visible.filter(Boolean).length;
  const canStack = METRICS[view.metric].stackable && nVisible > 1;
  return (
    <div className="chart-controls">
      <Tabs items={METRIC_TABS} value={view.metric} onChange={props.setMetric} small />
      <div className="chart-controls-row">
        <LoadChips visible={view.visible} onToggle={props.toggleLoad} onOnly={props.onlyLoad} onAll={props.showAll} />
        {canStack && (
          <Tabs small
            items={[{ id: "stacked", label: "Stacked" }, { id: "lines", label: "Lines" }]}
            value={view.stacked ? "stacked" : "lines"}
            onChange={(v) => props.setStacked(v === "stacked")}
          />
        )}
      </div>
    </div>
  );
}

// Legend-only (for charts without controls)
export function Legend() {
  return (
    <div className="legend">
      {SERIES.map((s) => (
        <span key={s.n}>
          <i className="swatch" style={{ background: `var(${s.cssVar})` }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

function TooltipBox(props: {
  title: string; values: (number | null)[]; visible: boolean[];
  unit: string; digits: number; showTotal: boolean;
}) {
  const { title, values, visible, unit, digits, showTotal } = props;
  const shown = SERIES.filter((_, k) => visible[k]);
  const total = values.reduce<number>((a, v, k) => a + (visible[k] ? v ?? 0 : 0), 0);
  const fmt = (v: number) => `${v.toFixed(digits)}${unit ? " " + unit : ""}`;
  return (
    <div className="tooltip">
      <div className="t">{title}</div>
      {shown.map((s) => (
        <div className="row" key={s.n}>
          <span><i className="swatch" style={{ background: `var(${s.cssVar})` }} />{s.name}</span>
          <span>{values[s.n - 1] == null ? "—" : fmt(values[s.n - 1]!)}</span>
        </div>
      ))}
      {showTotal && shown.length > 1 && <div className="row total"><span>Total</span><span>{fmt(total)}</span></div>}
    </div>
  );
}

// True if any visible load has at least one value for this metric
export function hasData(data: MetricPoint[], view: ChartView) {
  return data.some((pt) => [1, 2, 3].some((n) => view.visible[n - 1] && pt[`${view.metric}${n}`] != null));
}

// ------------------------------------------------------------
// The time-series chart (live and history)
// ------------------------------------------------------------
export function MetricChart(props: {
  data: MetricPoint[];
  view: ChartView;
  tick: (t: number) => string;
  tooltipTime: (t: number) => string;
}) {
  const c = useCssVars(COLOR_VARS);
  const { data, view, tick, tooltipTime } = props;
  const m = METRICS[view.metric];
  const shown = SERIES.filter((_, k) => view.visible[k]);
  const stacked = m.stackable && view.stacked && shown.length > 1;

  // Voltage sits around 230 V: zoom the axis around the data instead of starting at 0
  const yDomain: [number | string | ((v: number) => number), number | string | ((v: number) => number)] =
    view.metric === "v" ? [(min: number) => Math.floor(min - 2), (max: number) => Math.ceil(max + 2)]
    : view.metric === "pf" ? [0, 1]
    : [0, "auto"];

  const common = {
    data,
    margin: { top: 8, right: 8, bottom: 0, left: -4 },
  };
  // Passed as an array: Recharts does not look inside <></> fragments
  const axes = [
      <CartesianGrid key="grid" stroke={c["--grid"]} vertical={false} />,
      <XAxis key="x"
        dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time"
        tickFormatter={tick}
        stroke={c["--text-3"]} tickLine={false} axisLine={false} fontSize={11.5} minTickGap={48}
      />,
      <YAxis key="y"
        stroke={c["--text-3"]} tickLine={false} axisLine={false} fontSize={11.5} width={48}
        domain={yDomain} allowDataOverflow={false}
        tickFormatter={(v: number) => (view.metric === "i" ? v.toFixed(v < 1 ? 2 : 1) : view.metric === "pf" ? v.toFixed(1) : `${Math.round(v)}`)}
        label={{ value: m.unit || "PF", angle: 0, position: "insideTopLeft", offset: -2, dy: -6, dx: 8, fontSize: 11, fill: c["--text-3"] }}
      />,
      <Tooltip key="tip"
        isAnimationActive={false}
        cursor={{ stroke: c["--text-3"], strokeWidth: 1, strokeDasharray: "3 3" }}
        content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const pt = payload[0].payload as MetricPoint;
          return (
            <TooltipBox title={tooltipTime(label as number)}
              values={[1, 2, 3].map((n) => pt[`${view.metric}${n}`] as number | null)}
              visible={view.visible} unit={m.unit} digits={m.digits} showTotal={view.metric === "p"} />
          );
        }}
      />
  ];

  if (stacked) {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart {...common}>
          {axes}
          {shown.map((s) => (
            <Area
              key={s.n} dataKey={`${view.metric}${s.n}`} name={s.name} stackId="s" type="monotone"
              stroke={c[s.cssVar]} strokeWidth={2} fill={c[s.cssVar]} fillOpacity={0.22}
              isAnimationActive={false} dot={false} connectNulls={false}
              activeDot={{ r: 4, stroke: c["--surface"], strokeWidth: 2 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart {...common}>
        {axes}
        {shown.map((s) => (
          <Line
            key={s.n} dataKey={`${view.metric}${s.n}`} name={s.name} type="monotone"
            stroke={c[s.cssVar]} strokeWidth={2}
            isAnimationActive={false} dot={false} connectNulls={false}
            activeDot={{ r: 4, stroke: c["--surface"], strokeWidth: 2 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Kept for compatibility: stacked power of all loads */
export function StackedPowerChart(props: { data: MetricPoint[]; tick: (t: number) => string; tooltipTime: (t: number) => string }) {
  return <MetricChart {...props} view={DEFAULT_VIEW} />;
}

// ------------------------------------------------------------
// Stacked bars of kWh per load per hour / day
// ------------------------------------------------------------
export interface EnergyRow { bucket: string; l1: number; l2: number; l3: number; total: number }

export function EnergyBars(props: {
  rows: EnergyRow[]; visible?: boolean[];
  label: (b: string) => string; tooltipLabel: (b: string) => string;
}) {
  const c = useCssVars(COLOR_VARS);
  const { rows, label, tooltipLabel } = props;
  const visible = props.visible ?? [true, true, true];
  const shown = SERIES.filter((_, k) => visible[k]);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="18%">
        <CartesianGrid stroke={c["--grid"]} vertical={false} />
        <XAxis
          dataKey="bucket" tickFormatter={label}
          stroke={c["--text-3"]} tickLine={false} axisLine={false} fontSize={11.5} minTickGap={16}
        />
        <YAxis stroke={c["--text-3"]} tickLine={false} axisLine={false} fontSize={11.5} width={50}
          tickFormatter={(v: number) => (v === 0 ? "0" : v < 0.1 ? v.toFixed(3) : v.toFixed(2))} />
        <Tooltip
          isAnimationActive={false}
          cursor={{ fill: c["--grid"], opacity: 0.5 }}
          content={({ active, payload, label: l }) => {
            if (!active || !payload?.length) return null;
            const r = payload[0].payload as EnergyRow;
            return <TooltipBox title={tooltipLabel(l as string)} values={[r.l1, r.l2, r.l3]} visible={visible}
              unit="kWh" digits={3} showTotal />;
          }}
        />
        {shown.map((s, idx) => (
          <Bar
            key={s.n} dataKey={`l${s.n}`} name={s.name} stackId="e" fill={c[s.cssVar]}
            stroke={c["--surface"]} strokeWidth={1}
            radius={idx === shown.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

"use client";

import type { ChartPoint } from "@/lib/useEnergyMonitor";
import { ChartControls, hasData, METRICS, MetricChart, useChartView } from "./charts";

const hms = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

// Live chart (last 5 minutes, straight from MQTT)
export default function PowerChart({ data }: { data: ChartPoint[] }) {
  const cv = useChartView();
  const ready = data.length >= 3 && data[data.length - 1].t - data[0].t >= 3000;
  const m = METRICS[cv.view.metric];

  return (
    <div className="card">
      <h2 className="section-title">Live {m.label.toLowerCase()}</h2>
      <p className="section-sub">Last 5 minutes{m.unit ? ` (${m.unit})` : ""}</p>
      <ChartControls {...cv} />
      <div className="chart-box">
        {!ready ? (
          <div className="empty">Waiting for data from the device…</div>
        ) : hasData(data, cv.view) ? (
          <MetricChart data={data} view={cv.view} tick={hms} tooltipTime={hms} />
        ) : (
          <div className="empty">No {m.label.toLowerCase()} data for the selected loads (are they ON?)</div>
        )}
      </div>
    </div>
  );
}

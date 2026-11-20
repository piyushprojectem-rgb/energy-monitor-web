"use client";

import { useEnergyMonitor, type LogEvent, type Pending } from "@/lib/useEnergyMonitor";
import type { LoadReading } from "@/lib/types";
import PowerChart from "./PowerChart";
import History from "./History";
import AIPanel from "./AIPanel";
import { useHistory } from "@/lib/useHistory";
import type { EventPayload } from "@/lib/types";

const LOAD_NAMES = ["Load 1", "Load 2", "Load 3"];
const DASH = "—";

// ---------- formatting helpers ----------
const fmt = (n: number, d: number) => n.toFixed(d);

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function uptime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Value({ v, unit, muted }: { v: string; unit?: string; muted?: boolean }) {
  return (
    <div className={`metric-value${muted ? " muted" : ""}`}>
      {v}
      {unit && v !== DASH && <span className="unit">{unit}</span>}
    </div>
  );
}

// ============================================================
export default function Dashboard() {
  const m = useEnergyMonitor();
  const h = useHistory(m.demo, m.modeKnown);
  const allEvents = mergeEvents(h.dbEvents, m.events);
  const loads = m.live?.loads ?? [];
  const online = m.deviceOnline;

  // ---------- summary numbers ----------
  const totalPower = loads.reduce((s, l) => s + l.p, 0);
  const energyToday = loads.reduce((s, l) => s + l.eT, 0);
  const activeCount = (m.relays ?? loads.map((l) => l.on)).filter(Boolean).length;

  const volts = loads.filter((l) => l.ok && l.v > 50).map((l) => l.v);
  const avgVolt = volts.length ? volts.reduce((a, b) => a + b, 0) / volts.length : null;

  // Power factor of the active loads combined (power-weighted): ΣP / ΣVI
  const act = loads.filter((l) => l.on && l.ok && l.i > 0);
  const sumS = act.reduce((s, l) => s + l.v * l.i, 0);
  const pf = sumS > 0 ? Math.min(1, act.reduce((s, l) => s + l.p, 0) / sumS) : null;

  // ---------- connection pill ----------
  let pill: { cls: string; text: string };
  if (m.conn === "demo") pill = { cls: "warn", text: "Demo mode · simulated device" };
  else if (m.conn === "error") pill = { cls: "bad", text: "Broker connection error" };
  else if (m.conn === "connecting" || m.conn === "reconnecting")
    pill = { cls: "", text: "Connecting to broker…" };
  else if (online) pill = { cls: "good", text: `Device online · updated ${ago(m.now - m.lastLiveAt)}` };
  else if (m.lastLiveAt) pill = { cls: "bad", text: `Device offline · last seen ${ago(m.now - m.lastLiveAt)}` };
  else pill = { cls: "bad", text: "Device offline" };

  const showNumbers = online;

  return (
    <main className="wrap">
      <header className="header">
        <div className="brand">
          <h1>Energy Monitor</h1>
          <p>3-channel load monitoring &amp; control</p>
        </div>
        <div className="header-right">
          {online && m.live && m.conn !== "demo" && (
            <span className="pill">WiFi {m.live.rssi} dBm · up {uptime(m.live.up)}</span>
          )}
          <span className={`pill ${pill.cls}`}><i className="dot" />{pill.text}</span>
        </div>
      </header>

      {m.conn !== "connected" && m.conn !== "demo" && m.connDetail && (
        <div className="banner bad">
          Could not reach the MQTT broker{m.connDetail ? `: ${m.connDetail}` : ""}. Check the URL and
          dashboard credentials in <code>.env.local</code>.
        </div>
      )}
      {m.conn === "connected" && !online && (
        <div className="banner warn">
          The ESP32 is not sending data. Readings are hidden and controls are disabled until it comes back.
        </div>
      )}

      {/* ---------- summary ---------- */}
      <section className="summary">
        <div className="card stat-hero">
          <div className="stat-label">Total power</div>
          <div className="stat-value">
            {showNumbers ? fmt(totalPower, 1) : DASH}<span className="unit">W</span>
          </div>
          <div className="stat-sub">All loads combined</div>
        </div>
        <div className="card">
          <div className="stat-label">Energy today</div>
          <div className="stat-value">
            {loads.length ? fmt(energyToday, 3) : DASH}<span className="unit">kWh</span>
          </div>
          <div className="stat-sub">Since midnight</div>
        </div>
        <div className="card">
          <div className="stat-label">Active loads</div>
          <div className="stat-value">
            {m.relays || loads.length ? activeCount : DASH}<span className="unit">/ 3</span>
          </div>
          <div className="stat-sub">Relays ON</div>
        </div>
        <div className="card">
          <div className="stat-label">Voltage</div>
          <div className="stat-value">
            {showNumbers && avgVolt ? fmt(avgVolt, 1) : DASH}<span className="unit">V</span>
          </div>
          <div className="stat-sub">Mains supply</div>
        </div>
        <div className="card">
          <div className="stat-label">Power factor</div>
          <div className="stat-value">{showNumbers && pf !== null ? fmt(pf, 2) : DASH}</div>
          <div className="stat-sub">Active loads combined</div>
        </div>
      </section>

      {/* ---------- load cards ---------- */}
      <section className="loads">
        {[0, 1, 2].map((k) => (
          <LoadCard
            key={k}
            index={k}
            reading={loads[k]}
            confirmedOn={m.relays?.[k] ?? loads[k]?.on ?? null}
            pending={m.pending[k]}
            error={m.errors[k]}
            online={online}
            onToggle={(on) => m.setLoad(k + 1, on)}
            onDismiss={() => m.dismissError(k + 1)}
          />
        ))}
      </section>

      {/* ---------- chart + events ---------- */}
      <section className="lower">
        <PowerChart data={m.chart} />
        <EventLog events={allEvents} />
      </section>

      <AIPanel demo={m.demo} ready={m.modeKnown} />

      <History
        range={h.range} setRange={h.setRange}
        period={h.period} setPeriod={h.setPeriod}
        power={h.power} energy={h.energy}
      />
    </main>
  );
}

// ============================================================
function LoadCard(props: {
  index: number;
  reading?: LoadReading;
  confirmedOn: boolean | null;
  pending: Pending | null;
  error: string | null;
  online: boolean;
  onToggle: (on: boolean) => void;
  onDismiss: () => void;
}) {
  const { index, reading: r, confirmedOn, pending, error, online } = props;
  const on = confirmedOn === true;
  const known = confirmedOn !== null && online;
  const live = online && r && r.ok;

  let status: { cls: string; text: string };
  if (!online) status = { cls: "", text: "Unknown" };
  else if (on) status = { cls: "good", text: "ON" };
  else status = { cls: "", text: "OFF" };

  // Values: ON -> live readings; OFF -> 0 (voltage is still the mains); unknown -> dash
  const v = live ? fmt(r!.v, 1) : DASH;
  const i = live ? fmt(on ? r!.i : 0, 3) : DASH;
  const p = live ? fmt(on ? r!.p : 0, 1) : DASH;
  const pf = live && on && r!.i > 0 ? fmt(r!.pf, 2) : DASH;

  let btnText = on ? "Turn OFF" : "Turn ON";
  if (pending) btnText = pending.on ? "Turning ON…" : "Turning OFF…";

  return (
    <div className="card">
      <div className="load-head">
        <div className="load-name">
          <i className="swatch" style={{ background: `var(--series-${index + 1})` }} />
          {LOAD_NAMES[index]}
          {live && on && r!.d && (
            <span className="calc-tag" title={`Calculated as HLW${index + 1} − HLW${index + 2} (shared shunt)`}>
              calculated
            </span>
          )}
        </div>
        <span className={`pill ${status.cls}`}><i className="dot" />{status.text}</span>
      </div>

      <div className="metrics">
        <div><div className="metric-label">Voltage</div><Value v={v} unit="V" /></div>
        <div><div className="metric-label">Current</div><Value v={i} unit="A" muted={!on} /></div>
        <div><div className="metric-label">Power</div><Value v={p} unit="W" muted={!on} /></div>
        <div><div className="metric-label">Power factor</div><Value v={pf} muted={!on} /></div>
      </div>

      <div className="energy-row">
        <span>Today <b>{r ? fmt(r.eT, 3) : DASH} kWh</b></span>
        <span>Total <b>{r ? fmt(r.eTot, 3) : DASH} kWh</b></span>
      </div>

      <button
        className={`btn${on ? " off" : ""}${pending ? " busy" : ""}`}
        disabled={!known || !!pending}
        onClick={() => props.onToggle(!on)}
      >
        {pending && <span className="spinner" />}
        {btnText}
      </button>

      {error && (
        <div className="card-note bad">
          <span>{error}. The relay state shown is what the device last reported.</span>
          <button onClick={props.onDismiss} aria-label="Dismiss">×</button>
        </div>
      )}
      {online && r && !r.ok && (
        <div className="card-note warn"><span>HLW{index + 1} sensor is not sending valid data.</span></div>
      )}
    </div>
  );
}

// ============================================================
function EventLog({ events }: { events: LogEvent[] }) {
  return (
    <div className="card">
      <h2 className="section-title">Relay events</h2>
      <p className="section-sub">Latest switching, confirmed by the device</p>
      {events.length === 0 ? (
        <div className="empty">No switching yet</div>
      ) : (
        <ul className="events">
          {events.map((e) => {
            const t = e.ts > 0 ? e.ts * 1000 : e.receivedAt;
            return (
              <li key={e.key}>
                <span className="time">
                  {new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                </span>
                <span className="what">
                  <i className="swatch" style={{ background: `var(--series-${e.load})` }} />
                  {LOAD_NAMES[e.load - 1]}
                  <span className="src">· {e.src}</span>
                </span>
                <span className={`tag ${e.on ? "on" : "off"}`}>{e.on ? "ON" : "OFF"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Stored events (database) + events that arrived live over MQTT, newest first, no duplicates
function mergeEvents(stored: EventPayload[], live: LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  const out: LogEvent[] = [];
  const add = (e: EventPayload, receivedAt: number) => {
    const k = `${e.load}-${e.on}-${e.ts}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...e, key: k, receivedAt });
  };
  live.forEach((e) => add(e, e.receivedAt));
  stored.forEach((e) => add(e, e.ts * 1000));
  const time = (e: LogEvent) => (e.ts > 0 ? e.ts * 1000 : e.receivedAt);
  return out.sort((a, b) => time(b) - time(a)).slice(0, 50);
}

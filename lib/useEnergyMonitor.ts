"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createDemoTransport, createMqttTransport } from "./transport";
import {
  TOPIC,
  type AckPayload, type ConnState, type EventPayload, type LivePayload,
  type StatePayload, type Transport,
} from "./types";

const COMMAND_TIMEOUT_MS = 5000;   // no ack in 5 s -> "no response"
const STALE_MS = 10_000;           // no live data in 10 s -> device offline
const HISTORY_POINTS = 150;        // 150 x 2 s = 5 minutes of chart

export interface Pending { on: boolean; id: string }
export interface LogEvent extends EventPayload { key: string; receivedAt: number }
// One chart point: p = power, i = current, v = voltage, pf = power factor, per load 1..3
// (pf is null while a load is OFF so its line breaks instead of dropping to 0)
export type ChartPoint = { t: number } & Record<string, number | null>;

export function useEnergyMonitor() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [connDetail, setConnDetail] = useState<string>();
  const [statusMsg, setStatusMsg] = useState<"online" | "offline" | null>(null);
  const [live, setLive] = useState<LivePayload | null>(null);
  const [lastLiveAt, setLastLiveAt] = useState(0);
  const [relays, setRelays] = useState<boolean[] | null>(null);  // confirmed by ESP32
  const [pending, setPending] = useState<(Pending | null)[]>([null, null, null]);
  const [errors, setErrors] = useState<(string | null)[]>([null, null, null]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [chart, setChart] = useState<ChartPoint[]>([]);
  const [now, setNow] = useState(Date.now());

  const transport = useRef<Transport | null>(null);
  const timers = useRef<(ReturnType<typeof setTimeout> | null)[]>([null, null, null]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const [demo, setDemo] = useState(false);
  const [modeKnown, setModeKnown] = useState(false);   // demo vs real decided

  // ---------- incoming messages ----------
  const onMessage = useCallback((topic: string, raw: string) => {
    try {
      switch (topic) {
        case TOPIC.status:
          setStatusMsg(raw === "online" ? "online" : "offline");
          break;

        case TOPIC.state: {
          const s = JSON.parse(raw) as StatePayload;
          setRelays(s.r.map(Boolean));
          break;
        }

        case TOPIC.live: {
          const l = JSON.parse(raw) as LivePayload;
          setLive(l);
          setLastLiveAt(Date.now());
          setRelays(l.loads.map((x) => x.on));
          setChart((c) => {
            const pt: ChartPoint = { t: Date.now() };
            l.loads.slice(0, 3).forEach((x, k) => {
              const n = k + 1;
              pt[`p${n}`] = x.p;
              pt[`i${n}`] = x.i;
              pt[`v${n}`] = x.ok ? x.v : null;
              pt[`pf${n}`] = x.on && x.i > 0 ? x.pf : null;
            });
            // Two messages can arrive almost together (e.g. right after a relay switch):
            // keep one point per second so chart timestamps stay unique.
            const last = c[c.length - 1];
            const next = last && pt.t - last.t < 1000 ? [...c.slice(0, -1), pt] : [...c, pt];
            return next.length > HISTORY_POINTS ? next.slice(-HISTORY_POINTS) : next;
          });
          break;
        }

        case TOPIC.ack: {
          const a = JSON.parse(raw) as AckPayload;
          const k = a.load - 1;
          if (k < 0 || k > 2) break;
          if (pendingRef.current[k]?.id !== a.id) break;   // not our command
          if (timers.current[k]) clearTimeout(timers.current[k]!);
          setPending((p) => p.map((x, j) => (j === k ? null : x)));
          setErrors((e) => e.map((x, j) => (j === k ? (a.ok ? null : a.err || "Command rejected") : x)));
          break;
        }

        case TOPIC.event: {
          const e = JSON.parse(raw) as EventPayload;
          setEvents((list) =>
            [{ ...e, key: Math.random().toString(36).slice(2), receivedAt: Date.now() }, ...list].slice(0, 50),
          );
          break;
        }
      }
    } catch {
      /* ignore malformed message */
    }
  }, []);

  // ---------- connect ----------
  useEffect(() => {
    const wantDemo =
      !process.env.NEXT_PUBLIC_MQTT_URL ||
      new URLSearchParams(window.location.search).has("demo");
    setDemo(wantDemo);
    setModeKnown(true);

    const onConn = (s: ConnState, d?: string) => {
      setConn(s);
      // keep the last error visible while it keeps retrying
      if (s === "connected" || s === "demo") setConnDetail(undefined);
      else if (d) setConnDetail(d);
    };
    transport.current = wantDemo
      ? createDemoTransport(onMessage, onConn)
      : createMqttTransport(onMessage, onConn);

    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      transport.current?.close();
      timers.current.forEach((t) => t && clearTimeout(t));
    };
  }, [onMessage]);

  // ---------- send command ----------
  const setLoad = useCallback((load: number, on: boolean) => {
    const k = load - 1;
    if (!transport.current || pendingRef.current[k]) return;

    const id = Math.random().toString(36).slice(2, 8);
    setPending((p) => p.map((x, j) => (j === k ? { on, id } : x)));
    setErrors((e) => e.map((x, j) => (j === k ? null : x)));
    transport.current.publish(TOPIC.cmd, { load, on, id });

    timers.current[k] = setTimeout(() => {
      setPending((p) => p.map((x, j) => (j === k && x?.id === id ? null : x)));
      setErrors((e) => e.map((x, j) => (j === k ? "No response from device" : x)));
    }, COMMAND_TIMEOUT_MS);
  }, []);

  const dismissError = useCallback((load: number) => {
    setErrors((e) => e.map((x, j) => (j === load - 1 ? null : x)));
  }, []);

  // Device is online only if it said so AND data is still arriving
  const fresh = lastLiveAt > 0 && now - lastLiveAt < STALE_MS;
  const deviceOnline = conn !== "error" && statusMsg !== "offline" && fresh;

  return {
    demo, modeKnown, conn, connDetail, deviceOnline, statusMsg,
    live, lastLiveAt, now, relays, pending, errors, events, chart,
    setLoad, dismissError,
  };
}

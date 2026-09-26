import mqtt from "mqtt";
import { TOPIC, type ConnState, type Transport, type LoadReading } from "./types";

type OnMessage = (topic: string, payload: string) => void;
type OnConn = (s: ConnState, detail?: string) => void;

// ------------------------------------------------------------
// Real device: browser connects straight to HiveMQ over WSS
// ------------------------------------------------------------
export function createMqttTransport(onMessage: OnMessage, onConn: OnConn): Transport {
  const url = process.env.NEXT_PUBLIC_MQTT_URL!;
  const client = mqtt.connect(url, {
    username: process.env.NEXT_PUBLIC_MQTT_USERNAME,
    password: process.env.NEXT_PUBLIC_MQTT_PASSWORD,
    clientId: "dash-" + Math.random().toString(16).slice(2, 10),
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10_000,
    keepalive: 30,
  });

  onConn("connecting");
  // Diagnostics: open the browser console (F12) to see these
  console.info("[MQTT] connecting to", url, "as", process.env.NEXT_PUBLIC_MQTT_USERNAME);

  client.on("connect", () => {
    console.info("[MQTT] connected");
    onConn("connected");
    client.subscribe(
      [TOPIC.status, TOPIC.state, TOPIC.live, TOPIC.event, TOPIC.ack],
      { qos: 1 },
    );
  });
  client.on("reconnect", () => { console.info("[MQTT] reconnecting..."); onConn("reconnecting"); });
  client.on("close", () => console.info("[MQTT] connection closed"));
  client.on("error", (err) => { console.error("[MQTT] error:", err.message); onConn("error", err.message); });
  client.on("message", (topic, buf) => onMessage(topic, buf.toString()));

  return {
    publish: (topic, payload) => client.publish(topic, JSON.stringify(payload), { qos: 1 }),
    close: () => client.end(true),
  };
}

// ------------------------------------------------------------
// Demo: a fake ESP32 in the browser, same messages as the real one
// ------------------------------------------------------------
const DEMO_LOADS = [
  { base: 60, pf: 0.99, jitter: 1.5 },  // bulb
  { base: 45, pf: 0.82, jitter: 4 },    // fan
  { base: 9, pf: 0.55, jitter: 0.4 },   // LED lamp
];

export function createDemoTransport(onMessage: OnMessage, onConn: OnConn): Transport {
  const relays = [true, false, true];
  const eT = [0.042, 0.011, 0.006];
  const eTot = [1.284, 0.537, 0.211];
  const start = Date.now();
  let closed = false;

  const emit = (topic: string, obj: unknown) => {
    if (!closed) onMessage(topic, typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  const now = () => Math.floor(Date.now() / 1000);

  const reading = (k: number): LoadReading => {
    const v = 230 + Math.sin(Date.now() / 20000) * 3 + (Math.random() - 0.5);
    const on = relays[k];
    const L = DEMO_LOADS[k];
    const p = on ? L.base + (Math.random() - 0.5) * 2 * L.jitter : 0;
    const pf = on ? L.pf + (Math.random() - 0.5) * 0.02 : 0;
    const i = on ? p / (v * pf) : 0;
    return {
      id: k + 1, on, ok: true, d: relays.slice(k + 1).some(Boolean),
      v: +v.toFixed(2), i: +i.toFixed(3), p: +p.toFixed(2), pf: +pf.toFixed(2),
      eT: +eT[k].toFixed(3), eTot: +eTot[k].toFixed(3),
    };
  };

  const live = () => {
    const loads = [0, 1, 2].map(reading);
    loads.forEach((l, k) => { eT[k] += (l.p * 2) / 3.6e6; eTot[k] += (l.p * 2) / 3.6e6; });
    emit(TOPIC.live, { ts: now(), up: Math.floor((Date.now() - start) / 1000) + 3600, rssi: -58, loads });
  };
  const state = () => emit(TOPIC.state, { r: relays.map((r) => (r ? 1 : 0)), ts: now() });

  onConn("demo");
  setTimeout(() => { emit(TOPIC.status, "online"); state(); live(); }, 300);
  const timer = setInterval(live, 2000);

  return {
    publish(topic, payload) {
      if (topic !== TOPIC.cmd) return;
      const cmd = payload as { load: number; on: boolean; id: string };
      // relay takes a moment, like the real thing
      setTimeout(() => {
        const k = cmd.load - 1;
        const changed = relays[k] !== cmd.on;
        relays[k] = cmd.on;
        emit(TOPIC.ack, { id: cmd.id, load: cmd.load, on: cmd.on, ok: true });
        if (changed) emit(TOPIC.event, { load: cmd.load, on: cmd.on, src: "dashboard", ts: now() });
        state();
        live();
      }, 350 + Math.random() * 300);
    },
    close() { closed = true; clearInterval(timer); },
  };
}

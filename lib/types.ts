// Message shapes — these match the ESP32 firmware exactly.

export const TOPIC = {
  status: "em/status", // retained "online" | "offline"
  state: "em/state",   // retained {"r":[1,0,0],"ts":...}
  live: "em/live",     // every 2 s
  event: "em/event",   // relay changed
  ack: "em/ack",       // reply to a command
  cmd: "em/cmd",       // dashboard -> ESP32
} as const;

export interface LoadReading {
  id: number;
  on: boolean;
  ok: boolean;   // HLW chip sending valid data
  d?: boolean;   // derived: calculated by subtraction (shared shunt)
  v: number;
  i: number;
  p: number;
  pf: number;
  eT: number;    // kWh today
  eTot: number;  // kWh total
}

export interface LivePayload {
  ts: number;    // epoch seconds (0 if ESP32 clock not synced yet)
  up: number;    // uptime seconds
  rssi: number;
  loads: LoadReading[];
}

export interface StatePayload { r: number[]; ts: number }
export interface AckPayload { id: string; load: number; on?: boolean; ok: boolean; err?: string }
export interface EventPayload { load: number; on: boolean; src: string; ts: number }
export interface CommandPayload { load: number; on: boolean; id: string }

export type ConnState = "connecting" | "connected" | "reconnecting" | "error" | "demo";

export interface Transport {
  publish(topic: string, payload: object): void;
  close(): void;
}

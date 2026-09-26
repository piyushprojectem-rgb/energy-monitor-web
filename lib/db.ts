// Server-only: direct Postgres connection to Supabase.
// Used by the API routes in app/api/*. Never imported by browser code.

import postgres from "postgres";

export const SCHEMA = process.env.DB_SCHEMA || "piyusem";
export const TZ = "Asia/Kolkata";

declare global {
  // eslint-disable-next-line no-var
  var __emSql: ReturnType<typeof postgres> | undefined;
}

export function dbConfigured() {
  return !!process.env.DATABASE_URL;
}

// One shared connection pool (re-used across hot reloads in dev)
export function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!globalThis.__emSql) {
    const url = process.env.DATABASE_URL;
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    globalThis.__emSql = postgres(url, {
      ssl: local ? false : "require",
      prepare: false,      // required for Supabase's pooler (port 6543)
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return globalThis.__emSql;
}

// "piyusem.measurements" as a safely quoted identifier
export function table(name: "measurements" | "relay_events" | "energy_deltas") {
  return db()(`${SCHEMA}.${name}`);
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

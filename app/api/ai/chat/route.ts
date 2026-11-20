// POST /api/ai/chat   { messages: [{ role: "user" | "model", text }] }
// Answers questions about the user's energy data using Gemini.
// The facts are re-read from the database on every question, so answers are current.

import { dbConfigured, jsonError } from "@/lib/db";
import { getEnergyFacts } from "@/lib/ai/facts";
import { aiErrorResponse, generate, type Turn } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TURNS = 10;
const MAX_CHARS = 500;

// Very small rate limit per visitor (best effort on serverless) to protect the free quota
declare global {
  // eslint-disable-next-line no-var
  var __emRate: Map<string, number[]> | undefined;
}
function rateLimited(ip: string) {
  const map = (globalThis.__emRate ??= new Map());
  const now = Date.now();
  const recent = (map.get(ip) ?? []).filter((t: number) => now - t < 60_000);
  recent.push(now);
  map.set(ip, recent);
  return recent.length > 8; // max 8 questions per minute
}

const SYSTEM = (factsJson: string) => `You are "Energy Assistant", built into a college project: a 3-load smart energy monitor
(ESP32 with three HLW8032 meters and three relays; dashboard on Next.js; data in Supabase).

Answer the user's questions about their electricity use using ONLY the facts below.
- Never invent numbers. If something is not in the facts (e.g. data older than 8 days, minute-level detail), say you don't have it.
- Costs in Indian rupees (₹) using tariff_inr_per_kwh. You may do simple arithmetic on the given numbers (sums, differences, percentages, cost = kWh × tariff); show the result rounded sensibly.
- Times are IST. "Today" means the date in now_local.
- Readings for loads marked as calculated come from subtracting meters (shared shunts), so their current/PF are approximate — mention only if relevant.
- Keep answers short: 1-4 sentences, or a few "- " bullet points for lists. You may use **bold** for key numbers. No tables, no headings.
- You cannot switch relays; if asked, tell the user to use the buttons on the dashboard.
- Politely decline questions unrelated to this energy monitor or electricity.

FACTS (JSON):
${factsJson}`;

export async function POST(req: Request) {
  if (!dbConfigured()) return jsonError("Database not configured", 503);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) return jsonError("Too many questions. Please wait a minute.", 429);

  let body: { messages?: Turn[] };
  try {
    body = await req.json();
  } catch {
    return jsonError("Bad JSON", 400);
  }

  const turns = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "model") && typeof m.text === "string" && m.text.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, text: m.text.slice(0, m.role === "user" ? MAX_CHARS : 2000) }));
  // Conversation must start with the user and end with a user question
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return jsonError("No question given", 400);

  let facts;
  try {
    facts = await getEnergyFacts();
  } catch (e) {
    console.error("[chat] db error:", e);
    return jsonError("Database error", 500);
  }

  try {
    const { text, model } = await generate({
      system: SYSTEM(JSON.stringify(facts)),
      turns,
      temperature: 0.3,
    });
    return Response.json({ answer: text, model });
  } catch (e) {
    return aiErrorResponse(e);
  }
}

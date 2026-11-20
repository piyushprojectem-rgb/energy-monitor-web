// GET /api/ai/insights[?refresh=1]
// A short AI summary of today's usage + the rule-based findings, rewritten in plain language.
// Cached for 10 minutes so the Gemini free tier is not used up by page reloads.

import { dbConfigured, jsonError } from "@/lib/db";
import { getEnergyFacts, type Finding } from "@/lib/ai/facts";
import { aiConfigured, AIError, generate } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_MS = 10 * 60_000;

interface Item { level: "alert" | "warning" | "info" | "tip"; title: string; text: string }
interface Insights { generatedAt: number; summary: string; items: Item[]; ai: boolean; model?: string; note?: string }

declare global {
  // eslint-disable-next-line no-var
  var __emInsights: Insights | undefined;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          level: { type: "STRING", enum: ["alert", "warning", "info", "tip"] },
          title: { type: "STRING" },
          text: { type: "STRING" },
        },
        required: ["level", "title", "text"],
      },
    },
  },
  required: ["summary", "items"],
};

const SYSTEM = `You are the energy assistant inside a college project: a 3-load smart energy monitor (ESP32 + HLW8032 meters + relays).
You receive a JSON object of facts computed from the database. Write a short daily briefing for the user.

Rules:
- Use ONLY numbers that appear in the facts. Never estimate or invent values. Costs are in Indian rupees (₹).
- "summary": 2-3 short sentences about today so far (total kWh, cost, biggest consumer, comparison with yesterday or the 7-day average).
- "items": 2-5 items. First, every entry of "findings" with level alert/warning, rewritten clearly (keep its level).
  Then at most 2 practical saving "tip" items based on the data (e.g. which load to switch off earlier and roughly how much it would save, using the tariff).
- Titles max 6 words. Each text max 30 words. Plain text, no markdown.
- If there is very little data, say so honestly.`;

function fallbackFromRules(findings: Finding[], f: Awaited<ReturnType<typeof getEnergyFacts>>, note: string): Insights {
  const top = [...f.loads].sort((a, b) => b.kwh_today - a.kwh_today)[0];
  const summary =
    f.totals.kwh_today > 0
      ? `Today so far: ${f.totals.kwh_today} kWh (₹${f.totals.cost_today_inr}). Yesterday: ${f.totals.kwh_yesterday} kWh. Biggest consumer: ${top.name}.`
      : "No energy has been used today yet.";
  return {
    generatedAt: Date.now(),
    summary,
    items: findings.map((x) => ({
      level: x.level,
      title: x.code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      text: x.message,
    })),
    ai: false,
    note,
  };
}

export async function GET(req: Request) {
  if (!dbConfigured()) return jsonError("Database not configured", 503);

  const refresh = new URL(req.url).searchParams.has("refresh");
  const cached = globalThis.__emInsights;
  if (!refresh && cached && Date.now() - cached.generatedAt < CACHE_MS) {
    return Response.json({ ...cached, cached: true });
  }

  let facts;
  try {
    facts = await getEnergyFacts();
  } catch (e) {
    console.error("[insights] db error:", e);
    return jsonError("Database error", 500);
  }

  if (!aiConfigured()) {
    return Response.json(fallbackFromRules(facts.findings, facts, "AI is off (GEMINI_API_KEY not set) — showing rule-based checks only."));
  }

  try {
    const { text, model } = await generate({
      system: SYSTEM,
      turns: [{ role: "user", text: "Facts (JSON):\n" + JSON.stringify(facts) }],
      json: true,
      schema: SCHEMA,
      temperature: 0.2,
    });
    const parsed = JSON.parse(text) as { summary: string; items: Item[] };
    const result: Insights = {
      generatedAt: Date.now(),
      summary: String(parsed.summary ?? ""),
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 6) : [],
      ai: true,
      model,
    };
    globalThis.__emInsights = result;
    return Response.json(result);
  } catch (e) {
    // AI unavailable (quota, network...): still show the rule-based checks
    const msg = e instanceof AIError ? e.message : "AI response could not be read.";
    if (!(e instanceof AIError)) console.error("[insights] ai error:", e);
    return Response.json(fallbackFromRules(facts.findings, facts, msg + " Showing rule-based checks only."));
  }
}

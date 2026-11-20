// GET /api/ai/forecast[?refresh=1]
// This month's bill: actual so far + predicted month-end total (with range),
// plus a short Gemini explanation. Explanation cached 30 min to save quota.

import { dbConfigured, jsonError } from "@/lib/db";
import { getForecast, type Forecast } from "@/lib/ai/forecast";
import { aiConfigured, AIError, generate } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_MS = 30 * 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __emForecastAI: { at: number; month: string; explanation: string; tip: string; model: string } | undefined;
}

const SCHEMA = {
  type: "OBJECT",
  properties: { explanation: { type: "STRING" }, tip: { type: "STRING" } },
  required: ["explanation", "tip"],
};

const SYSTEM = `You explain an electricity bill forecast in a college energy-monitor project (3 loads, India, ₹).
You get a JSON forecast computed by the server. Use ONLY its numbers; never invent or recompute differently.
"explanation": 2-3 short sentences: bill so far, predicted month-end bill and its range, which load drives most of it,
and a comparison with last month if available (note if last month had only a few days of data). Mention if confidence is low.
"tip": one practical sentence on how to bring the bill down (e.g. using the top load 1 hour less per day saves about X kWh/₹ this month —
you may compute this as projected_kwh / days_in_month approximations ONLY if simple; otherwise give a qualitative tip).
Plain text, no markdown.`;

function fallbackText(f: Forecast) {
  const top = [...f.per_load].sort((a, b) => b.projected_kwh - a.projected_kwh)[0];
  return {
    explanation:
      `So far this month you have used ${f.so_far.kwh} kWh (₹${f.so_far.bill_inr}). ` +
      `At your usual ${f.typical_daily_kwh} kWh per day, ${f.month_label} should end at about ${f.projected.kwh} kWh, ` +
      `a bill of ₹${f.projected.bill_inr} (range ₹${f.projected.low_bill_inr}–₹${f.projected.high_bill_inr}).`,
    tip: `${top.name} is expected to make up ${top.share_pct}% of the bill; using it less is the quickest saving.`,
  };
}

export async function GET(req: Request) {
  if (!dbConfigured()) return jsonError("Database not configured", 503);
  const refresh = new URL(req.url).searchParams.has("refresh");

  let f: Forecast;
  try {
    f = await getForecast();
  } catch (e) {
    console.error("[forecast] db error:", e);
    return jsonError("Database error", 500);
  }

  // Numbers are always fresh; only the AI text is cached
  const c = globalThis.__emForecastAI;
  if (!refresh && c && c.month === f.month && Date.now() - c.at < CACHE_MS) {
    return Response.json({ forecast: f, explanation: c.explanation, tip: c.tip, ai: true, model: c.model, aiAt: c.at });
  }

  if (!aiConfigured()) {
    return Response.json({ forecast: f, ...fallbackText(f), ai: false, note: "AI is off (GEMINI_API_KEY not set)." });
  }

  try {
    const { daily, ...compact } = f; // the daily list is not needed for the text
    const { text, model } = await generate({
      system: SYSTEM,
      turns: [{ role: "user", text: "Forecast (JSON):\n" + JSON.stringify({ ...compact, days_with_data_this_month: daily.filter((d) => (d.kwh ?? 0) > 0).length }) }],
      json: true,
      schema: SCHEMA,
      temperature: 0.2,
      maxTokens: 2048,
    });
    const p = JSON.parse(text) as { explanation: string; tip: string };
    globalThis.__emForecastAI = { at: Date.now(), month: f.month, explanation: String(p.explanation ?? ""), tip: String(p.tip ?? ""), model };
    return Response.json({ forecast: f, explanation: p.explanation, tip: p.tip, ai: true, model, aiAt: Date.now() });
  } catch (e) {
    const msg = e instanceof AIError ? e.message : "AI response could not be read.";
    if (!(e instanceof AIError)) console.error("[forecast] ai error:", e);
    return Response.json({ forecast: f, ...fallbackText(f), ai: false, note: msg });
  }
}

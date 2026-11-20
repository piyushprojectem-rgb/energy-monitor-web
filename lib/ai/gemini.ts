// Server-only. Minimal Google Gemini client (REST, no extra package).
//
// Env:
//   GEMINI_API_KEY   from https://aistudio.google.com/apikey  (required)
//   GEMINI_MODEL     optional, default "gemini-flash-latest"
//                    (Google's alias that always points to the current Flash model,
//                     so the app keeps working when old models are retired)

const BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const FALLBACK_MODEL = "gemini-flash-lite-latest";

export class AIError extends Error {
  constructor(public code: "no_key" | "quota" | "blocked" | "failed", message: string) {
    super(message);
  }
}

export function aiConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

export interface Turn { role: "user" | "model"; text: string }

interface Options {
  system: string;
  turns: Turn[];
  json?: boolean;                 // ask for JSON output
  schema?: Record<string, unknown>; // JSON schema for the output
  maxTokens?: number;
  temperature?: number;
}

async function callModel(model: string, o: Options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: o.system }] },
        contents: o.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: {
          temperature: o.temperature ?? 0.3,
          maxOutputTokens: o.maxTokens ?? 4096,
          ...(o.json ? { responseMimeType: "application/json" } : {}),
          ...(o.schema ? { responseSchema: o.schema } : {}),
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function generate(o: Options): Promise<{ text: string; model: string }> {
  if (!aiConfigured()) throw new AIError("no_key", "GEMINI_API_KEY is not set");

  const primary = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const models = primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];
  let lastErr = "";

  for (const model of models) {
    let r;
    try {
      r = await callModel(model, o);
    } catch (e) {
      lastErr = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
      continue;
    }

    if (r.status === 200) {
      const cand = r.body?.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought)
        .map((p: { text: string }) => p.text)
        .join("")
        .trim();
      if (text) return { text, model };
      if (r.body?.promptFeedback?.blockReason || cand?.finishReason === "SAFETY")
        throw new AIError("blocked", "The answer was blocked by Gemini's safety filter.");
      lastErr = `empty answer (${cand?.finishReason ?? "unknown"})`;
      continue;
    }

    const msg = r.body?.error?.message || `HTTP ${r.status}`;
    if (r.status === 429) throw new AIError("quota", "Gemini free-tier limit reached. Try again in a minute.");
    if (r.status === 400 && /api key/i.test(msg)) throw new AIError("no_key", "GEMINI_API_KEY is not valid.");
    if (r.status === 403) throw new AIError("no_key", "GEMINI_API_KEY is not allowed to use this model: " + msg);
    lastErr = `${model}: ${msg}`;
    // 404 (model not found), 5xx (overloaded): try the fallback model
  }
  throw new AIError("failed", "Gemini request failed: " + lastErr);
}

/** Map an error to an HTTP response for the API routes */
export function aiErrorResponse(e: unknown) {
  if (e instanceof AIError) {
    const status = e.code === "no_key" ? 503 : e.code === "quota" ? 429 : 502;
    return Response.json({ error: e.message, code: e.code }, { status });
  }
  console.error("[ai] error:", e);
  return Response.json({ error: "Something went wrong while asking the AI.", code: "failed" }, { status: 500 });
}

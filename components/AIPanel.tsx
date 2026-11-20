"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

interface Item { level: "alert" | "warning" | "info" | "tip"; title: string; text: string }
interface Insights { generatedAt: number; summary: string; items: Item[]; ai: boolean; model?: string; note?: string; cached?: boolean }
interface Msg { role: "user" | "model"; text: string; error?: boolean }

const SUGGESTIONS = [
  "How much energy did I use today?",
  "Which load costs me the most?",
  "Compare today with yesterday",
  "Was anything unusual today?",
  "How can I reduce my bill?",
];

// ------------------------------------------------------------
// Demo mode: canned content so the page can be shown without a key
// ------------------------------------------------------------
const DEMO_INSIGHTS: Insights = {
  generatedAt: Date.now(),
  ai: true,
  model: "demo",
  summary: "Today you have used 0.62 kWh (₹4.96) so far, slightly more than yesterday at the same time. Load 1 is the biggest consumer at 71% of today's energy.",
  items: [
    { level: "warning", title: "Load 2 running much longer", text: "Load 2 has been ON 9.5 h today, while it usually runs about 2 h per day." },
    { level: "info", title: "Load 3 has low power factor", text: "Load 3 averages a power factor of 0.55, which is normal for LED drivers and chargers." },
    { level: "tip", title: "Switch Load 1 off earlier", text: "Turning Load 1 off one hour earlier each evening would save about 0.06 kWh (₹0.48) per day." },
  ],
};
function demoAnswer(q: string) {
  const s = q.toLowerCase();
  if (s.includes("yesterday")) return "Today so far you've used **0.62 kWh**, compared with **0.55 kWh** for the whole of yesterday — about 13% more. Most of the increase comes from Load 2 running longer.";
  if (s.includes("most") || s.includes("cost")) return "**Load 1** costs you the most: 0.44 kWh today, which is about **₹3.52** at ₹8/kWh (71% of today's bill).";
  if (s.includes("unusual")) return "Yes — **Load 2** has been ON for 9.5 h today, while it usually runs about 2 h per day. You may have forgotten to switch it off.";
  if (s.includes("reduce") || s.includes("bill")) return "- Switch Load 2 off when not needed — it's running 7 h longer than usual today.\n- Turning Load 1 off one hour earlier saves about **₹0.48/day** (₹14/month).";
  return "Today you have used **0.62 kWh** so far, costing about **₹4.96** at ₹8/kWh.\n\n_(Demo mode: answers are examples. Connect the real device to ask about your data.)_";
}

// ------------------------------------------------------------
// Tiny formatter: paragraphs, "- " bullets, **bold**, _italic_
// ------------------------------------------------------------
function inline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b>
    : p.startsWith("_") && p.endsWith("_") && p.length > 2 ? <i key={i}>{p.slice(1, -1)}</i>
    : <Fragment key={i}>{p}</Fragment>,
  );
}
function Formatted({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const isItem = /^\s*([-*•]|\d+\.)\s+/.test(line);
    if (!line.trim()) { blocks.push({ list: false, lines: [] }); continue; }
    const last = blocks[blocks.length - 1];
    if (last && last.list === isItem && last.lines.length) last.lines.push(line);
    else blocks.push({ list: isItem, lines: [line] });
  }
  return (
    <>
      {blocks.filter((b) => b.lines.length).map((b, i) =>
        b.list ? (
          <ul key={i}>{b.lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>)}</ul>
        ) : (
          <p key={i}>{inline(b.lines.join(" "))}</p>
        ),
      )}
    </>
  );
}

const LEVEL_LABEL: Record<Item["level"], string> = { alert: "Alert", warning: "Check", info: "Info", tip: "Tip" };

// ============================================================
export default function AIPanel({ demo, ready }: { demo: boolean; ready: boolean }) {
  return (
    <section className="ai">
      <InsightsCard demo={demo} ready={ready} />
      <ChatCard demo={demo} />
    </section>
  );
}

// ------------------------------------------------------------
function InsightsCard({ demo, ready }: { demo: boolean; ready: boolean }) {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (demo) { setData({ ...DEMO_INSIGHTS, generatedAt: Date.now() }); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/ai/insights${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(r.status === 503 ? "Database not connected." : j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [demo]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const time = data ? new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

  return (
    <div className="card ai-card">
      <div className="card-head">
        <div>
          <h2 className="section-title"><span className="ai-badge">AI</span> Insights</h2>
          <p className="section-sub">
            {data ? `${data.ai ? "Gemini summary" : "Rule-based checks"} · updated ${time}` : "Daily summary and unusual-usage checks"}
          </p>
        </div>
        <button className="btn-small" onClick={() => load(true)} disabled={loading}>
          {loading ? <><span className="spinner" />Analysing…</> : "Refresh"}
        </button>
      </div>

      {error && <div className="card-note bad"><span>{error}</span></div>}
      {!data && !error && <div className="empty">{loading ? "Analysing your data…" : "Loading…"}</div>}

      {data && (
        <>
          <p className="ai-summary">{data.summary}</p>
          {data.items.length > 0 ? (
            <ul className="ai-items">
              {data.items.map((it, i) => (
                <li key={i} className={`ai-item ${it.level}`}>
                  <span className={`ai-level ${it.level}`}>{LEVEL_LABEL[it.level] ?? it.level}</span>
                  <div>
                    <div className="ai-item-title">{it.title}</div>
                    <div className="ai-item-text">{it.text}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">Nothing unusual found.</div>
          )}
          {data.note && <p className="ai-note">{data.note}</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------
function ChatCard({ demo }: { demo: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    const history: Msg[] = [...msgs.filter((m) => !m.error), { role: "user", text: question }];
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setBusy(true);

    try {
      let answer: string;
      if (demo) {
        await new Promise((r) => setTimeout(r, 700));
        answer = demoAnswer(question);
      } else {
        const r = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history.map(({ role, text }) => ({ role, text })) }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        answer = j.answer;
      }
      setMsgs((m) => [...m, { role: "model", text: answer }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "model", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card ai-card chat">
      <div className="card-head">
        <div>
          <h2 className="section-title"><span className="ai-badge">AI</span> Ask about your energy</h2>
          <p className="section-sub">Answers use your stored readings (last 8 days)</p>
        </div>
        {msgs.length > 0 && <button className="btn-small" onClick={() => setMsgs([])} disabled={busy}>Clear</button>}
      </div>

      <div className="chat-list" ref={listRef}>
        {msgs.length === 0 && (
          <div className="chat-empty">
            <p>Try asking:</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip on" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}${m.error ? " error" : ""}`}>
            {m.role === "model" && !m.error ? <Formatted text={m.text} /> : m.text}
          </div>
        ))}
        {busy && <div className="bubble model typing"><span /><span /><span /></div>}
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. How much did Load 2 cost this week?"
          maxLength={500}
          disabled={busy}
          aria-label="Ask a question about your energy use"
        />
        <button className="btn send" type="submit" disabled={busy || !input.trim()}>Ask</button>
      </form>
    </div>
  );
}

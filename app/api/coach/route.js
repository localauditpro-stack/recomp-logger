// Conversational PT/strength coach for the Train tab. ADVISE-ONLY: it never writes
// to the user's data — it answers questions about workouts, sets, form and progression
// using the training context the client sends. Server-side so the key stays private.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash"; // 2.5 family retired Jul 2026

// Call Gemini with retry on transient overload (503/429/500) + fallback model.
async function generate(payload, key) {
  // Fallback chain (updated 2026-07-23): the entire Gemini 2.5 family was retired
  // ~9 Jul 2026 (API returns 404 "no longer available"), which silently killed this
  // endpoint for a week+. Env override first, then current free-tier models, newest first.
  const models = [MODEL, "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
    .filter((m, i, a) => a.indexOf(m) === i);
  let last = { ok: false, status: 0, raw: "The coach is busy — try again in a moment." };
  const tried = [];
  for (const m of models) {
    tried.push(m);
    let pl = payload; // per-model copy so we can strip fields the model rejects
    for (let attempt = 0; attempt < 3; attempt++) {
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(pl),
        });
      } catch (e) { last = { ok: false, status: 0, raw: String(e) }; continue; }
      const raw = await r.text();
      if (r.ok) return { ok: true, status: 200, raw };
      last = { ok: false, status: r.status, raw, tried: tried.join(", ") };
      if (r.status === 503 || r.status === 429 || r.status === 500) {
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1))); // backoff, then retry
        continue;
      }
      // Newer models sometimes reject generationConfig fields the 2.5 era used
      // (e.g. thinkingConfig). If a 400 complains about one, strip it and retry
      // the SAME model instead of failing over.
      if (r.status === 400 && /thinking/i.test(raw) && pl.generationConfig && pl.generationConfig.thinkingConfig) {
        const gc = { ...pl.generationConfig }; delete gc.thinkingConfig;
        pl = { ...pl, generationConfig: gc };
        continue;
      }
      break; // non-transient (404 model retired, other 400s) — move to the next model
    }
  }
  return last;
}

async function authed(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return false;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
    return r.ok;
  } catch { return false; }
}

const SYS = [
  "You are a personal trainer / strength & body-recomposition coach embedded in the user's training app.",
  "The user trains mostly on Hammer Strength / machine equipment and is on a fat-loss cut (goal: hold strength while losing weight).",
  "You are given a JSON snapshot of their CURRENT session and their recent per-exercise history (top weight, estimated 1RM trend, volume, PRs, and the actual sets of recent sessions). Weights are in kg; some machines are per-side (the app notes this in the exercise name/setup).",
  "Use that data to give specific, personalised advice: what weight/reps to target next, how to break a stall, whether to add load or chase reps (double progression), exercise order, supersets, rest, technique cues, and how to train around the cut (fatigue, recovery).",
  "Judge progress on the trend across sessions, not a single set. If the data doesn't contain something, say so briefly rather than inventing it.",
  "Style: like a real coach in the gym — direct, concise, encouraging. A sentence or two, or a few short bullets. No long essays.",
  "ADVISE ONLY: you cannot log, edit, or save anything. If asked to log a set, tell them to use the + Set buttons on the exercise card.",
  "Never give medical advice, including about any medication, supplements, or injuries beyond 'see a professional / stop if it's sharp pain'.",
].join(" ");

export async function POST(request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY is not set on the server." }, { status: 500 });
  if (!(await authed(request))) return Response.json({ error: "Please sign in again." }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Bad request body." }, { status: 400 }); }
  const { messages = [], context = {} } = body || {};

  // Seed the conversation with the training context as a first user turn, then the real messages.
  const contents = [
    { role: "user", parts: [{ text: "Here is my current training context (JSON):\n" + JSON.stringify(context) }] },
    { role: "model", parts: [{ text: "Got it — I can see your session and history. What do you want to work on?" }] },
    ...messages.slice(-12).map((m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: m.text || "" }] })),
  ];

  const payload = {
    system_instruction: { parts: [{ text: SYS }] },
    contents,
    generationConfig: { temperature: 0.6, thinkingConfig: { thinkingBudget: 0 } },
  };

  const gen = await generate(payload, key);
  const raw = gen.raw;
  if (!gen.ok) {
    let msg = raw;
    try { msg = JSON.parse(raw).error?.message || raw; } catch {}
    const friendly = (gen.status === 503 || gen.status === 429 || gen.status === 500)
      ? "The coach is briefly overloaded — give it a few seconds and try again."
      : "Coach error (" + gen.status + "): " + msg;
    return Response.json({ error: friendly }, { status: 502 });
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return Response.json({ error: "Coach returned non-JSON." }, { status: 502 }); }
  const text = parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  return Response.json({ reply: text || "Hmm, nothing came back — try again." });
}

// AI coaching analysis via Gemini. Two kinds: a single completed workout, or a
// weekly review. Server-side so the key stays private; requires a signed-in user.

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
  let last = { ok: false, status: 0, raw: "The AI is busy — try again in a moment." };
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

const SYS = {
  workout:
    "You are a strength & body-recomposition coach for a lifter on a fat-loss cut (machine-based Hammer Strength training). " +
    "Analyse the JUST-COMPLETED workout (JSON below) against the lifter's recent history and trajectory. " +
    "Be specific and tight — a short opening line, then a few bullets. Call out: which lifts progressed vs last time, which stalled or regressed, overall volume/quality, and any PRs. " +
    "Finish with 1–2 concrete things to target next session (load, reps, or technique). " +
    "Weights are in kg; some are per-side (noted). Honest but encouraging. Never give medical advice (incl. about any medication).",
  week:
    "You are a strength & body-recomposition coach doing a WEEKLY REVIEW for a lifter on a fat-loss cut. " +
    "Given the week's data (JSON below: weight trend, training sessions, adherence, cut context), write: " +
    "(1) a 1–2 sentence summary of how the week went, (2) the clear wins, (3) the misses/risks, and " +
    "(4) 2–4 specific, prioritised focus points for the coming week. " +
    "Be concise, concrete and actionable. Honest but motivating. Judge progress on the weekly trend, not single days. " +
    "Weights in kg. Never give medical advice (incl. about any medication).",
};

export async function POST(request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY is not set on the server." }, { status: 500 });
  if (!(await authed(request))) return Response.json({ error: "Please sign in again." }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Bad request body." }, { status: 400 }); }
  const { kind = "workout", data = {} } = body || {};
  const sys = SYS[kind] || SYS.workout;

  const payload = {
    system_instruction: { parts: [{ text: sys }] },
    contents: [{ role: "user", parts: [{ text: "Data (JSON):\n" + JSON.stringify(data) }] }],
    generationConfig: { temperature: 0.5, thinkingConfig: { thinkingBudget: 0 } },
  };

  const gen = await generate(payload, key);
  const raw = gen.raw;
  if (!gen.ok) {
    let msg = raw;
    try { msg = JSON.parse(raw).error?.message || raw; } catch {}
    const friendly = (gen.status === 503 || gen.status === 429 || gen.status === 500)
      ? "The AI is briefly overloaded — give it a few seconds and try again."
      : "Gemini error (" + gen.status + "): " + msg;
    return Response.json({ error: friendly }, { status: 502 });
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return Response.json({ error: "Gemini returned non-JSON." }, { status: 502 }); }
  const text = parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  return Response.json({ analysis: text || "No analysis came back — try again." });
}

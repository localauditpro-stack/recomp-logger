// Generates a personalised guided meditation script via Gemini. The client plays it
// back with on-screen text + device text-to-speech. Server-side so the key stays private.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash"; // 2.5 family retired Jul 2026

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

// Retry on transient overload (503/429/500) + fall back to a second model.
async function generate(payload, key) {
  // Fallback chain (updated 2026-07-23): the entire Gemini 2.5 family was retired
  // ~9 Jul 2026 (API returns 404 "no longer available"), which silently killed this
  // endpoint for a week+. Env override first, then current free-tier models, newest first.
  const models = [MODEL, "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
    .filter((m, i, a) => a.indexOf(m) === i);
  let last = { ok: false, status: 0, raw: "The guide is busy — try again in a moment." };
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

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short calming title for the session." },
    intro: { type: "string", description: "1-2 gentle opening sentences to help them settle and get comfortable." },
    cues: {
      type: "array",
      description: "Ordered guidance cues that make up the meditation. Each is a short spoken line followed by a silent pause to breathe/rest.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "One short, calm line of guidance (1-2 sentences). Second person, present tense, warm and unhurried." },
          hold: { type: "integer", description: "Seconds of silence to hold after speaking this line (rest/breathe). Usually 5-30." },
        },
        required: ["text", "hold"],
      },
    },
    closing: { type: "string", description: "A gentle closing line to gradually bring the session to an end." },
  },
  required: ["title", "intro", "cues", "closing"],
};

function systemText(goal, minutes, mood) {
  const goalMap = {
    calm: "calming an anxious or busy mind, easing stress",
    sleep: "winding down and preparing the body for sleep (softer, slower, sleepy toward the end)",
    focus: "resetting attention and finding calm clarity before work or training",
    body: "a progressive body scan, releasing physical tension area by area",
    mental_health: "general mental-health support: grounding, self-compassion, steadying the mind",
  };
  const focus = goalMap[goal] || goalMap.calm;
  return [
    "You are a warm, experienced meditation guide writing a spoken guided meditation to be read aloud by a calm text-to-speech voice.",
    `Focus of this session: ${focus}.`,
    `Target total length: about ${minutes} minutes. Size the number of cues and the 'hold' pause seconds so the whole thing runs roughly that long (spoken lines are brief; most of the time is in the holds).`,
    mood ? `The person shared how they feel right now: "${mood}". Gently acknowledge and work with this.` : "",
    "Guidelines: simple, everyday language; short sentences; second person ('you'); present tense; unhurried. Begin with settling and breath, move through the body/attention, and end by gently returning. Include natural breath cues.",
    "Keep the holds realistic: a few seconds after simple instructions, longer (15-30s) during breathing or silent resting stretches.",
    "Safety: this is a wellbeing meditation, not therapy or medical treatment. Do not diagnose, and make no medical claims. Keep it gentle and grounding.",
  ].filter(Boolean).join(" ");
}

export async function POST(request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY is not set on the server." }, { status: 500 });
  if (!(await authed(request))) return Response.json({ error: "Please sign in again." }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Bad request body." }, { status: 400 }); }
  const { goal = "calm", minutes = 5, mood = "" } = body || {};
  const mins = Math.max(2, Math.min(30, Number(minutes) || 5));

  const payload = {
    system_instruction: { parts: [{ text: systemText(goal, mins, String(mood || "").slice(0, 500)) }] },
    contents: [{ role: "user", parts: [{ text: `Write my guided meditation now. Goal: ${goal}. Length: about ${mins} minutes.` }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: SCHEMA, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
  };

  const gen = await generate(payload, key);
  if (!gen.ok) {
    let msg = gen.raw;
    try { msg = JSON.parse(gen.raw).error?.message || gen.raw; } catch {}
    const friendly = (gen.status === 503 || gen.status === 429 || gen.status === 500)
      ? "The guide is briefly overloaded — give it a few seconds and try again."
      : "Meditation error (" + gen.status + "): " + msg;
    return Response.json({ error: friendly }, { status: 502 });
  }
  let data;
  try { data = JSON.parse(gen.raw); } catch { return Response.json({ error: "Guide returned non-JSON." }, { status: 502 }); }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { return Response.json({ error: "Couldn't read the session — try again." }, { status: 502 }); }
  if (!parsed || !Array.isArray(parsed.cues) || !parsed.cues.length) return Response.json({ error: "Empty session — try again." }, { status: 502 });
  return Response.json(parsed);
}

// Chat → Gemini Flash. Server-side so the API key never reaches the browser.
// The browser sends the conversation (+ optional photo) and today's current
// values; Gemini returns a structured proposal that the client confirms before
// writing to daily_log. Free-tier friendly: defaults to gemini-2.5-flash.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // give the model room; the client aborts at 45s anyway

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash"; // 2.5 family retired Jul 2026
const ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Call Gemini with retry on transient overload (503/429/500) and fall back to a
// second model if the primary stays busy. Both models accept the same payload.
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

// Structured-output schema: the model always returns this shape.
const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "A short, friendly conversational reply to show the user." },
    has_proposal: { type: "boolean", description: "true if you are proposing a log entry to save; false if just chatting or asking for clarification." },
    summary: { type: "string", description: "One-line human summary of the proposed change, e.g. 'Protein 95 → 140g (chicken & rice); calories 1200 → 1840'. Empty string when has_proposal is false." },
    entry: {
      type: "object",
      description: "The NEW absolute values for the day after applying the user's message. Only set fields the user actually provided or that you can confidently estimate; leave the rest null.",
      properties: {
        log_date: { type: "string", description: "ISO date YYYY-MM-DD this entry is for. Default to today unless the user clearly means another day." },
        bodyweight_kg: { type: ["number", "null"], description: "Bodyweight in kg." },
        bodyfat_pct: { type: ["number", "null"], description: "Body-fat percentage." },
        protein_g: { type: ["number", "null"], description: "New TOTAL protein grams for the day. For a single meal, ADD it to the current total you were given." },
        calories_kcal: { type: ["number", "null"], description: "New TOTAL calories for the day. For a single meal, ADD to the current total." },
        fibre_g: { type: ["number", "null"], description: "New TOTAL fibre grams for the day. For a single meal, ADD to the current total." },
        steps: { type: ["integer", "null"], description: "Step count for the day." },
        sleep_duration_hr: { type: ["number", "null"], description: "Hours of sleep." },
        resting_hr: { type: ["integer", "null"], description: "Resting heart rate, bpm." },
        training_session: { type: ["string", "null"], description: "Exactly one of: upper_a, lower_a, upper_b, lower_b, rest. Null if not mentioned." },
        weed: { type: ["string", "null"], description: "Exactly one of: none, weekend_planned, off_plan. Null if not mentioned." },
        notes: { type: ["string", "null"], description: "Short free-text note, e.g. what was eaten." },
      },
      required: ["log_date"],
    },
  },
  required: ["reply", "has_proposal", "summary", "entry"],
};

function systemText(ctx) {
  const today = ctx && ctx.today ? ctx.today : {};
  const have = Object.entries(today)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "nothing logged yet";
  return [
    "You are the logging assistant inside a personal fat-loss / body-recomposition tracker.",
    `Today's date is ${ctx && ctx.date ? ctx.date : "today"}.`,
    "The user talks to you in plain language or sends a photo (a plate of food, a nutrition label, a scale, a smartwatch screen). Your job: turn it into a structured day-log entry and a friendly reply.",
    "",
    "When the user logs food: estimate protein, calories and fibre. Food macros are CUMULATIVE across the day — add the new meal to the current totals shown below and return the NEW TOTAL in protein_g / calories_kcal / fibre_g.",
    "Other fields (bodyweight_kg, bodyfat_pct, steps, sleep_duration_hr, resting_hr, training_session, weed) are absolute: just set the value the user states.",
    "Put a brief description of food eaten in notes.",
    "",
    `Current values already logged for today: ${have}.`,
    "",
    "Rules:",
    "- Only fill fields the user actually gave you or that you can confidently estimate from a photo. Leave everything else null.",
    "- If the message is ambiguous or you need a portion size, set has_proposal=false and ask one short question in reply.",
    "- If you have something concrete to save, set has_proposal=true, fill entry, and write a one-line summary showing old → new for any changed number.",
    "- training_session must be one of: upper_a, lower_a, upper_b, lower_b, rest. weed must be one of: none, weekend_planned, off_plan.",
    "- Be concise and encouraging. Never claim precision you don't have — say 'about' for estimates.",
    "- The app shows the user a confirm step before anything is saved, so propose freely; you are not writing directly.",
    "- Fields starting with vagus_ describe vagus-nerve stimulation sessions logged that day (vagus_sessions = count, vagus_total_min = minutes, vagus_programs = which programs, vagus_peak_intensity, vagus_avg_mood). They are READ-ONLY context: never propose writing them, they are not part of the entry schema.",
    "- With a single user and noisy day-to-day data, do NOT assert causation or make clinical/medical claims (e.g. don't say a stim session 'improved' HRV, sleep, or mood). If asked, you may note a neutral, tentative association at most.",
  ].join("\n");
}

// Verify the caller is a signed-in user (so the endpoint can't be used as a free
// Gemini proxy that drains the quota). The browser sends its Supabase JWT.
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

export async function POST(request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json(
      { error: "GEMINI_API_KEY is not set on the server. Add it in Vercel → Settings → Environment Variables." },
      { status: 500 }
    );
  }

  if (!(await authed(request))) {
    return Response.json({ error: "Please sign in again." }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Bad request body." }, { status: 400 }); }
  const { messages = [], image = null, context = {} } = body || {};

  // Reject oversized images (base64). ~2M chars ≈ 1.5MB — the client downscales well under this.
  if (image && image.data && image.data.length > 2_000_000) {
    return Response.json({ error: "That image is too large — try a smaller photo." }, { status: 413 });
  }

  // Only send the last ~12 turns — the full history balloons the prompt and latency.
  const recentMsgs = messages.slice(-12);
  // Build Gemini contents from the conversation; attach the image to the last user turn.
  const contents = recentMsgs.map((m, i) => {
    const parts = [];
    const isLast = i === recentMsgs.length - 1;
    if (isLast && image && image.data && m.role === "user") {
      parts.push({ inline_data: { mime_type: image.mimeType || "image/jpeg", data: image.data } });
    }
    parts.push({ text: m.text || "" });
    return { role: m.role === "model" ? "model" : "user", parts };
  });

  const payload = {
    system_instruction: { parts: [{ text: systemText(context) }] },
    contents,
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: SCHEMA,
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: 0 }, // disable 2.5-flash "thinking" — big latency cut
    },
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

  let data;
  try { data = JSON.parse(raw); } catch { return Response.json({ error: "Gemini returned non-JSON." }, { status: 502 }); }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    // Model didn't honour JSON mode — fall back to plain reply.
    return Response.json({ reply: text || "Sorry, I couldn't read that. Try rephrasing?", has_proposal: false, summary: "", entry: { log_date: context?.date } });
  }
  return Response.json(parsed);
}

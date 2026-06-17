"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";
import { SESSIONS, EXERCISES } from "../lib/exercises";

// ---------- helpers ----------
const todayStr = () => {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
};
const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
const isWeekday = (dateStr) => {
  const day = new Date(dateStr + "T00:00:00").getDay();
  return day >= 1 && day <= 5;
};

// ---------- root ----------
export default function Page() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="center">Loading…</div>;
  if (!session) return <Auth />;
  return <Logger session={session} />;
}

// ---------- auth ----------
function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const signIn = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  };

  return (
    <div className="auth">
      <h1>Recomp Logger</h1>
      <p>Sign in to start logging.</p>
      <form onSubmit={signIn}>
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" autoComplete="username"
            value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button className="btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {err && <div className="err">{err}</div>}
      </form>
    </div>
  );
}

// ---------- logger ----------
const EMPTY = {
  bodyweight_kg: "", protein_g: "", weed: "",
  calories_kcal: "", fibre_g: "", steps: "", sleep_duration_hr: "",
  training_session: "", notes: "",
  morning_ritual_done: false, sauna_done: false,
};

function Logger({ session }) {
  const uid = session.user.id;
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [sets, setSets] = useState([]);
  const [streaks, setStreaks] = useState({ weed: 0, ritual: 0 });
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [online, setOnline] = useState(true);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2000); };

  // load config + today's row + sets + streak
  const load = useCallback(async () => {
    const day = todayStr();
    const [{ data: cfg }, { data: cur }, { data: ws }, { data: hist }] = await Promise.all([
      supabase.from("config").select("*").eq("user_id", uid).maybeSingle(),
      supabase.from("daily_log_current").select("*").eq("user_id", uid).eq("log_date", day).maybeSingle(),
      supabase.from("workout_set").select("*").eq("user_id", uid).eq("log_date", day).order("created_at"),
      supabase.from("daily_log_current").select("log_date, weed, morning_ritual_done")
        .eq("user_id", uid).order("log_date", { ascending: false }).limit(90),
    ]);
    setConfig(cfg || {});
    if (cur) {
      setForm({
        bodyweight_kg: cur.bodyweight_kg ?? "", protein_g: cur.protein_g ?? "",
        weed: cur.weed ?? "", calories_kcal: cur.calories_kcal ?? "",
        fibre_g: cur.fibre_g ?? "", steps: cur.steps ?? "",
        sleep_duration_hr: cur.sleep_duration_hr ?? "",
        training_session: cur.training_session ?? "", notes: cur.notes ?? "",
        morning_ritual_done: !!cur.morning_ritual_done, sauna_done: !!cur.sauna_done,
      });
    }
    setSets(ws || []);
    setStreaks(computeStreaks(hist || []));
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  const save = async () => {
    setSaving(true);
    const payload = {
      user_id: uid,
      log_date: todayStr(),
      bodyweight_kg: numOrNull(form.bodyweight_kg),
      protein_g: numOrNull(form.protein_g),
      weed: form.weed || null,
      calories_kcal: numOrNull(form.calories_kcal),
      fibre_g: numOrNull(form.fibre_g),
      steps: numOrNull(form.steps),
      sleep_duration_hr: numOrNull(form.sleep_duration_hr),
      training_session: form.training_session || null,
      notes: form.notes || null,
      morning_ritual_done: form.morning_ritual_done,
      sauna_done: form.sauna_done,
      source: "manual",
    };
    const { error } = await supabase.from("daily_log").insert(payload);
    setSaving(false);
    if (error) { flash("Saved offline — will sync"); queueOffline(payload); }
    else { flash("Saved ✓"); load(); }
  };

  const addSet = async (exercise, range, weight, reps) => {
    const day = todayStr();
    const setNumber = sets.filter((s) => s.exercise === exercise).length + 1;
    const payload = {
      user_id: uid, log_date: day, exercise, set_number: setNumber,
      weight_kg: numOrNull(weight), reps: numOrNull(reps), rep_target_range: range,
    };
    const { error } = await supabase.from("workout_set").insert(payload);
    if (error) { flash("Set saved offline"); queueOffline(payload, "workout_set"); }
    else { flash("Set logged ✓"); setSets((s) => [...s, { ...payload, created_at: new Date().toISOString() }]); }
  };

  const t = config || {};
  const inWeedWindow = false; // cessation-window flag is a Phase 2 concern

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>Recomp Logger</h1>
          <div className="date">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</div>
        </div>
        <button className="linkbtn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>

      <div className="chips">
        <span className="chip flame"><span className="num">{streaks.weed}</span> weekday weed-clean</span>
        <span className="chip"><span className="num">{streaks.ritual}</span> ritual</span>
      </div>

      {!online && <div className="banner">Offline — entries are saved on your phone and sync when you reconnect.</div>}

      {/* MUST-LOG */}
      <div className="card primary">
        <h2>Must-log</h2>
        <div className="field">
          <label>Bodyweight <span className="target">(kg)</span></label>
          <input className="input" type="number" inputMode="decimal" step="0.1" placeholder="—"
            value={form.bodyweight_kg} onChange={(e) => set("bodyweight_kg", e.target.value)} />
        </div>
        <div className="field">
          <label>Protein {t.protein_target ? <span className="target">· target {t.protein_target}g</span> : null}</label>
          <input className="input" type="number" inputMode="numeric" placeholder="—"
            value={form.protein_g} onChange={(e) => set("protein_g", e.target.value)} />
        </div>
        <div className="field">
          <label>Weed</label>
          <div className="seg">
            <button className={"segbtn" + (form.weed === "none" ? " active" : "")} onClick={() => set("weed", "none")}>None</button>
            <button className={"segbtn warn" + (form.weed === "weekend_planned" ? " active" : "")} onClick={() => set("weed", "weekend_planned")}>Weekend</button>
            <button className={"segbtn danger" + (form.weed === "off_plan" ? " active" : "")} onClick={() => set("weed", "off_plan")}>Off-plan</button>
          </div>
        </div>
      </div>

      {/* SECONDARY */}
      <div className="card">
        <h2>The rest <span className="hint">optional</span></h2>
        <div className="row2">
          <div className="field">
            <label>Calories {t.calorie_target ? <span className="target">/{t.calorie_target}</span> : null}</label>
            <input className="input" type="number" inputMode="numeric" placeholder="—"
              value={form.calories_kcal} onChange={(e) => set("calories_kcal", e.target.value)} />
          </div>
          <div className="field">
            <label>Fibre {t.fibre_target ? <span className="target">/{t.fibre_target}g</span> : null}</label>
            <input className="input" type="number" inputMode="numeric" placeholder="—"
              value={form.fibre_g} onChange={(e) => set("fibre_g", e.target.value)} />
          </div>
          <div className="field">
            <label>Steps {t.steps_target ? <span className="target">/{t.steps_target}</span> : null}</label>
            <input className="input" type="number" inputMode="numeric" placeholder="—"
              value={form.steps} onChange={(e) => set("steps", e.target.value)} />
          </div>
          <div className="field">
            <label>Sleep {t.sleep_target_hr ? <span className="target">/{t.sleep_target_hr}h</span> : null}</label>
            <input className="input" type="number" inputMode="decimal" step="0.1" placeholder="—"
              value={form.sleep_duration_hr} onChange={(e) => set("sleep_duration_hr", e.target.value)} />
          </div>
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <label>Training session</label>
          <div className="seg wrap">
            {SESSIONS.map((s) => (
              <button key={s.value}
                className={"segbtn" + (form.training_session === s.value ? " active" : "")}
                onClick={() => set("training_session", form.training_session === s.value ? "" : s.value)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className={"toggle" + (form.morning_ritual_done ? " on" : "")} onClick={() => set("morning_ritual_done", !form.morning_ritual_done)}>
            <span>Morning ritual done</span><span className="knob" />
          </div>
        </div>
        <div className="field">
          <div className={"toggle" + (form.sauna_done ? " on" : "")} onClick={() => set("sauna_done", !form.sauna_done)}>
            <span>Sauna (weekly)</span><span className="knob" />
          </div>
        </div>

        <div className="field">
          <label>Notes — hunger / mood / drive / triggers</label>
          <textarea className="input" rows={3} placeholder="…"
            value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </div>
      </div>

      {/* WORKOUT */}
      {form.training_session && form.training_session !== "rest" && (
        <div className="card">
          <h2>Workout — {SESSIONS.find((s) => s.value === form.training_session)?.label}</h2>
          {EXERCISES[form.training_session].map((ex) => (
            <ExerciseRow key={ex.name} ex={ex}
              sets={sets.filter((s) => s.exercise === ex.name)}
              onAdd={(w, r) => addSet(ex.name, ex.range, w, r)} />
          ))}
        </div>
      )}

      <div className="savebar">
        <div className="inner">
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save today"}
          </button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ExerciseRow({ ex, sets, onAdd }) {
  const [w, setW] = useState("");
  const [r, setR] = useState("");
  const submit = () => {
    if (w === "" && r === "") return;
    onAdd(w, r);
    setR("");
  };
  return (
    <div className="exercise">
      <div className="ex-head">
        <span className="ex-name">{ex.name}</span>
        <span className="ex-range">{ex.range} reps</span>
      </div>
      {sets.length > 0 && (
        <div className="setlog">
          {sets.map((s, i) => (
            <span className="settag" key={i}>{s.weight_kg ?? "—"}kg × {s.reps ?? "—"}</span>
          ))}
        </div>
      )}
      <div className="setadd">
        <input className="input" type="number" inputMode="decimal" step="0.5" placeholder="kg"
          value={w} onChange={(e) => setW(e.target.value)} />
        <input className="input" type="number" inputMode="numeric" placeholder="reps"
          value={r} onChange={(e) => setR(e.target.value)} />
        <button className="addbtn" onClick={submit}>+ Set</button>
      </div>
    </div>
  );
}

// ---------- streaks (client-side, minimal) ----------
function computeStreaks(hist) {
  const byDate = {};
  hist.forEach((h) => { byDate[h.log_date] = h; });
  const today = new Date(todayStr() + "T00:00:00");

  // weekday weed-clean: consecutive weekdays (skipping weekends) with weed === 'none'
  let weed = 0;
  for (let i = 0; i < 90; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    if (!isWeekday(ds)) continue;
    const row = byDate[ds];
    if (row && row.weed === "none") weed++;
    else if (i === 0 && !row) continue; // today not logged yet — don't break
    else break;
  }

  // ritual: consecutive days (incl weekends) with morning_ritual_done
  let ritual = 0;
  for (let i = 0; i < 90; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const row = byDate[ds];
    if (row && row.morning_ritual_done) ritual++;
    else if (i === 0 && !row) continue;
    else break;
  }
  return { weed, ritual };
}

// ---------- offline queue ----------
function queueOffline(payload, table = "daily_log") {
  try {
    const key = "recomp_queue";
    const q = JSON.parse(localStorage.getItem(key) || "[]");
    q.push({ table, payload, at: Date.now() });
    localStorage.setItem(key, JSON.stringify(q));
  } catch {}
}

async function flushQueue() {
  try {
    const key = "recomp_queue";
    const q = JSON.parse(localStorage.getItem(key) || "[]");
    if (!q.length) return;
    const left = [];
    for (const item of q) {
      const { error } = await supabase.from(item.table).insert(item.payload);
      if (error) left.push(item);
    }
    localStorage.setItem(key, JSON.stringify(left));
  } catch {}
}

if (typeof window !== "undefined") {
  window.addEventListener("online", flushQueue);
}

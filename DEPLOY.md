# Deploy the Recomp Logger (Session 2)

Goal: get the logger live on a URL, then install it to your Pixel home screen.
Vercel runs the production build for you, so this is also the final build test.

**What you'll need:** your GitHub login, your Vercel login, and your Supabase
**publishable key** (Supabase → Settings → API Keys → Publishable key → Copy).

The two environment values the app needs:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://sfawpztnrhlygdggskjv.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your `sb_publishable_…` key |

---

## Step 1 — Put the code on GitHub

The project folder is `recomp-logger` (in your SecondBrain folder). Easiest no-terminal way:

1. Go to **github.com → New repository**. Name it `recomp-logger`, keep it **Private**, click **Create repository**.
2. On the new repo page, click **uploading an existing file**.
3. Open the `recomp-logger` folder on your computer, select **everything inside it**
   (the `app`, `lib`, `public` folders and the loose files like `package.json`),
   and drag them into the browser. **Do not upload `node_modules`** (there isn't one — good).
4. Click **Commit changes**.

> Prefer a tool? GitHub Desktop or `git push` work too — just get the folder contents into the repo root.

---

## Step 2 — Import into Vercel

1. Go to **vercel.com → Add New… → Project**.
2. **Import** your `recomp-logger` GitHub repo (authorize GitHub if asked).
3. Vercel auto-detects Next.js — leave the build settings as default.
4. Expand **Environment Variables** and add the two from the table above
   (name on the left, value on the right). Paste your publishable key carefully.
5. Click **Deploy**. Wait ~1–2 minutes for the build.
   - If the build **fails**, copy the error log and send it to me — I'll fix it fast.
   - If it **succeeds**, you'll get a URL like `https://recomp-logger-xxxx.vercel.app`.

---

## Step 3 — Install to your Pixel

1. On your Pixel, open the Vercel URL in **Chrome**.
2. **Sign in** with your email (`danielkalisperis5@gmail.com`) and the password you set
   when you created the Supabase user.
3. Chrome menu (⋮) → **Add to Home screen** / **Install app**. Confirm.
4. Open it from your home screen — it runs full-screen, no browser bars.

---

## Step 4 — Confirm end to end

1. In the app, enter a bodyweight, a protein number, tap a Weed button, hit **Save today**.
2. In Supabase → **Table Editor → daily_log**, confirm the row appears with your `user_id`.
3. Pick a training session, log a couple of sets, check **workout_set** gets rows.
4. (Optional) Turn off Wi-Fi/data, log something — it saves locally and syncs when back online.

Once a full day logs in under ~30 seconds and shows up in Supabase, **you're ready for Monday.**

---

## Notes & known scope (Session 2)

- **Auth:** simple email + password, session stays signed in. Magic-link/multi-user is a later flip — no rebuild (RLS already keys on `user_id`).
- **Targets** (protein 150, calories 2000, steps 10k, etc.) are read live from your `config` row — change them in Supabase and the app reflects it, no redeploy.
- **Corrections:** every Save writes a new `daily_log` row (append-only). The app shows the latest via the `daily_log_current` view.
- **Not in this session (Phase 2):** charts, rolling averages, the "is the plan working?" decision logic, CSV device import. The logger is only capturing clean data — exactly the plan.
- **Env vars are baked in at build time.** If you change a key later, set it in Vercel and **redeploy**.

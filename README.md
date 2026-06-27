# Community Member Map

A **spatial member directory** on a world map for **any community**, hosted
entirely on Cloudflare. Members add themselves through a simple, opt-in form;
each submission appears as a pin on a shared map. Members can edit or remove
their own entry later, and admins can fix, import, export, or remove entries.

It ships branded as [**Midhrami Studios**](https://midhrami.com) out of the
box, but **every community can rebrand it from the admin dashboard** — the
site name, community name, website link, and integration settings are all
editable at runtime with no redeploy (see
[Dashboard settings](#dashboard-configurable-settings)).

Built on **Cloudflare Workers** (API + static hosting) and **Cloudflare D1**
(SQLite). The map uses **Leaflet** with **OpenStreetMap** tiles — no API keys,
no third-party map billing. All front-end libraries are vendored locally so the
site runs under a strict Content-Security-Policy.

---

## Features

- **Opt-in submission form** — name, city/location, short bio, a "how to
  connect" link/handle, and a **required public-consent checkbox**. Nothing is
  shown publicly unless the member ticks the box.
- **Pick your spot** — type a place (geocoded via OpenStreetMap Nominatim,
  proxied through the Worker), choose a match, or click/drag a pin on the map.
- **Live world map** — pins **cluster** when zoomed out, with a **searchable
  sidebar** list. Clicking a name flies to and opens its pin.
- **Members edit their own entry** with a **secret edit link** — shown once on
  submission. No email is required or collected for the flow; if a member loses
  their link, an admin can mint a fresh one from the dashboard and share it.
- **Admin dashboard** at `/admin` (linked from the map header) — view every
  entry (including hidden/pending), edit any field, move pins, change moderation
  status, copy a member's edit link, **merge duplicate records**, and delete
  entries.
- **Moderation by default** — every member submission is held as **pending**
  and never shown publicly until an admin publishes it. Members can never
  publish their own entry.
- **Merge / de-duplicate** — select two or more records in the admin dashboard
  and merge them into one, choosing per-field which value to keep. The kept
  record retains its edit link; the others are deleted.
- **Bulk CSV import / export / edit** — import the sign-up sheet (columns are
  auto-detected and locations geocoded to pins for review before import),
  export the directory, and apply status/visibility/merge/delete actions to many
  members at once with select-all / select-none shortcuts.
- **Demo data toggle** — sample pins are hidden by default and can be switched
  on from the on-screen Debug panel for previewing the map.
- **Security baked in** (see [Security](#security)).

---

## Architecture

```
Browser ─┬─► /api/*  ─► Cloudflare Worker (src/) ─► D1 (SQLite)
         │                 └─► Nominatim (geocode proxy)
         └─► /*      ─► Cloudflare CDN ─► static assets (public/) incl. vendored Leaflet
```

The Worker runs **only for `/api/*`**. Static assets are served directly from
Cloudflare's CDN — cached, fast, and free (they don't count against the Workers
request limit). Security headers for those assets come from `public/_headers`;
the Worker applies the same headers to its JSON responses. This keeps the app
well inside the free tier (see the scaling notes below).

| Path                          | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `src/index.ts`                | Worker entry + router                           |
| `src/security.ts`             | CSP/headers, hashing, HMAC sessions, CSRF, escaping |
| `src/settings.ts`             | Dashboard-configurable branding/integration settings |
| `src/validate.ts`             | Input validation + contact normalisation        |
| `src/db.ts`                   | D1 queries (parameterised)                      |
| `src/geocode.ts`              | Nominatim forward-geocoding proxy               |
| `public/`                     | Front-end (map, form, edit, admin) + vendored Leaflet |
| `public/_headers`             | Security/cache headers for CDN-served static assets |
| `migrations/`                 | D1 schema migrations                            |

---

## Scaling & cost (free tier)

Comfortably runs on the **Cloudflare free tier** for communities of hundreds to
low-thousands of members:

- **Worker requests** (100k/day free): only `/api/*` hits the Worker — roughly
  two calls per page load — so static assets don't consume the quota.
- **D1** (free: ~5 GB, ~5M row reads/day, 100k writes/day): a few hundred rows
  is well under 1 MB; the map loads in one query, so even thousands of map views
  per day stay far below the read limit. Writes happen only on submit/edit.
- **CPU**: handlers are simple parameterised D1 queries, well under the limit.
- **Geocoding**: lookups are edge-cached for 24h to respect Nominatim's fair-use
  policy. For a large simultaneous onboarding spike, switch to a paid geocoder.

---

## Quick start (local)

```bash
npm install          # installs wrangler, types, and the leaflet libs
npm run vendor       # copies Leaflet into public/vendor (run once / after updates)

# Local secrets for `wrangler dev` (never committed — see .gitignore)
cp .dev.vars.example .dev.vars   # then edit: set ADMIN_PASSWORD + SESSION_SECRET
# tip: openssl rand -base64 32   # generates a good SESSION_SECRET

npm run db:migrate:local    # create the local D1 tables
npm run dev                 # http://localhost:8787
```

Open <http://localhost:8787>, add yourself, then visit `/admin` and sign in with
the `ADMIN_PASSWORD` above.

---

## Deploying to Cloudflare

### One-click deploy (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DhavalW/Gw-member-map)

The button is the easiest way to stand up your own copy. Cloudflare will:

1. **Clone this repo into your own GitHub account** (you continue development
   there).
2. **Auto-provision the D1 database** — because `wrangler.json` ships **without**
   a `database_id`, Cloudflare creates the database on *your* account and binds
   it to the Worker. Nothing account-specific is ever committed here.
3. **Prompt you for the secrets** listed in `.dev.vars.example`
   (`ADMIN_PASSWORD`, `SESSION_SECRET`) and store them as encrypted Worker
   secrets.
4. **Build and deploy**, and wire up **Workers Builds CI/CD** so every push to
   your production branch redeploys automatically (pull requests get preview
   URLs).

**The database sets itself up — no manual steps.** The Worker creates its tables
on the first request that needs them (see `src/schema.ts`), so you never have to
deal with a `database_id` or run a migration command. This sidesteps a sharp
edge of the auto-provisioning flow: Cloudflare provisions the D1 database but
does **not** write the generated `database_id` back into your committed config,
which would make a separate `wrangler d1 migrations apply --remote` step fail.
The schema statements are all idempotent (`CREATE … IF NOT EXISTS`), so this is
safe to run on every cold start.

After the first deploy, set any **optional** secrets you want (e.g. Turnstile)
from the table below — in the dashboard under **Workers & Pages → your Worker →
Settings → Variables and Secrets**, or with `wrangler secret put <NAME>`.

### Connect an existing repo via the dashboard

If you'd rather connect this repo manually (**Workers & Pages → Create → Workers
→ Connect to Git**): pick your production branch, leave the **build command**
empty (the front-end libs are already vendored into `public/`), and set the
**deploy command** to `npm run deploy` (which runs `wrangler deploy` — note:
`npm`, not `npx`). Add the required secrets to the Worker afterwards. The first
deploy auto-provisions D1, and the Worker creates its own tables on first use.

> **Note on the config format:** the Worker config is plain `wrangler.json`, not
> `wrangler.jsonc`. Workers Builds' config detector fails to parse JSON-with-comments,
> and when it can't read the config it never scopes/injects the deploy credentials —
> so `wrangler deploy` falls back to an interactive login and the build fails with
> *"In a non-interactive environment, it's necessary to…"*. Keep this file
> comment-free (document settings here in the README instead).

### Manual deploy (CLI)

```bash
npx wrangler login
# Optional: create the DB up front (otherwise it's auto-provisioned on deploy)
# npx wrangler d1 create gw-member-map   # then paste the id into wrangler.json
npx wrangler secret put ADMIN_PASSWORD     # admin sign-in password
npx wrangler secret put SESSION_SECRET      # random 32+ byte string for signing
npm run deploy                              # deploys the Worker (schema self-initialises)
```

`npm run vendor` runs against `node_modules`, so make sure `npm install` has run
before re-vendoring (the vendored files in `public/vendor` are committed, so this
is only needed when bumping the Leaflet version).

### Optional configuration

All of the settings below can be configured **from the admin dashboard** (see
[Dashboard settings](#dashboard-configurable-settings)) — that's the
recommended way, and it requires no redeploy. The matching deployment
variables/secrets are still honoured as the initial value for a fresh deploy;
a value saved from the dashboard always takes precedence.

| Setting | Type | Effect |
| ------- | ---- | ------ |
| `APP_NAME` | var | Site title shown in the browser tab and as the map heading (default `Midhrami Studios Member Map`). |
| `COMMUNITY_NAME` | var | Community name used for branding and the header link (default `Midhrami Studios`). |
| `COMMUNITY_URL` | var | Community website linked from the UI (default `https://midhrami.com`). |
| `PUBLIC_BASE_URL` | var | Absolute origin used to build edit links (e.g. `https://members.example.com`). Falls back to the request host. |
| `MODERATION_ENABLED` | var | **Deprecated / no longer required.** Moderation is now always on: every member submission is held as **pending** until an admin publishes it, regardless of this value. |
| `TURNSTILE_SITE_KEY` | var | Public [Turnstile](https://developers.cloudflare.com/turnstile/) key — shows the anti-spam widget. |
| `TURNSTILE_SECRET` | secret | Turnstile secret — the Worker verifies the token. The CSP already allows `challenges.cloudflare.com`. |

Set secrets with `wrangler secret put <NAME>`; set vars in `wrangler.json`.

> The **admin password** (`ADMIN_PASSWORD`) and **session secret**
> (`SESSION_SECRET`) are intentionally **not** editable from the dashboard —
> they are authentication secrets and stay as encrypted deployment secrets.

### Dashboard-configurable settings

Sign in at `/admin` and open **Settings** to rebrand the map and manage
integrations without redeploying. Each option shows an inline explanation and
whether its current value comes from the dashboard, the deployment config, or
the built-in default. Changes are stored in a `settings` table in D1 and take
effect immediately for everyone.

Configurable here: **Site title**, **Community name**, **Community website**,
**Public base URL**, **Turnstile site key**, and **Turnstile secret**. The
Turnstile secret is write-only — the dashboard shows only whether one is set
and never echoes the value back.

---

## Member edit flows

- **On submission**, the member is shown a one-time **edit link**
  (`/edit?id=…#k=<token>`). The raw token is **never stored** — only its
  SHA-256 hash — and the link fragment (`#k=`) is never sent to the server in
  normal navigation, so it stays out of logs.
- **Lost link?** There is no email workflow. An admin opens the dashboard,
  finds the member, and clicks **Copy link** (or **Generate** in the edit
  dialog) to mint a fresh edit link to share. Generating a new link invalidates
  the previous one, since only the hash is ever stored.

Members may untick the public-consent box to **hide** their entry without
deleting it; re-ticking restores it.

---

## Security

| Area | Measure |
| ---- | ------- |
| Transport | `Strict-Transport-Security`; `upgrade-insecure-requests`. Cloudflare terminates TLS. |
| XSS | Strict **CSP** (`script-src 'self'`, no inline scripts). All user content rendered via `textContent`/DOM nodes — never `innerHTML`. |
| Clickjacking | `X-Frame-Options: DENY` + `frame-ancestors 'none'`. |
| SQL injection | All D1 queries use bound parameters / prepared statements. |
| CSRF | State-changing requests require a same-origin `Origin`/`Referer`; admin cookie is `HttpOnly; Secure; SameSite=Strict`. |
| Auth (members) | Unguessable 256-bit edit token; only its **hash** is stored; constant-time comparison. The token is accepted **only** via the `X-Edit-Token` header (never a query string), so it can't leak through logs, browser history or the `Referer` header. Members can edit their own details and toggle their public opt-in, but can **never** change moderation status. |
| Auth (admins) | Password compared in constant time; session is an **HMAC-signed**, expiring cookie. Admin-only endpoints (bulk edit, CSV import, edit-link minting, record merge, settings) require a valid admin session **and** a same-origin request. |
| Brute force | Admin sign-in is **rate-limited per IP**: after 5 failed attempts within an hour each further failure triggers an **exponential lockout** (30s, doubling, capped at 1h) returned as `429` with `Retry-After`; a constant delay is added to every failed attempt to slow automated guessing, and a successful sign-in resets the counter. IPs are stored only as a salted hash. |
| Moderation | New entries default to `pending` (enforced server-side and as the DB column default); only an admin can publish. Public visibility requires `status = 'published'` **and** `consent_public = 1`. |
| Spam / abuse | Hidden **honeypot** field, per-IP **rate limiting** (5/hour), optional **Turnstile**. IPs are stored only as a salted hash for rate limiting. |
| Privacy | Opt-in only; email is never exposed in the public API; internal ids are never exposed (opaque `public_id` used everywhere). |
| Headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. |
| Secrets | Kept in Wrangler secrets / `.dev.vars` (git-ignored), never in source. |

### Threat-model notes

- Anyone with a member's edit link can edit that member's entry — it is a
  bearer credential, by design (like an unsubscribe link). Keep it private; an
  admin can always delete a compromised entry.
- The geocoding proxy is for interactive lookups and is edge-cached to respect
  Nominatim's usage policy. For very high traffic, switch to a paid geocoder.

### Admin password & session secret (best practices)

These are the only two secrets the app needs, and — **by design** — they are
set as **deployment secrets, never from the admin dashboard**, so they can't
leak through the admin UI and are never written to the database. (The admin
dashboard shows a permanent reminder of the same guidance below.)

**How to set or change them**

- **Cloudflare dashboard (recommended for non-technical admins):** Workers &
  Pages → your Worker → **Settings → Variables and Secrets** → add or edit
  `ADMIN_PASSWORD` and `SESSION_SECRET`, then **Save and deploy**.
- **CLI:** `wrangler secret put ADMIN_PASSWORD` and
  `wrangler secret put SESSION_SECRET`.
- **Local dev:** put them in `.dev.vars` (git-ignored).

**Choosing good values**

- `ADMIN_PASSWORD` — a long, unique passphrase from a password manager. Don't
  reuse a password from anywhere else.
- `SESSION_SECRET` — a long random string, e.g. `openssl rand -base64 32`. It
  never needs to be memorable: generate it once and keep it in your password
  manager. Using a real random secret (rather than anything derived from the
  password) keeps admin sessions strong regardless of how simple the password
  is, and avoids any per-request CPU cost on the Workers free tier.

**When to change them**

- Rotate `ADMIN_PASSWORD` if it may have been seen or shared, when someone with
  access leaves, and periodically as good hygiene.
- Rotate `SESSION_SECRET` only if you suspect a session/cookie was compromised.
  ⚠️ Changing it **signs out every admin** — everyone simply logs in again.
- After changing either value, **redeploy** (the dashboard's *Save and deploy*
  does this for you).

Never commit these to git, paste them into chat, or include them in
screenshots. `.dev.vars` is git-ignored for exactly this reason.

---

## Data model

`members` (one row per submission): opaque `public_id`, name, optional private
`email`, `location_name` + `lat`/`lng`, `bio`, `contact_label`/`contact_url`,
`consent_public`, moderation `status`, `edit_token_hash`, salted `ip_hash`, and
timestamps.

Public visibility requires `status = 'published'` **and** `consent_public = 1`.

`settings` (key/value): dashboard-configurable branding + integration overrides
(see [Dashboard settings](#dashboard-configurable-settings)).

`login_attempts` (one row per IP hash): failure counters + lockout time backing
the admin sign-in brute-force protection.

---

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Local dev server (Wrangler + Miniflare). |
| `npm run deploy` | Deploy the Worker to Cloudflare (the schema self-initialises on first use). |
| `npm run typecheck` | Type-check the Worker with `tsc`. |
| `npm run vendor` | Copy Leaflet assets into `public/vendor`. |
| `npm run db:migrate:local` / `:remote` | Apply D1 migrations. |

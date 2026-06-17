# Member Map

A **spatial member directory** on a world map, hosted entirely on Cloudflare.
Members add themselves through a simple, opt-in form; each submission appears as
a pin on a shared map. Members can edit or remove their own entry later, and
admins can fix or remove any entry.

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
- **Members edit their own entry** two ways:
  1. **Secret edit link** — shown once on submission and (optionally) emailed.
     Works out of the box with zero extra configuration.
  2. **Email magic link** — "email me my edit link" flow, enabled when an email
     provider is configured.
- **Admin dashboard** at `/admin` — view every entry (including hidden/pending),
  edit any field, move pins, change moderation status, and delete entries.
- **Security baked in** (see [Security](#security)).
- **Optional moderation** — require admin approval before entries go public.

---

## Architecture

```
Browser ─┬─► /api/*  ─► Cloudflare Worker (src/) ─► D1 (SQLite)
         │                 └─► Nominatim (geocode proxy), Resend (optional email)
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
| `src/validate.ts`             | Input validation + contact normalisation        |
| `src/db.ts`                   | D1 queries (parameterised)                      |
| `src/geocode.ts`              | Nominatim forward-geocoding proxy               |
| `src/email.ts`                | Optional Resend email sender                    |
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
   a `database_id`, Cloudflare creates the database on *your* account and writes
   the generated id back into *your* copy of the config. Nothing
   account-specific is ever committed here.
3. **Prompt you for the secrets** listed in `.dev.vars.example`
   (`ADMIN_PASSWORD`, `SESSION_SECRET`) and store them as encrypted Worker
   secrets.
4. **Build and deploy**, and wire up **Workers Builds CI/CD** so every push to
   your production branch redeploys automatically (pull requests get preview
   URLs).

Database migrations run automatically: the `deploy` script in `package.json`
(`wrangler deploy && wrangler d1 migrations apply DB --remote`) is used as the
deploy command, so the schema is created on the first deploy and kept up to date
on every subsequent one. Migrations are idempotent, so re-running is safe.

After the first deploy, set any **optional** secrets you want (email, Turnstile)
from the table below — in the dashboard under **Workers & Pages → your Worker →
Settings → Variables and Secrets**, or with `wrangler secret put <NAME>`.

### Connect an existing repo via the dashboard

If you'd rather connect this repo manually (**Workers & Pages → Create → Workers
→ Connect to Git**): pick your production branch, leave the **build command**
empty (the front-end libs are already vendored into `public/`), and set the
**deploy command** to `npm run deploy`. Add the required secrets to the Worker
afterwards. The first deploy auto-provisions D1 and applies migrations.

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
npm run deploy                              # deploys, then applies migrations
```

`npm run vendor` runs against `node_modules`, so make sure `npm install` has run
before re-vendoring (the vendored files in `public/vendor` are committed, so this
is only needed when bumping the Leaflet version).

### Optional configuration

| Setting | Type | Effect |
| ------- | ---- | ------ |
| `APP_NAME` | var | Title shown in the UI and emails. |
| `PUBLIC_BASE_URL` | var | Absolute origin used to build edit links in emails (e.g. `https://members.example.com`). Falls back to the request host. |
| `MODERATION_ENABLED` | var | `"true"` holds new entries as **pending** until an admin publishes them. |
| `TURNSTILE_SITE_KEY` | var | Public [Turnstile](https://developers.cloudflare.com/turnstile/) key — shows the anti-spam widget. |
| `TURNSTILE_SECRET` | secret | Turnstile secret — the Worker verifies the token. The CSP already allows `challenges.cloudflare.com`. |
| `RESEND_API_KEY` | secret | Enables email (edit-link + magic-link) via [Resend](https://resend.com). |
| `EMAIL_FROM` | secret | Verified sender address, e.g. `Member Map <map@example.com>`. |

Set secrets with `wrangler secret put <NAME>`; set vars in `wrangler.json`.

---

## Member edit flows

- **On submission**, the member is shown a one-time **edit link**
  (`/edit?id=…#k=<token>`). The raw token is **never stored** — only its
  SHA-256 hash — and the link fragment (`#k=`) is never sent to the server in
  normal navigation, so it stays out of logs.
- If email is configured and the member supplied an address, the same link is
  emailed to them.
- The **"email me my edit link"** flow (`/edit` with no link) issues a
  single-use, 30-minute **magic link**. Clicking it grants a short-lived,
  member-scoped signed session that authorises editing that one entry. To avoid
  leaking who's in the directory, the request endpoint always returns the same
  generic response.

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
| Auth (members) | Unguessable 256-bit edit token; only its **hash** is stored; constant-time comparison. |
| Auth (admins) | Password compared in constant time; session is an **HMAC-signed**, expiring cookie. |
| Account enumeration | The edit-link-by-email endpoint returns an identical response whether or not the email exists. |
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

---

## Data model

`members` (one row per submission): opaque `public_id`, name, optional private
`email`, `location_name` + `lat`/`lng`, `bio`, `contact_label`/`contact_url`,
`consent_public`, moderation `status`, `edit_token_hash`, salted `ip_hash`, and
timestamps. `magic_links` holds short-lived, single-use email tokens.

Public visibility requires `status = 'published'` **and** `consent_public = 1`.

---

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Local dev server (Wrangler + Miniflare). |
| `npm run deploy` | Deploy the Worker to Cloudflare, then apply remote D1 migrations. |
| `npm run typecheck` | Type-check the Worker with `tsc`. |
| `npm run vendor` | Copy Leaflet assets into `public/vendor`. |
| `npm run db:migrate:local` / `:remote` | Apply D1 migrations. |

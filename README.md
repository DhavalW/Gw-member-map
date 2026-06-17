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
Browser ──► Cloudflare Worker (src/) ──► D1 (SQLite)
              │  /api/*   JSON API
              │  /*       static assets (public/) incl. vendored Leaflet
              └─► Nominatim (geocoding proxy), Resend (optional email)
```

| Path                          | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `src/index.ts`                | Worker entry + router                           |
| `src/security.ts`             | CSP/headers, hashing, HMAC sessions, CSRF, escaping |
| `src/validate.ts`             | Input validation + contact normalisation        |
| `src/db.ts`                   | D1 queries (parameterised)                      |
| `src/geocode.ts`              | Nominatim forward-geocoding proxy               |
| `src/email.ts`                | Optional Resend email sender                    |
| `public/`                     | Front-end (map, form, edit, admin) + vendored Leaflet |
| `migrations/`                 | D1 schema migrations                            |

---

## Quick start (local)

```bash
npm install          # installs wrangler, types, and the leaflet libs
npm run vendor       # copies Leaflet into public/vendor (run once / after updates)

# Local secrets for `wrangler dev` (never committed — see .gitignore)
cat > .dev.vars <<'EOF'
ADMIN_PASSWORD="choose-a-strong-password"
SESSION_SECRET="$(openssl rand -base64 32)"
EOF

npm run db:migrate:local    # create the local D1 tables
npm run dev                 # http://localhost:8787
```

Open <http://localhost:8787>, add yourself, then visit `/admin` and sign in with
the `ADMIN_PASSWORD` above.

---

## Deploying to Cloudflare

1. **Authenticate** Wrangler: `npx wrangler login`.
2. **Create the D1 database** and copy the printed `database_id` into
   `wrangler.jsonc` (replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`):
   ```bash
   npx wrangler d1 create gw-member-map
   ```
3. **Apply migrations** to the remote database:
   ```bash
   npm run db:migrate:remote
   ```
4. **Set secrets** (never put these in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put ADMIN_PASSWORD     # admin sign-in password
   npx wrangler secret put SESSION_SECRET      # random 32+ byte string for signing
   ```
5. **Deploy**:
   ```bash
   npm run deploy
   ```

`npm run vendor` runs against `node_modules`, so make sure `npm install` has run
before deploying (the vendored files in `public/vendor` are committed, so this
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

Set secrets with `wrangler secret put <NAME>`; set vars in `wrangler.jsonc`.

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
| `npm run deploy` | Deploy the Worker to Cloudflare. |
| `npm run typecheck` | Type-check the Worker with `tsc`. |
| `npm run vendor` | Copy Leaflet assets into `public/vendor`. |
| `npm run db:migrate:local` / `:remote` | Apply D1 migrations. |

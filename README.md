# OpenLnkd

**Free, open-source, self-hosted LinkedIn automation API**

Automate your LinkedIn job search, scrape profiles, run outreach campaigns and monitor your inbox — all through a clean REST API. No vendor lock-in, no monthly fees, runs entirely on your own machine.

> Built with NestJS + Playwright + TypeScript. Inspired by [OpenWA](https://github.com/rmyndharis/OpenWA).

**This is a headless backend — the API is the product.** There is no bundled UI on purpose: point whatever you like at it. A React/Vue dashboard, an internal tool, a CLI, a Zapier/n8n flow, or an LLM agent that calls the endpoints as tools. Everything LinkedIn-related is behind plain HTTP + JSON, documented in Swagger at `/docs`.

---

## What it does

| Module | Capabilities |
|---|---|
| **Session** | Login with your credentials, persist session cookies to DB, auto-restore on restart (handles LinkedIn's account picker) |
| **Jobs** | Search LinkedIn jobs with filters, save to local DB, scrape full descriptions |
| **Locations** | Autocomplete LinkedIn locations with geoId mapping, cached in DB |
| **Connections** | Send connection invites with optional note, send DMs to existing connections |
| **Templates** | Create reusable message templates with `{variable}` placeholders |
| **People** | Search LinkedIn profiles by title, company or connection degree, save to DB |
| **Outreach** | Bulk messaging campaigns with human delays, recruiter finder, inbox reader |
| **Webhooks** | Register HTTP endpoints to receive new inbox messages in real time |

---

## How it works

OpenLnkd uses a two-layer strategy for every LinkedIn operation:

```
Request
  │
  ├─ 1. Voyager API (fast, no browser)
  │      LinkedIn's internal REST API called with your session cookies.
  │      Returns structured JSON — used for job search, profile search,
  │      job descriptions, typeahead and session validation.
  │
  └─ 2. Browser fallback (Playwright / Chromium)
         When the Voyager endpoint is unavailable or deprecated, OpenLnkd
         opens a real Chromium browser, navigates LinkedIn and scrapes
         the DOM. Used for write operations (invites, messages) and
         whenever the API path fails.
```

Session cookies are stored in the local database after each login. On restart, OpenLnkd validates cookies against the Voyager API — if LinkedIn shows the account picker ("¡Hola de nuevo!"), the browser clicks the account automatically so you don't have to interact with it.

> **Note on write operations:** LinkedIn has deprecated the legacy Voyager messaging and profile endpoints (`identity/profiles/{slug}`, `messaging/conversations` — both now return `HTTP 410 Gone`). Sending messages therefore runs **browser-only**: OpenLnkd navigates directly to the messaging composer (`/messaging/thread/new/?recipient=<slug>`) rather than clicking the "Message" button on the profile page, which is more reliable (single compose box, no restored chat bubbles, send button enables correctly). Reads (job/profile search, typeahead) still use the Voyager API where it remains available.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 LTS |
| Framework | NestJS 11 + TypeScript 5 |
| Browser automation | Playwright 1.60 (Chromium) |
| Database | SQLite via `better-sqlite3` (default), PostgreSQL-ready |
| API docs | Swagger UI — `http://localhost:3000/docs` |
| Scheduling | `@nestjs/schedule` (webhook polling) |

---

## Quick start

### Option A — Docker (recommended)

No Node, no Chromium setup, no OS dependencies — everything ships inside the image.

```bash
git clone https://github.com/ismaweltech/openlnkd.git
cd openlnkd
cp .env.example .env     # put your LinkedIn credentials here
docker compose up -d
```

That's it: API on `http://localhost:3000`, Swagger on `/docs`. The SQLite database (including your session cookies) persists in a named volume across restarts.

To update after a new release:

```bash
git pull && docker compose up -d --build
```

> Chromium inside a container needs shared memory — the compose file already sets `shm_size: 1gb`, so don't remove it.

### Option B — Manual install

### 1. Clone and install

```bash
git clone https://github.com/ismaweltech/openlnkd.git
cd openlnkd
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# LinkedIn credentials (required)
LINKEDIN_EMAIL=your@email.com
LINKEDIN_PASSWORD=yourpassword

# Database — SQLite by default
DATABASE_PATH=./data/openlnkd.db
# DATABASE_URL=postgres://user:pass@localhost:5432/openlnkd  # use this for PostgreSQL

# Server
PORT=3000

# Browser behaviour
HEADLESS=true    # set to false to watch the browser in action
SLOW_MO=50       # ms delay between Playwright actions — increase if getting blocked
```

### 3. Build and run

```bash
# Production
npm run build
node dist/main.js

# Development (hot reload)
npm run start:dev
```

**Endpoints available at:**
- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`

---

## API Reference

### Session

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/session/login` | Authenticate with LinkedIn |
| `GET` | `/session/status` | Check if session is active |
| `DELETE` | `/session/logout` | Clear session and cookies |

```bash
# Login using credentials from .env
curl -X POST http://localhost:3000/session/login \
  -H "Content-Type: application/json" -d '{}'

# Or pass credentials explicitly
curl -X POST http://localhost:3000/session/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@email.com", "password": "yourpassword"}'
```

**Session restore on restart:** cookies are saved to the DB after every login. When the server starts, it attempts to revalidate them automatically — no manual re-login needed in most cases. If LinkedIn shows the account picker, the browser handles it without user interaction.

---

### Jobs

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/jobs/search` | Search LinkedIn jobs and save results to DB |
| `GET` | `/jobs` | List saved jobs with optional filters |
| `GET` | `/jobs/:id` | Get a single saved job |
| `GET` | `/jobs/:id/description` | Get full job description (scrapes if not cached) |
| `PATCH` | `/jobs/:id/applied` | Mark job as applied |
| `PATCH` | `/jobs/:id/saved` | Mark job as saved/bookmarked |

**Search:**

```bash
curl -X POST http://localhost:3000/jobs/search \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "product manager",
    "location": "Spain",
    "remote": true,
    "easyApply": true,
    "datePosted": "pastWeek",
    "limit": 25
  }'
```

| Param | Type | Options |
|---|---|---|
| `keywords` | string | required |
| `location` | string | city or country, e.g. `"Spain"`, `"Barcelona"` |
| `remote` | boolean | |
| `easyApply` | boolean | |
| `datePosted` | string | `past24h` / `pastWeek` / `pastMonth` |
| `limit` | number | default `25` |

**List filters (combinable):**

```
GET /jobs?easyApply=true&keyword=AI&notApplied=true
```

| Filter | Description |
|---|---|
| `keyword` | Search in title and cached description |
| `company` | Partial company name match |
| `easyApply=true/false` | Easy Apply badge |
| `hasDescription=true/false` | Description cached in DB |
| `applied=true/false` | Applied status |
| `saved=true/false` | Saved/bookmarked |
| `notApplied=true` | Pending jobs (not yet applied) |

**Description scraping strategy** (in order of priority):
1. Voyager REST API — `GET /voyager/api/jobs/jobPostings/:id`
2. RSC response interception (React Server Components)
3. DOM selector extraction after expanding "Show more"
4. JSON-LD structured data fallback

---

### Locations

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/locations/typeahead` | Autocomplete a location name to LinkedIn geoId |

```bash
GET /locations/typeahead?q=Barcelona
# → [{ "label": "Barcelona, Spain", "geoId": "88" }]
```

Results are cached in the database — repeated queries resolve instantly without hitting LinkedIn.

---

### Connections

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/connections/invite` | Send a connection request with optional note |
| `POST` | `/connections/message` | Send a DM to an existing connection |
| `GET` | `/connections` | List all tracked connections |

```bash
# Connection invite (note max 300 chars)
curl -X POST http://localhost:3000/connections/invite \
  -H "Content-Type: application/json" \
  -d '{
    "profileUrl": "https://www.linkedin.com/in/someone/",
    "message": "Hi! I came across your profile and would love to connect."
  }'

# Direct message
curl -X POST http://localhost:3000/connections/message \
  -H "Content-Type: application/json" \
  -d '{
    "profileUrl": "https://www.linkedin.com/in/someone/",
    "message": "Hey! Saw you work at Acme — would love to chat."
  }'
```

---

### Templates

Reusable message templates. Variables in `{curly braces}` are auto-detected on save and substituted at send time.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/templates` | Create a template |
| `GET` | `/templates` | List all templates |
| `GET` | `/templates/:id` | Get a single template |
| `DELETE` | `/templates/:id` | Delete a template |

```bash
curl -X POST http://localhost:3000/templates \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cto-outreach",
    "body": "Hi {name},\n\nI came across your profile and was impressed by your work as {title} at {company}. I'\''m a senior PM exploring new opportunities — would you be open to a quick chat?\n\nBest,\nAlex"
  }'

# Response includes the detected variables:
# { "id": 1, "variables": ["name", "title", "company"], ... }
```

**Built-in variables** (populated automatically from profile scraping):

| Variable | Value |
|---|---|
| `{name}` | First name |
| `{fullName}` | Full name |
| `{title}` | LinkedIn headline |
| `{company}` | Company extracted from headline |
| Any `{custom}` | Pass via `vars` in campaign or recruiter endpoint |

---

### People

Search LinkedIn profiles by role, company or connection degree. Results are saved to the DB and can be fed directly into campaigns.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/people/search` | Search LinkedIn profiles and save to DB |
| `GET` | `/people` | List saved profiles with filters |

```bash
# Find CTOs in Spain who are 2nd-degree connections
curl -X POST http://localhost:3000/people/search \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "CTO",
    "location": "Spain",
    "connectionDegree": "2nd",
    "limit": 20
  }'

# Filter the saved results
GET /people?keyword=CTO&company=Acme
GET /people?connectionDegree=1st
```

| Param | Options |
|---|---|
| `keywords` | Role, name, skill — any text |
| `connectionDegree` | `1st` / `2nd` / `3rd` |
| `company` | Current company name |
| `location` | City or country |
| `limit` | Max results, default `25` |

---

### Outreach

The full outreach system: campaigns, recruiter messaging and inbox reading.

#### Campaigns

Create a list of target profiles + a template, then run. OpenLnkd visits each profile, scrapes the name, renders the template and sends the message with a human-like random delay between each.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/outreach/campaigns` | Create a campaign |
| `POST` | `/outreach/campaigns/:id/run` | Execute a campaign |
| `GET` | `/outreach/campaigns` | List all campaigns |
| `GET` | `/outreach/campaigns/:id` | Campaign detail with per-target status |

```bash
# 1. Create
curl -X POST http://localhost:3000/outreach/campaigns \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CTO outreach — May 2026",
    "templateId": 1,
    "profileUrls": [
      "https://www.linkedin.com/in/someone/",
      "https://www.linkedin.com/in/another/"
    ],
    "filterConnections": true,
    "delayMin": 30,
    "delayMax": 90
  }'

# 2. Run
curl -X POST http://localhost:3000/outreach/campaigns/1/run
# → { "ok": true, "sent": 2, "failed": 0, "skipped": 0 }
```

| Param | Type | Description |
|---|---|---|
| `templateId` | number | Template to use |
| `profileUrls` | string[] | LinkedIn profile URLs |
| `filterConnections` | boolean | Skip non-connections — **recommended** to avoid failed sends |
| `delayMin` | number | Min seconds between sends (default `30`) |
| `delayMax` | number | Max seconds between sends (default `90`) |

**Per-target status flow:** `pending` → `sent` / `skipped` / `failed`

**What happens on run:**
1. Visits each profile to scrape the name and detect connection degree — a 1st-degree connection is identified by the distance badge next to the name (`· 1º` / `· 1er` / `· 1st`)
2. If `filterConnections: true` and not a 1st-degree connection → marks as `skipped`
3. Renders the template substituting `{name}`, `{company}`, `{title}`
4. Navigates to the messaging composer (`/messaging/thread/new/?recipient=<slug>`), types the message and sends, then confirms it landed in the thread
5. Waits a random delay before the next target

#### Recruiter finder

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/outreach/jobs/:jobId/recruiter` | Find the hiring manager of a job listing |
| `POST` | `/outreach/jobs/:jobId/message-recruiter` | Message the recruiter using a template |

```bash
# Find the recruiter for job ID 4410377468
GET /outreach/jobs/4410377468/recruiter

# Message them
curl -X POST http://localhost:3000/outreach/jobs/4410377468/message-recruiter \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": 1,
    "vars": { "company": "Dedge Security", "role": "Senior PM" }
  }'
```

#### Inbox

```bash
GET /outreach/inbox?limit=20
```

Returns recent LinkedIn conversations with sender name, message preview and unread status.

---

### Webhooks

Register HTTP endpoints to receive new inbox messages automatically. A scheduler ticks every 60 seconds and, for each active webhook whose `interval_sec` has elapsed (default `300`), polls the inbox and fires a `POST` request to your registered URL when new messages arrive.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/webhooks` | Register a webhook |
| `GET` | `/webhooks` | List all webhooks |
| `GET` | `/webhooks/:id` | Get a webhook |
| `DELETE` | `/webhooks/:id` | Delete a webhook |
| `POST` | `/webhooks/:id/enable` | Enable a webhook |
| `POST` | `/webhooks/:id/disable` | Disable a webhook |
| `POST` | `/webhooks/:id/test` | Send a test payload |

```bash
# Register
curl -X POST http://localhost:3000/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Inbox alerts",
    "url": "https://your-app.com/hook/linkedin",
    "secret": "optional-hmac-secret",
    "events": ["new_messages"],
    "interval_sec": 60
  }'
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Optional label for the webhook |
| `url` | string | **Required.** Endpoint that receives the `POST` |
| `secret` | string | Optional — sent as the `X-OpenLnkd-Secret` request header |
| `events` | string[] | Event types to subscribe to (default `["new_messages"]`) |
| `interval_sec` | number | Poll interval in seconds (default `300`) |

**Payload delivered to your URL:**

```json
{
  "event": "new_messages",
  "timestamp": "2026-05-26T10:00:00.000Z",
  "count": 1,
  "messages": [
    {
      "senderName": "John Doe",
      "senderUrl": "https://www.linkedin.com/in/johndoe",
      "preview": "Hey, wanted to follow up on...",
      "timestamp": "2026-05-26T09:58:00.000Z",
      "unread": true
    }
  ]
}
```

If a `secret` was set, it is sent as the `X-OpenLnkd-Secret` header. Messages are deduplicated by fingerprint — each conversation fires a webhook only once per new message.

---

## Typical workflow

```bash
# 1. Authenticate
POST /session/login

# 2. Search for relevant jobs
POST /jobs/search  { "keywords": "Senior PM", "location": "Spain", "remote": true }

# 3. Load full descriptions for interesting jobs
GET /jobs/4391859593/description

# 4. Mark applied once you submit
PATCH /jobs/4391859593/applied

# 5. Find target profiles
POST /people/search  { "keywords": "Head of Product", "connectionDegree": "1st", "limit": 20 }

# 6. Create a message template
POST /templates  { "name": "intro", "body": "Hi {name}, I'm exploring PM roles at {company}..." }

# 7. Run a campaign
POST /outreach/campaigns  { "templateId": 1, "profileUrls": [...], "filterConnections": true }
POST /outreach/campaigns/1/run

# 8. Track results
GET /outreach/campaigns/1

# 9. Set up a webhook to get notified of replies
POST /webhooks  { "url": "https://your-app.com/hook", "interval_sec": 60 }
```

---

## Database

SQLite by default at `./data/openlnkd.db`. Switch to PostgreSQL by setting `DATABASE_URL`.

| Table | Contents |
|---|---|
| `session` | Session cookies (JSON) for auto-restore |
| `jobs` | Scraped job listings with apply/save status |
| `companies` | Company metadata |
| `connections` | Sent invites and their status |
| `messages` | Outgoing message log |
| `templates` | Message templates with extracted variables |
| `people` | Scraped LinkedIn profiles |
| `campaigns` | Outreach campaigns with progress counters |
| `campaign_targets` | Per-profile send status within each campaign |
| `location_cache` | Typeahead cache — location text → LinkedIn geoId |
| `webhooks` | Registered webhook endpoints |
| `webhook_seen` | Message fingerprints already dispatched (deduplication) |

---

## Roadmap

- [x] Session management — login, cookie persistence, auto-restore with account picker support
- [x] Job search with filters (keywords, location, remote, Easy Apply, date)
- [x] Full job description scraping (Voyager API → RSC → DOM → JSON-LD)
- [x] Job list filters (Easy Apply, keyword, company, applied, saved…)
- [x] Connection invites with optional personalised note
- [x] Direct messaging to existing connections
- [x] Message templates with `{variable}` placeholders
- [x] People / profile search by role, company, connection degree
- [x] Bulk outreach campaigns with human-like random delays
- [x] Auto-detect 1st-degree connections before sending (`filterConnections`)
- [x] Recruiter finder from job listings
- [x] LinkedIn inbox reader
- [x] Location typeahead with geoId mapping and DB cache
- [x] Webhooks — receive new messages as HTTP events
- [ ] Easy Apply automation
- [x] Docker Compose setup (Playwright base image, persistent volume)
- [ ] Proxy rotation for safer scraping at scale
- [ ] PostgreSQL — full validation and migration scripts

---

## Known limitations

| Limitation | Notes |
|---|---|
| **LinkedIn ToS** | This project violates LinkedIn's Terms of Service. Use for personal automation only. |
| **Account risk** | Aggressive or high-volume use may trigger rate limits or temporary blocks. The random delays and human-like timing mitigate this. |
| **2FA** | If LinkedIn prompts for an email/SMS verification code during login, the automated login will fail — you will need to complete it manually once and then the session persists. |
| **Voyager API deprecations** | LinkedIn removes internal API endpoints without notice — the legacy messaging and profile endpoints already return `HTTP 410 Gone`. OpenLnkd falls back to browser automation automatically, so write operations (messaging) are browser-driven and therefore slower than a pure API call. |
| **Hashed CSS classes** | LinkedIn now ships hashed, non-semantic class names (`_82eace64`…) for most UI. OpenLnkd relies on stable selectors instead — HTML attributes (`contenteditable`, `type="submit"`), `aria-label` text and role attributes — but a major UI overhaul can still require selector updates. |
| **RSC parsing fragility** | LinkedIn's React Server Component responses can change with UI updates. Description scraping has four fallback layers to handle this. |
| **Single account** | Designed to run with one LinkedIn account. Multi-account support is not planned. |
| **No proxy support** | All requests originate from the same IP. For large-scale use, consider running separate instances behind different IPs. |

---

## Disclaimer

This project uses browser automation to interact with LinkedIn and is intended for **personal use only**. It is not affiliated with, endorsed by, or sponsored by LinkedIn Corporation.

Use it responsibly. Do not use it for spam, commercial scraping or any activity that violates applicable laws or LinkedIn's Terms of Service. The authors take no responsibility for account restrictions, bans or any other consequences.

---

## License

MIT

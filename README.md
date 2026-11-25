# Family Secret Santa

A family gift-exchange app with separate **Adult** and **Kid** drawings, household rules, and a spinning wheel reveal.

- **Frontend:** plain HTML/CSS/JS in the project root. No build step.
- **Backend:** Vercel Serverless Functions in `/api`.
- **Database:** Upstash Redis is the **only** persistent store. The browser never talks to Redis; it only calls `/api/*`.

## How it works

1. The organizer signs in at `/admin`, adds households and people, and marks each person as an adult or a kid.
2. Family members open the site and claim their name. Parents can claim their kids' names on the same phone. Each claim gives the device a secret token (kept in an HttpOnly cookie) and shows a one-time **recovery code** for other devices.
3. The organizer clicks **Make the drawing** for each pool. The server computes every match, validates it, and saves it to Redis. From then on that pool's family list is locked.
4. Each person taps **Spin**. The server returns their pre-decided recipient, and the wheel animates to land on it. The wheel never decides anything.

Matching rules, enforced on the server for each pool: nobody draws themselves, nobody draws someone in their own household, everybody gives exactly one gift and receives exactly one gift.

## Project layout

```
index.html              Participant page
admin.html              Organizer dashboard
assets/
  styles.css            Shared styles
  common.js             fetch wrapper + DOM helpers
  app.js                Participant page logic
  wheel.js              Canvas wheel (visual only)
  admin.js              Organizer dashboard logic
api/
  state.js              GET  public overview (names, households, claim status)
  claim.js              POST claim a name
  me.js                 GET  names on this device / POST recover or forget
  spin.js               POST reveal your recipient
  health.js             GET  setup check (no secrets returned)
  admin/session.js      GET/POST/DELETE organizer login
  admin/households.js   CRUD households
  admin/members.js      CRUD people + release a claim
  admin/settings.js     Event details
  admin/drawings.js     Status/progress, generate, reset
  _lib/                 Shared server code (underscore = not deployed as an endpoint)
    redis.js            Redis initialization + key structure
    scripts.js          Lua scripts for every atomic operation
    matching.js         Matching engine
    security.js         Tokens, hashing, sessions, rate limiting
    http.js             Request/response helpers, CSRF checks
    validate.js         Input validation
    data.js             Read helpers
tests/matching.test.js  Unit tests for the matching engine (npm test)
vercel.json             Security headers, clean URLs
```

That's 10 serverless functions, which fits Vercel's Hobby plan limit of 12.

## 1. Create the Upstash Redis database

1. Sign in at <https://console.upstash.com> and click **Create Database**.
2. Give it a name (e.g. `secret-santa`), choose the **Regional** type, and pick the region closest to your Vercel deployment (Vercel's default is Washington D.C., `iad1`, so choose `us-east-1`).
3. Open the database and go to the **REST API** section. Copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN` (use the normal token, **not** the read-only one)

Alternatively, in the Vercel dashboard go to **Storage → Create Database → Upstash for Redis** (Marketplace). That creates the database and adds the two variables to your project automatically. If it adds them as `KV_REST_API_URL` / `KV_REST_API_TOKEN`, also add copies named `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.

No schema setup is needed: keys are created on first use.

## 2. Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, click **Add New → Project** and import the repository.
3. Framework preset: **Other**. Leave Build Command and Output Directory empty. Root directory: the folder containing `package.json`.
4. Add the environment variables below, then click **Deploy**.

Or from the command line: `npm i -g vercel`, then `vercel` in this folder, then `vercel env add ...` for each variable and `vercel --prod`.

## 3. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (Production, and Preview if you use preview deployments):

| Name | Value |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | From the Upstash REST API section |
| `UPSTASH_REDIS_REST_TOKEN` | From the Upstash REST API section |
| `ADMIN_PASSWORD` | The organizer password. Use a long passphrase. |
| `SESSION_SECRET` | A random string of **at least 32 characters**, used to sign the admin cookie |
| `REDIS_KEY_PREFIX` | Optional. Defaults to `ss:`. Change it to run several exchanges in one database. |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

After changing variables, redeploy so the functions pick them up. Then open `https://<your-app>.vercel.app/api/health`. It should report `"ok": true`. If not, it tells you which setting is missing (it never shows the values).

## 4. Run the exchange

1. Go to `/admin` and sign in with `ADMIN_PASSWORD`.
2. **Event details:** set the name, date, location, budgets and notes.
3. **Family:** add households, then people. Duplicate names are rejected, so add an initial if two people share a name.
4. Share the site link with the family so everyone can claim their name.
5. **Drawings:** click **Make the drawing** for Adults and for Kids. If the households make a drawing impossible (for example one household is more than half of a pool), the page explains why before you try.
6. Watch the progress bars as people spin. You see who has spun, never who drew whom.

### Changing things after a drawing

- Fixing the spelling of a name is always allowed.
- Adding or deleting someone, or moving someone to another household or pool, is blocked while that pool's drawing is active. **Reset drawing** (you must type `RESET ADULT` or `RESET CHILD`) clears that pool's matches, then make a new drawing. Everyone in that pool will need to spin again.
- If someone loses their phone and recovery code, use **Release** on their row. They can then claim their name again; their match does not change.

## Security & privacy

- **Admin auth:** the password is checked only on the server (constant-time comparison). A successful login creates a random session ID stored in Redis with an 8-hour TTL; the browser gets it in an HMAC-signed `HttpOnly; Secure; SameSite=Strict` cookie. Every `/api/admin/*` endpoint validates the session.
- **Participant tokens:** 256-bit random tokens from `crypto.randomBytes`. Only their SHA-256 hashes are stored in Redis. Tokens live in an `HttpOnly` cookie, so page JavaScript cannot read them; the recovery code is shown once.
- **Assignments:** stored only in `assignments:{pool}`. A participant can fetch only the recipient for a name claimed on their own device. No endpoint returns the full assignment table, including the admin endpoints.
- **CSRF:** cookies are `SameSite=Strict`, state-changing requests must be `application/json`, and a mismatched `Origin` header is rejected.
- **Rate limiting:** per-IP fixed windows in Redis (atomic Lua `INCR`/`PEXPIRE`), with a stricter limit on login (8 per 15 minutes per IP, 40 globally) and on recovery-code attempts.
- **Validation:** every input is checked server-side (ID format, name characters and length, enums, dates, text lengths). The frontend renders all names with `textContent`, never HTML.
- **Headers:** `vercel.json` sets a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, and `Cache-Control: no-store` on the API.

Known trade-off: anyone with the link can claim any unclaimed name. That's the usual family-exchange model; if someone claims the wrong name, the organizer can release it.

## Data consistency

Every write that must not race is a single Lua script, so it runs atomically inside Redis:

| Risk | Protection |
| --- | --- |
| Two people claim the same name | `CLAIM` uses `HSETNX` on `participants:claims` |
| Duplicate recipients / invalid matches | Matches are validated in JS, then `COMMIT_DRAWING` re-checks for self-matches and duplicate recipients while writing |
| Two drawings generated at once | `SET lock:drawing:{pool} NX PX` mutex, plus `COMMIT_DRAWING` refuses if the drawing already exists |
| Family list changes during generation | Every structural change bumps `family:config-version`; the commit fails if the version moved, and generation retries with fresh data |
| Edits to a drawn pool | `CREATE_MEMBER` / `UPDATE_MEMBER` / `DELETE_MEMBER` check the pool's drawing key inside the same script |
| Unauthorized resets | Admin session required, exact confirmation phrase, and the generation lock is held during the reset |

## Redis key structure

All keys are prefixed with `REDIS_KEY_PREFIX` (default `ss:`).

| Key | Type | Contents |
| --- | --- | --- |
| `family:members` | Set | Member IDs |
| `family:member:{id}` | Hash | `id, name, nameKey, householdId, category, claimed, claimedAt, createdAt` |
| `family:member-names` | Hash | normalized name → member ID (uniqueness) |
| `family:households` | Set | Household IDs |
| `family:household:{id}` | Hash | `id, name, createdAt` |
| `family:config-version` | String | Counter bumped by structural changes |
| `participants:claims` | Hash | member ID → token hash |
| `participants:tokens` | Hash | token hash → member ID |
| `drawings:{adult\|child}` | Hash | `status, pool, generatedAt, participantCount, configVersion, participants` |
| `assignments:{adult\|child}` | Hash | giver ID → recipient ID (private) |
| `progress:{adult\|child}` | Hash | giver ID → revealed-at timestamp |
| `lock:drawing:{adult\|child}` | String | Short-lived generation mutex |
| `settings:app` | Hash | Event name, date, location, budgets, notes |
| `admin:session:{sid}` | String | Admin session (TTL 8h) |
| `ratelimit:{bucket}:{ipHash}` | String | Rate-limit counter (auto-expires) |

To wipe everything and start over, delete all keys with the prefix from the Upstash console's Data Browser (or run `FLUSHDB` in its CLI if the database is used only by this app).

## Local development

```bash
npm install
npm test                 # matching engine tests
npx vercel dev           # serves the site and /api on http://localhost:3000
```

`vercel dev` reads variables from a `.env` file (see `.env.example`). It uses your real Upstash database, so consider a separate database or `REDIS_KEY_PREFIX=dev:` for development.

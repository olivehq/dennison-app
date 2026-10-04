# AW Appointment Matching App

Matches buyers with suppliers for the AW appointment show, lets Dennison & Associates staff review and adjust the schedule, and gives every participant a private link to their own schedule.

Built by Olive Technologies. Requirements are in `docs/PROJECT_SCOPE.md`.

## Run it locally

```bash
pnpm install
cp .env.example .env.local   # optional, everything has a local default
pnpm db:migrate
pnpm db:seed                 # demo event with the 2025 schedule, admin login printed at the end
pnpm dev
```

Open http://localhost:3000. With no `DATABASE_URL` the app uses an embedded Postgres (PGlite) under `.data/` (or `$LOCAL_DATA_DIR`), so nothing else needs to be running.

## Checks

```bash
pnpm check   # typecheck, lint, tests
```

## Deploy

One Vercel project on the Pro plan (scope section 8). Production deploys from `main`; every pull request gets a preview.

### Project settings

| Setting | Value |
|---|---|
| Framework | Next.js |
| Install command | `pnpm install` (default) |
| Build command | `pnpm db:migrate && pnpm build` |
| Node.js version | 22.x |

The build migrates the deployment's own database before `next build`. A failed migration fails the deploy and the previous deployment keeps serving.

### Integrations

- **Neon** from the Vercel Marketplace. Turn on "Create a database branch for each preview deployment" so previews never touch production data. It sets `DATABASE_URL`.
- **Vercel Blob**: create a store and connect it to the project. It sets `BLOB_READ_WRITE_TOKEN`.
- **Sentry** from the Vercel Marketplace, project type Next.js. It sets `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN`, so source maps upload on each build. Copy the project's DSN into `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`. In Sentry, send issue alerts to Olive's support inbox.
- **Resend**: add D&A's sending domain and give D&A the DNS records. Add a webhook to `https://<app domain>/api/webhooks/resend` for the email events and copy its signing secret into `RESEND_WEBHOOK_SECRET`.

### Environment variables

Set per environment (Production and Preview) in Vercel. `.env.example` has the same list with comments.

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Neon integration |
| `APP_URL` | The public URL, for example `https://schedule.dennisonassociates.com`. Links in emails use it |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `TOKEN_PEPPER` | `openssl rand -base64 32`. Changing it breaks every issued participant link |
| `BLOB_READ_WRITE_TOKEN` | Blob store |
| `RESEND_API_KEY` | Resend, an API key with send access |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret |
| `EMAIL_FROM` | `Name <address@verified-domain>` |
| `CRON_SECRET` | `openssl rand -base64 32`. Vercel Cron sends it; without it the cron route answers 503 |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Sentry project settings |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Sentry integration (build only) |

`LOCAL_DATA_DIR` is for local runs only; leave it unset on Vercel.

### Cron and data retention

`vercel.json` runs `GET /api/cron/retention` every day at 09:00 UTC. It deletes an event's participant data once 90 days have passed since the show and archives the event, unless "Keep participant data after 90 days" is on in the event's settings. Turn that on only when D&A has asked in writing (SOW section 4). The run shows on the event's Activity page. To run it by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<app domain>/api/cron/retention
```

### First admin

Run once against the production database, from a machine with the repo:

```bash
DATABASE_URL="<production DATABASE_URL from Neon>" pnpm create-admin you@example.com "Your Name" '<password of 10+ characters>'
```

Everyone else joins through an invite from the Team page.

### Uptime monitoring

Check these two URLs every 5 minutes and alert `<alert address>` when either fails:

1. `https://<app domain>/login` (expects 200).
2. A participant link from a dedicated test event: create an event named "Uptime test", add one buyer and one supplier, run matching, lock, download the access list, and use the buyer's link (expects 200 and the text "Your appointments"). Give that event a date a year ahead, since links expire 60 days after the event date (D65), and keep "Keep participant data after 90 days" on so the retention job leaves it alone. The monitor's requests count toward the 60-per-10-minutes participant limit only for its own IP.

### Rollback

- Code: Vercel dashboard, Deployments, pick the previous production deployment, Instant Rollback. A rollback does not undo migrations, so keep migrations additive.
- Data: Neon point-in-time restore to a new branch at a time before the mistake, check it, then point `DATABASE_URL` at it or copy the rows back.

## Docs

- `AGENTS.md`: how the code is organised and the rules for changing it.
- `docs/ARCHITECTURE.md`: layers, modules, engine contract, theme.
- `docs/DECISIONS.md`: choices made where the requirements were silent.

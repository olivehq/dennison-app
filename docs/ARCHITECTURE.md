# Architecture

One Next.js 16 application. Admin pages, the participant page, server logic, and the matching engine live in one codebase with folder boundaries enforced by lint rules.

## Layers and direction of dependencies

```
app (routes)  ->  server (queries, actions)  ->  db (drizzle)
                        |
                        v
                     engine (pure)        lib (shared helpers, adapters)
components/app  ->  components/ui (shadcn)
```

- `src/app` imports from `src/server`, `src/components`, `src/lib`. It never imports `src/db` directly.
- `src/server` imports `src/db`, `src/engine`, `src/lib`. It never imports React or anything under `src/components`.
- `src/engine` imports only `src/lib/schemas` types and standard JavaScript. No Next, React, database, or environment access. This is enforced by `no-restricted-imports` in `eslint.config.mjs`.
- `src/components` never imports `src/db` or `src/server/*/queries.ts`. Client components receive data as props and call actions from `src/server/*/actions.ts`.

## Modules in `src/server`

| Module | Owns | Key exports |
|---|---|---|
| `auth` | Better Auth instance, session helpers, team management, invites | `getAuth()`, `createAuth(db)`, `getSession()`, `requireSession()`, `requireAdmin()`, `inviteAdmin`, `resendInvite`, `disableAdmin`, `enableAdmin`, `listAdmins`, `getInviteByToken` |
| `events` | Event CRUD, settings, status transitions, lock and unlock, desks | `listEvents`, `getEvent`, `getEventOrThrow`, `getEventCounts`, `createEvent`, `updateEvent`, `updateEventSettings`, `deleteEvent`; later `lockSchedule`, `unlockSchedule`, `assignDesks`. `assertEventEditable(event)` in `events/editable.ts` returns `fail('locked', ...)` for locked, sent, and archived events; every module that mutates event data calls it first, then repeats the check as a compare-and-set inside its transaction with `claimEditableEvent(tx, eventId)` (D85). `archiveEvent` moves any status to archived (D89). `advanceStatus(tx, eventId, from, to)` in `events/status.ts` moves the status forward (D46). `setRetainData` (works in any status but archived) and `deleteExpiredParticipantData(db, now)` in `events/retention.ts`, run by the cron route (D69, D70) |
| `roster` | Participants and suppliers: list, add, edit, withdraw, restore | `listParticipants`, `upsertParticipant`, `withdrawParticipant`, same for suppliers |
| `imports` | File upload, parsing (list and matrix formats, limits in D81), validation report, alias mapping (per event and across years, D76), applying rankings | `createImport`, `validateImport`, `saveAlias`, `saveAliases`, `applyImport`. Templates download from `GET /api/imports/templates/[kind]` (session required) |
| `matching` | Runs the engine, stores runs, compares runs, activates a run, pins, readiness gate | `startRun`, `activateRun`, `compareRuns`, `setPinned`, `matchingReadiness` (D88), `failRunsOlderThan` (D90) |
| `schedule` | Reads for the workspace, manual edits with version check (active run only, D86), swap candidates, lock and desks | `getScheduleView`, `getPersonSchedule`, `replaceAppointment`, `removeAppointment`, `swapCandidates`, `lockSchedule`, `reassignDesks` |
| `exports` | Master CSV, per-person ZIP, quality report, access CSV, export history, the participant page read | `masterScheduleCsv`, `schedulesZip`, `qualityReportText`, `accessCsv`, `exportAvailability`, `recordExport`, `loadParticipantView`. Route Handlers in `src/app/api/exports/[eventId]/` call these (D43) |
| `email` | Campaigns, merge fields, audiences, sending through the adapter, Resend webhooks, changed since last email (D13, D59 to D64) | `createCampaign`, `updateCampaign`, `duplicateCampaign`, `previewCampaign`, `sendTest`, `sendCampaign`, `resendToBounced`, `resolveAudience`, `renderTemplate`, `changedSinceLastSend`, `recordDeliveryEvent`, `handleResendWebhook`; reads `listCampaigns`, `getCampaign`, `getAudienceOptions`, `getEmailSummary`. Webhook route: `POST /api/webhooks/resend` |
| `audit` | Writing and reading `audit_events`, the activity page, plain-English rows | `recordAudit`, `listAudit` (filters: admin, action groups, person, time window), `describeAudit` and `AUDIT_ACTION_GROUPS` in `describe.ts` (pure), `getActivityPage` in `queries.ts`. Undo itself is `undoAudit` in `schedule/edits.ts` (D32) |
| `tokens` | Participant access tokens: issue, verify, revoke, regenerate, reuse (D59), one live link per contact (D84) | `issueTokensForEvent`, `linksForContacts`, `verifyToken`, `revokeToken`, `regenerateToken` |

Each module has `queries.ts` (reads), `actions.ts` (`'use server'` mutations), and optionally internal helpers. Tests sit beside the code. Actions are thin: they call `requireAdmin()`, delegate to a plain module that takes the `db` handle (for example `events/events.ts`, `auth/admins.ts`), then `revalidatePath`. Tests exercise the plain module with `createTestDb()`, since `headers()` and `revalidatePath` need a request.

## Engine contract

```ts
runMatching(input: MatchInput): MatchResult

MatchInput = {
  settings: EventSettings           // slotCount, supplierTarget, buyerMin, buyerMax, buyerIdeal, mutualTopN, hotelRankCutoff
  buyers: Buyer[]                   // id, biztechOptIn
  suppliers: Supplier[]             // id, type: 'business' | 'hotel'
  rankings: Ranking[]               // rankerType, rankerId, targetType, targetId, rank | null, isRejection
  pinned: Appointment[]             // kept as placed
}
MatchResult = {
  appointments: Appointment[]       // slot, buyerId, supplierId, buyerRank, supplierRank, source, pinned
  stats: QualityStats               // sections A to G of the quality report
  warnings: string[]                // human-readable, e.g. "Supplier X filled only 8 of 9"
}
```

Deterministic. Ties are broken by id order.

## Request flow for a manual edit

1. The schedule workspace (client component) calls `replaceAppointment({ runId, version, slot, supplierId, removeBuyerId, addBuyerId })`.
2. The action checks the session, loads the run, compares `version`, checks the event is not locked.
3. In one transaction: delete the old row, insert the new row (unique indexes enforce the hard rules), bump `version`, write `audit_events`, recompute and store `stats`.
4. Returns the new version and the affected people. The client refreshes.

## App composites (`src/components/app`)

Allowed list. Each is built from shadcn primitives. Add a new one only when it has two call sites.

- `PageHeader`: title, status badge, actions.
- `DataTable`: the TanStack wrapper with search, column filters, pagination. `rowClassName` mutes rows such as withdrawn people.
- `RankBadge`: `B:4`, `S:-`, top-10 highlight.
- `AppointmentBlock`: the timeline block, business or hotel tone, match strength treatment.
- `PersonSchedule`: a person's nine slots with OPEN gaps. Used in the detail sheet and the participant page.
- `SlotFilter`: free-in-slot select.
- `FileDropzone`: upload input with drag and drop.
- `ConfirmDialog`: AlertDialog with a typed confirmation for destructive actions.
- `ThemeToggle`: light and dark. `variant="icon"` for toolbars, `variant="menu"` for a sidebar row.

## Theme

Tokens follow the 03 Resource timeline design: putty ground, umber ink, pool teal for hotels, marigold for business, cue red for the now line only, oxblood for count problems. Custom semantic tokens (`--hotel`, `--business`, `--now`, `--warning`, `--open`, each with `-foreground`, `-tint`, `-ink` where the design defines them) are declared in `globals.css` and mapped in `@theme inline`. Fonts: Schibsted Grotesk for display, Atkinson Hyperlegible Next for UI and data, loaded with `next/font/google`.

## Environments

| | Database | Files | Email |
|---|---|---|---|
| Tests | PGlite in memory, migrated per test file | in-memory adapter | logger adapter |
| Local dev, no env | PGlite in `.data/pglite` (`$LOCAL_DATA_DIR/pglite`) | `.data/uploads` | logger adapter |
| Local dev, Docker | postgres.js to `DATABASE_URL` | `.data/uploads` | logger or Resend |
| Vercel preview | Neon branch per preview | Vercel Blob | Resend, test domain |
| Vercel production | Neon main | Vercel Blob | Resend, D&A domain |

## Security and operations

- **Proxy (`src/proxy.ts`).** Runs before every page and route except static files. In order: rate limits `/s/*` (60 per IP per 10 minutes, in memory per instance, D72), builds the Content-Security-Policy with a fresh nonce, then the optimistic session-cookie redirect to `/login`. Pages and actions still check the session themselves.
- **Admin pages check the session themselves.** The `(admin)` layout calls `requireSession()`, and so does every page under it, as its first statement. Layouts and pages render in parallel and a layout is not re-run on every navigation, so the layout check alone doesn't guard a page's data reads. `requireSession()` treats a disabled admin as signed out. A new admin page starts with `await requireSession()`.
- **Sign-up (D77).** Only through an invite: the sign-up body carries the invite token, and the Better Auth create hook requires a pending, unexpired invite with that token hash and email.
- **Production environment (D78).** `src/lib/env.ts` throws at startup in production when a required variable is missing (`.env.example` lists them).
- **Content-Security-Policy (D71).** Built by `buildCsp` in `src/lib/csp.ts`:

  ```
  default-src 'self'; script-src 'self' 'nonce-<per request>' 'strict-dynamic' ['unsafe-eval' in development only];
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';
  connect-src 'self' [Sentry ingest origin when NEXT_PUBLIC_SENTRY_DSN is set];
  object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  ```

  What this means for new code: no third-party script, font, image, or fetch origin works until it is added to `buildCsp`. Inline `<script>` needs the nonce (`(await headers()).get("x-nonce")`); scripts loaded by our own bundles are fine through `'strict-dynamic'`. Inline styles and `style` attributes are allowed. Nothing may use `eval` or `new Function` in production. Rich-text editors (Tiptap/ProseMirror) only need `'self'` scripts and inline styles; pasted remote images are blocked by `img-src`. `iframe` previews need a `frame-src` entry, which there is none of. Check the browser console for "Content Security Policy" errors after any UI change.
- **Other headers.** `next.config.ts` `headers()`: HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, Permissions-Policy; `/s/*` overrides with `no-referrer` and `X-Robots-Tag: noindex, nofollow`.
- **Sessions (D73).** 12 hours from the last refresh. Page renders don't refresh; Server Actions and `SessionKeepAlive` (admin layout, on each navigation) do.
- **Monitoring (D74).** Sentry through `src/instrumentation.ts`, `src/instrumentation-client.ts`, and `sentry.{server,edge}.config.ts` at the repo root, inactive without a DSN. `src/lib/sentry-scrub.ts` holds the data-collection settings and the token scrubber every `Sentry.init` uses.
- **Cron (D69).** `vercel.json` schedules `GET /api/cron/retention` at 09:00 UTC. The route checks `Authorization: Bearer $CRON_SECRET` with `rejectCronRequest` from `src/lib/cron-auth.ts`.


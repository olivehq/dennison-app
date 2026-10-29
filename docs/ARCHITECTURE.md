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
- `src/server` imports nothing from React except `cache`, used through `cachePerRender` in `src/server/render-cache.ts` for reads shared across one render (D173). Enforced by `no-restricted-imports`.
- `src/components` never imports `src/db` or `src/server/*/queries.ts`. Client components receive data as props and call actions from `src/server/*/actions.ts`.

## Modules in `src/server`

| Module | Owns | Key exports |
|---|---|---|
| `auth` | Better Auth instance, session helpers, team management, invites, your own profile (`/profile`) | `getAuth()`, `createAuth(db)`, `getSession()`, `requireSession()`, `requireAdmin()`, `inviteAdmin`, `resendInvite`, `revokeInvite`, `disableAdmin`, `enableAdmin`, `listAdmins`, `getInviteByToken`; profile: `updateProfileName`, `changePassword`, `signOutSessions` (plain module `auth/profile.ts`), `listAdminSessions` |
| `events` | Event CRUD, settings, status transitions, lock and unlock, desks | `listEvents`, `getEvent`, `getEventCounts`, `createEvent`, `updateEvent`, `updateEventSettings`, `deleteEvent`; later `lockSchedule`, `unlockSchedule`, `assignDesks`. `inEventTransaction(db, eventId, gate, work)` in `events/editable.ts` claims the event row under a gate from `src/lib/event-gates.ts` and re-reads a failed claim inside the transaction to return a missing, archived, locked, or conflict refusal (D85, D179, D183). `assertEventEditable` and `loadEditableEvent` remain for early checks before costly or external work; writes still claim the row. `archiveEvent` moves any status to archived (D89). `advanceStatus(tx, eventId, from, to)` in `events/status.ts` moves the status forward (D46). `saveBranding`, `logoUrl`, and `loadCurrentLogo` in `events/branding.ts`, served by `GET /api/branding/[eventId]/[file]` (logo and colors for the participant page, D181; works in any status but archived), `setRetainData` (works in any status but archived) and `deleteExpiredParticipantData(db, now)` in `events/retention.ts`, run by the cron route (D69, D70) |
| `roster` | Participants and suppliers: list, add, edit, withdraw, restore | `listParticipants`, `upsertParticipant`, `withdrawParticipant`, same for suppliers |
| `imports` | File upload, parsing (list and matrix formats, limits in D81), validation report, alias mapping (per event and across years, D76), applying rankings | `createImport`, `validateImport`, `saveAliases`, `applyImport`. Templates download from `GET /api/imports/templates/[kind]` (session required) |
| `matching` | Runs the engine, stores runs, compares runs, activates a run, pins, readiness gate | `startRun`, `activateRun`, `compareRuns`, `setPinned`, `matchingReadiness` (D88), `failRunsOlderThan` (D90, per event, skips archived events) |
| `schedule` | Reads for the workspace, manual edits with version check (active run only, D86), swap candidates, lock and desks | `getScheduleView`, `loadActiveSchedule`, `loadPersonSchedule`, `participantSlots`, `isLive` (snapshot.ts, D175), `replaceAppointment`, `removeAppointment`, `swapCandidates`, `lockSchedule`, `reassignDesks` |
| `exports` | Master CSV, per-person ZIP, participant and supplier full lists (D120), quality report, access CSV (reuses current links, leaves revoked links revoked, issues nothing on archived events; D43), export history, the participant page read | `masterScheduleCsv`, `schedulesZip`, `participantsFullCsv`, `suppliersFullCsv`, `qualityReportText`, `accessCsv`, `exportAvailability`, `recordExport`, `loadParticipantView`. Route Handlers in `src/app/api/exports/[eventId]/` call these (D43); each GET is one `exportRoute(kind, params, build)` call in `http.ts` (D182) |
| `email` | Campaigns, merge fields, audiences, sending through the adapter, Resend webhooks, changed since last email (D13, D59 to D64). Delivery (`delivery.ts`) owns batches, their idempotency keys, and the accepted, rejected, or uncertain outcome of each; `campaign-status.ts` owns every campaign status move and the stale-send repair that unlock, archive, and retention share (D185) | `createCampaign`, `updateCampaign`, `duplicateCampaign`, `previewCampaign`, `sendTest`, `sendCampaign`, `resendToBounced`, `deliverCampaign`, `retryRecipients`, `transitionCampaign`, `repairStaleSends`, `resolveAudience`, `renderTemplate`, `changedSinceLastSend`, `recordDeliveryEvent`, `handleResendWebhook`; reads `listCampaigns`, `getCampaign`, `getAudienceOptions`, `getEmailSummary`. Webhook route: `POST /api/webhooks/resend` |
| `audit` | Writing and reading `audit_events`, the activity page, plain-English rows | `recordAudit`, `listAudit` (filters: admin, action groups, person, time window), `describeAudit` and `AUDIT_ACTION_GROUPS` in `describe.ts` (pure), `getActivityPage` in `queries.ts`. Undo itself is `undoAudit` in `schedule/edits.ts` (D32) |
| `tokens` | Participant access tokens: issue, verify, revoke, regenerate, reuse (D59), one live link per contact (D84), revoked links stay revoked except on Regenerate | `listContacts` (the one contact list for links and email), `issueTokensForEvent`, `linksForContacts`, `replaceLinksForChangedEmail`, `verifyToken`, `revokeToken`, `regenerateToken` |
| `files` | Deleting stored files no row points at any more, through the `pending_file_deletions` queue (D184). A caller queues the keys in the transaction that removes their rows; a failed delete stays queued and backs off | `queueFileDeletions(tx, keys)`, `deleteQueuedFilesNow(db, keys)` after the commit, `discardStoredFiles(db, keys)` for uploads whose row never committed, `drainFileDeletions(db)` from the retention cron |

Each module has `queries.ts` (reads), `actions.ts` (`'use server'` mutations), and optionally internal helpers. Tests sit beside the code. Actions are thin: they call `requireAdmin()`, delegate to a plain module that takes the `db` handle (for example `events/events.ts`, `auth/admins.ts`), then `revalidatePath`. Tests exercise the plain module with `createTestDb()`, since `headers()` and `revalidatePath` need a request.

## Engine contract

```ts
runMatching(input: MatchInput): MatchResult

MatchInput = {
  settings: EventSettings           // slotCount, supplierTarget, buyerMin, buyerMax, buyerIdeal, mutualTopN, hotelRankCutoff
  buyers: Buyer[]                   // id, biztechOptIn
  suppliers: Supplier[]             // id, type: 'business' | 'hotel'
  rankings: Ranking[]               // rankerType, rankerId, targetType, targetId, rank | null, isRejection
  pinned: Appointment[]             // kept rows from the active run, placed as they are; plain runs pass none. Each keeps its own pinned flag (D107). Dropped with a warning if a person withdrew, the pair is no longer eligible, or it clashes (D102)
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
2. The action checks the session and that the event is editable (`assertEventEditable`).
3. In one transaction (`inEventTransaction` with the `edit` gate): claim the event row, reload the run, settings, roster, rankings, and rows, and re-run every check. Then compare-and-set `match_runs.version` (the bump also requires `is_active = true`, D86), delete the old row, insert the new row (unique indexes enforce the hard rules), write `audit_events`, and recompute and store `stats`.
4. Returns the new version and the affected people. The action's `revalidatePath` brings in the fresh page. After a successful save the client does not call `router.refresh()` (D115).

## App composites (`src/components/app`)

Allowed list. Each is built from shadcn primitives. Add a new one only when it has two call sites.

- `PageHeader`: title, status badge, actions.
- `DataTable`: the TanStack wrapper with search, column filters, pagination. `rowClassName` mutes rows such as withdrawn people.
- `RankBadge`: `B:4`, `S:-`, top-10 highlight.
- `AppointmentBlock`: the timeline block, business or hotel tone, match strength treatment.
- `PersonSchedule`: a person's nine slots with OPEN gaps. Used in the detail sheet and the participant page. `accentColor` draws the event's accent as a rail on booked rows.
- `BrandedHeader`: the top of the participant page (event, date, name, desk, logo, primary color). Used by `/s/[token]` and the branding preview on the settings page.
- `SlotFilter`: free-in-slot select.
- `ConfirmDialog`: AlertDialog with a typed confirmation for destructive actions.
- `ThemeToggle`: light and dark. `variant="icon"` for toolbars, `variant="menu"` for a dropdown menu item (the account menu).

## Theme

Tokens follow the 03 Resource timeline design: putty ground, umber ink, pool teal for hotels, marigold for business, cue red for the now line only, oxblood for count problems. Custom semantic tokens (`--hotel`, `--business`, `--now`, `--warning`, `--open`, each with `-foreground`, `-tint`, `-ink` where the design defines them) are declared in `globals.css` and mapped in `@theme inline`. Fonts: Schibsted Grotesk for display, Atkinson Hyperlegible Next for UI and data, loaded with `next/font/google`. The theme is next-themes in the root layout, saved in the browser's local storage. Light is the default (D5); the profile page also offers Dark and System, which follows the device setting.

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
- **Admin pages check the session themselves.** The `(admin)` layout calls `requireSession()`, and so does every page under it, as its first statement. Layouts and pages render in parallel and a layout is not re-run on every navigation, so the layout check alone doesn't guard a page's data reads. `requireSession()` treats a disabled admin as signed out and redirects to `/login` with the path and query kept in `next`. A new admin page starts with `await requireSession()`.
- **Sidebar slot.** The `(admin)` layout renders the `@sidebar` parallel route slot. `@sidebar/events/[id]` and one tiny page per real section below it (each re-exports the overview's) load the event switcher and the live counts (`getEventNavCounts` in `src/server/events/nav-counts.ts`); `@sidebar/default.tsx` gives every other page the workspace sidebar. Add a slot page next to any new event section; no catch-all, so unknown paths stay a 404. A slot page renders on each navigation and after each action's `revalidatePath`, so the counts stay current. A soft navigation the slot doesn't match keeps its last page, so `AppSidebar` shows the event part only while the URL is inside that event. The slot pages call `requireSession()` like any page. Links render at once and the counts stream in; a failed count shows the sidebar without counts (D174). Outside an event the sidebar keeps the last event opened, or lists recent events (D171).
- **Sign-up (D77).** Only through an invite: the sign-up body carries the invite token, and the Better Auth create hook requires a pending, unexpired invite with that token hash and email. Revoking an invite, or disabling the admin who sent it, expires it at once. A revoke is final (`revoked_at`, D168); resend issues a fresh link for an expired invite, including one expired by disabling its sender.
- **Profile (`/profile`).** Each admin edits only their own row, taken from the session. The email is read-only, because sign-in is invite-only. Password changes go through Better Auth's `changePassword`, which checks the current password; the action allows five tries per admin per 10 minutes (in memory per instance), since server-side Better Auth calls skip its route rate limit. "Sign out other sessions" deletes the admin's other `sessions` rows, as disabling does (D22). The session list shows a browser and system parsed from the user agent, never the token or IP. Audit actions: `admin.profile_update`, `admin.password_change`, `admin.sessions_sign_out`.
- **Production environment (D78).** `src/lib/env.ts` throws at startup in production when a required variable is missing (`.env.example` lists them).
- **Content-Security-Policy (D71, D124).** Built by `buildCsp` in `src/lib/csp.ts`:

  ```
  default-src 'self'; script-src 'self' 'nonce-<per request>' 'strict-dynamic' ['unsafe-eval' in development only];
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self';
  connect-src 'self' [Sentry ingest origin when NEXT_PUBLIC_SENTRY_DSN is set];
  object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  ```

  What this means for new code: no third-party script, font, or fetch origin works until it is added to `buildCsp`. Images load from any https origin (D124), not from http. Inline `<script>` needs the nonce (`(await headers()).get("x-nonce")`); scripts loaded by our own bundles are fine through `'strict-dynamic'`. Inline styles and `style` attributes are allowed. Nothing may use `eval` or `new Function` in production. Rich-text editors (Tiptap/ProseMirror) only need `'self'` scripts and inline styles. Campaign images must be https, and the sanitizer (D123) drops other image sources. `iframe` previews need a `frame-src` entry, which there is none of. Check the browser console for "Content Security Policy" errors after any UI change.
- **Other headers.** `next.config.ts` `headers()`: HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, Permissions-Policy; `/s/*` overrides with `no-referrer` and `X-Robots-Tag: noindex, nofollow`.
- **Sessions (D73).** 12 hours from the last refresh. Page renders don't refresh; Server Actions and `SessionKeepAlive` (admin layout, on each navigation) do.
- **Monitoring (D74).** Sentry through `src/instrumentation.ts`, `src/instrumentation-client.ts`, and `sentry.{server,edge}.config.ts` at the repo root, inactive without a DSN. `src/lib/sentry-scrub.ts` holds the data-collection settings and the token scrubber every `Sentry.init` uses.
- **Cron (D69).** `vercel.json` schedules `GET /api/cron/retention` at 09:00 UTC. The route checks `Authorization: Bearer $CRON_SECRET` with `rejectCronRequest` from `src/lib/cron-auth.ts`. It returns 503 when `CRON_SECRET` is unset, and production won't start without it (D78). After the retention deletes it drains the stored-file deletion queue (`drainFileDeletions`, D184) and reports how many keys are still pending.


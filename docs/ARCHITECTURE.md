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
| `events` | Event CRUD, settings, status transitions, lock and unlock, desks | `listEvents`, `getEvent`, `getEventOrThrow`, `getEventCounts`, `createEvent`, `updateEvent`, `updateEventSettings`, `deleteEvent`; later `lockSchedule`, `unlockSchedule`, `assignDesks`. `assertEventEditable(event)` in `events/editable.ts` returns `fail('locked', ...)` for locked, sent, and archived events; every module that mutates event data calls it first. `advanceStatus(tx, eventId, from, to)` in `events/status.ts` moves the status forward (D46) |
| `roster` | Participants and suppliers: list, add, edit, withdraw, restore | `listParticipants`, `upsertParticipant`, `withdrawParticipant`, same for suppliers |
| `imports` | File upload, parsing (list and matrix formats), validation report, alias mapping, applying rankings | `createImport`, `validateImport`, `saveAlias`, `saveAliases`, `applyImport`. Templates download from `GET /api/imports/templates/[kind]` (session required) |
| `matching` | Runs the engine, stores runs, compares runs, activates a run, pins | `runMatching`, `rerunKeepingExisting`, `activateRun`, `compareRuns`, `setPinned` |
| `schedule` | Reads for the workspace, manual edits with version check, swap candidates | `getScheduleView`, `getPersonSchedule`, `replaceAppointment`, `removeAppointment`, `swapCandidates` |
| `exports` | Master CSV, per-person ZIP, quality report, access CSV, export history, the participant page read | `masterScheduleCsv`, `schedulesZip`, `qualityReportText`, `accessCsv`, `exportAvailability`, `recordExport`, `loadParticipantView`. Route Handlers in `src/app/api/exports/[eventId]/` call these (D43) |
| `email` | Campaigns, rendering merge fields, sending through the adapter, webhook updates, changed-since-send | `createCampaign`, `previewCampaign`, `sendCampaign`, `recordDeliveryEvent`, `recipientsChangedSinceLastSend` |
| `audit` | Writing and reading `audit_events`, undo | `recordAudit`, `listAudit`, `undoAudit` |
| `tokens` | Participant access tokens: issue, verify, revoke, regenerate | `issueTokensForEvent`, `verifyToken`, `revokeToken` |

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
| Local dev, no env | PGlite in `.data/pglite` | `.data/uploads` | logger adapter |
| Local dev, Docker | postgres.js to `DATABASE_URL` | `.data/uploads` | logger or Resend |
| Vercel preview | Neon branch per preview | Vercel Blob | Resend, test domain |
| Vercel production | Neon main | Vercel Blob | Resend, D&A domain |

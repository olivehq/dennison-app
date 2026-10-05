# AW Appointment Matching App: Project Scope

Prepared for Olive Technologies / Dennison & Associates. Draft, October 4, 2026. Revised October 4, 2026: Next.js on Vercel replaces the earlier AWS plan, a design direction is chosen, and operational requirements missing from the source documents are added (marked "Added" below).

Source material: the SOW draft (Oct 2, 2026), the 2025 matching prompt template, the 2026 output generation template, the 2025 HTML results viewer, and a sample 2026 eShow ratings export.

---

## 1. What we are building

A standalone web app that replaces the 2025 chat-driven matching process. One admin workspace for D&A staff, one matching engine, one mobile page per participant.

Core loop for an event:

1. Admin creates an event and sets slots, times, targets, and rank thresholds.
2. Admin uploads the participants file and three ranking files. App validates and reports problems. Admin maps unknown names.
3. Admin runs the matching engine. Seconds later: a full schedule plus quality stats.
4. Admin reviews by slot, buyer, or supplier. Makes manual swaps in the editor. Locks the schedule.
5. Desks assigned alphabetically, overridable.
6. Admin exports master CSV, per-person ZIP, quality report, and access file.
7. Admin emails each participant a secure link to their schedule. Tracks delivery and bounces. Re-sends reminders.
8. Late changes: admin withdraws or edits a person, re-runs matching while keeping existing appointments, and emails only the people whose schedule changed.
9. Next year: new event, same app, no code changes.

Out of scope, per SOW section 3: eShow API integration, writing back to eShow, profile/tag add-on, rule changes after engine sign-off.

---

## 2. Facts pulled from the source files

### 2025 run (ground truth for the engine)

| Fact | Value |
|---|---|
| Buyers | 65 |
| Suppliers | 56 (9 business, 47 hotel) |
| Slots | 9, 11 minutes apart, 10 minutes long, 3:10 PM to 4:48 PM |
| Appointments | 504 |
| Suppliers at exactly 9 | 56 of 56 |
| Buyers at 7 to 8 | 58 of 65 |
| Buyer distribution | 5: 1, 6: 2, 7: 13, 8: 45, 9: 4 |
| Mutual top-10 matches | 126 (25.0%) |
| Appointments with a buyer rank | 487 (96.6%). 17 had no buyer rank |
| Appointments with a supplier rank | 504 (100%) |
| Manual changes | 12 |

2025 business suppliers: Art of Mentoring, Dennison & Associates, eShow, Expo Convention Contractors, Heritage, Infiniti HR, OnBoard, Parachute Technology, SEAS Productions.

Buyer display name in 2025 was `Organization - Title`. Several buyers share an organization (HelmsBriscoe had five). Email is the identifier in 2026, which resolves this.

### 2025 matching rules (SOW 2.2 plus prompt template)

- Business suppliers processed first, no rank limit.
- Hotel suppliers second, soft cutoff at buyer rank 27.
- Mutual top-10 pairs first. Then alternate between buyer preference and supplier preference. Then fill to quota.
- Buyer `N/A` is an absolute rejection. Supplier blank is low priority but matchable. Buyer blank is unranked, low priority.
- Hard: exactly 9 appointments per supplier. Hard: no double booking per slot. Hard: no duplicate buyer-supplier pair.
- Soft: 7 to 9 per buyer, aim for 8.
- New for 2026: a "biztech opt-in" rule. Named in the SOW, defined nowhere in the folder. See open questions.

### 2026 eShow export format (sample file)

The sample `2026_SS2026_ATTENDEE_RATINGS_FOR_EXHIBITORS_2.XLSX` is a different shape from 2025:

- One sheet named `Report`. Columns: `FIRST_NAME`, `LAST_NAME`, `FULL_NAME`, `CHOICE #1` through `CHOICE #40`.
- One row per attendee. Each choice cell holds a supplier name as free text. Ordinal position is the rank.
- No email column. No `N/A` marker. A supplier that is absent from the row is simply unranked.
- Cap of 40 choices. 2025 had 47 hotel suppliers, so a hotel can never be ranked 41 or worse in this format. The "27 cutoff" still applies.

This changes the import design. 2025 was a matrix (rows ranked, columns ranked against, cell = rank or N/A). 2026 is an ordered list. The importer must support the list format and the SOW says there are three such files: participants ranking biztech suppliers, participants ranking hotel suppliers, suppliers ranking participants. Supplier names in choice cells are free text, so the name alias mapping from 2025 is still needed.

### Timeline (SOW section 7 chart)

| Milestone | Date |
|---|---|
| 2025 preference files from D&A | Oct 6 |
| Formats frozen, scope frozen | Oct 7 |
| Build and testing | Oct 7 to Oct 30 |
| Email DNS ready (D&A) | Oct 20 |
| Production-ready sign-off | Oct 30 |
| Live matching run | Nov 2 to Nov 6 |
| Event | mid November |

Fixed fee: $9,000. Estimate: 170 to 220 hours. Infrastructure passed through at cost, target under $100 per month.

---

## 3. Stack

Everything TypeScript. One Next.js app, deployed to Vercel. This matches SOW section 4, which already named Next.js on Vercel as the platform.

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16, App Router, React 19, TypeScript | One codebase for admin pages, the participant page, and the backend. |
| Backend | Server Components for reads, Server Actions for mutations, Route Handlers for file downloads and webhooks | No separate API server. Server Actions are typed end to end, so no API client layer is needed. |
| UI | shadcn/ui on Tailwind v4, Radix base | Copy-in components, full control. Supports Next.js natively. |
| Tables | TanStack Table through shadcn's Data Table recipe | Search, sort, filter for every list view. |
| Forms | react-hook-form + zod via shadcn Field components | One validation schema shared by forms, Server Actions, and importers. |
| ORM | Drizzle ORM + drizzle-kit | SQL-shaped, type-safe, no codegen step, no engine binary. Works with Neon's serverless driver. Migrations are plain SQL files. |
| Database | Neon Postgres via the Vercel Marketplace | Billed on the Vercel invoice. Each preview deployment gets its own database branch automatically. |
| Auth (admin) | Better Auth, email + password, Drizzle adapter | Sessions, password hashing, rate limits out of the box. |
| Auth (participant) | Signed opaque token per contact, stored hashed, revocable | No accounts, per SOW 2.6. |
| File storage | Vercel Blob, private | Uploaded source files kept for the audit trail. |
| File parsing | SheetJS (`xlsx`) | Reads xlsx and csv. |
| Exports | `csv-stringify`, `archiver` for ZIP | Streamed from Route Handlers. |
| Email | Resend, as named in the SOW | Webhooks give delivery and bounce events. |
| Rich text | Tiptap with shadcn styling | HTML email body editor with merge-field tokens. |
| Scheduled jobs | Vercel Cron | Runs the 90-day data deletion. |
| Monitoring | Sentry (free tier) for errors, an external uptime monitor on the login and participant pages | Alerts Olive when emails fail or pages break during live week. |
| Tests | Vitest. Playwright smoke for 3 flows | The engine gets the most tests. |

Dropped from the first draft because Next.js covers them: Vite, React Router, Hono, TanStack Query, Docker, AWS CDK, ECS, RDS, S3, ECR.

TanStack Query stays out until a screen needs client-side polling. The email delivery table is the likeliest candidate, and a plain refresh button may be enough.

### Project layout

One Next.js app, no monorepo. Package boundaries are folders with import rules, not workspaces.

```
aw-matching/
  src/
    app/
      (admin)/events/...    Admin pages, behind login
      s/[token]/            Participant schedule page
      api/
        auth/[...all]/      Better Auth handler
        exports/...         CSV, ZIP, report downloads
        webhooks/resend/    Delivery and bounce events
        cron/retention/     90-day deletion job
    engine/                 Pure matching engine. No Next, no DB imports. Heavily tested.
    db/                     Drizzle schema, client, migrations
    server/                 Server Actions and queries, grouped by module
    lib/schemas/            zod schemas shared by forms, actions, importers
    components/
      ui/                   shadcn primitives, installed by the CLI
      app/                  App composites, see rules below
  drizzle.config.ts
  vercel.json               Cron schedule, function settings
```

An ESLint `no-restricted-imports` rule keeps `src/engine` free of Next.js and database imports, so it stays a pure, testable module.

### Component rules (DRY and YAGNI)

- Primitives come from shadcn only. If shadcn has it, we do not write it. Install with the shadcn CLI into `src/components/ui`. Expected set: Button, Input, InputGroup, Field, Select, Combobox, Command, Dialog, Sheet, Tabs, ToggleGroup, Badge, Card, Table, Data Table, Alert, Empty, Sonner, DropdownMenu, Tooltip, HoverCard, Progress, Separator, Skeleton, Switch, Textarea, Sidebar, Resizable, ScrollArea, Kbd, Slider.
- App composites live in `src/components/app`. The allowed list, each built from primitives:
  - `PageHeader` (title, status, actions)
  - `DataTable` (one wrapper around TanStack with search, column filters, pagination)
  - `RankBadge` (`B:4` / `S:-`, top-10 highlight)
  - `AppointmentBlock` (supplier, buyer, ranks, business/hotel tone)
  - `SlotFilter` (free-in-slot select)
  - `PersonSchedule` (the 9-slot detail rail, used in the detail pane and on the participant page)
  - `FileDropzone`
  - `ConfirmDialog`
- A new composite needs two call sites before it exists. Until then it stays inline.
- Server Components fetch through query functions in `src/server`. No fetch calls from the browser to our own API, except file downloads.
- No state library. URL search params hold view state (view, search, slot filter, selected person). Local `useState` for the rest.
- No charts library beyond shadcn Chart, and only for the buyer distribution bar.

---

## 4. Design direction

Ten design directions were built on the real 2025 data. D&A's favourites are Floor plan, Resource timeline, and Command workspace. The mockups are in `docs/designs/`, numbers 01, 03, and 04.

Recommendation: combine them into one workspace rather than pick one.

- **The shell is Command workspace.** It provides the sidebar with views and saved filters like "Buyers below 7", the Cmd-K palette, the list in the middle, and the person's 9-slot rail on the right. That rail becomes the `PersonSchedule` composite.
- **The by-slot view is Floor plan.** It shows the desk layout with a slot ruler, and the lobby holds buyers who are free that slot.
- **The by-supplier and by-buyer views are Resource timeline.** Lanes are drawn at true times, with the "now" line for the live show.
- **Quality and alerts** stays the Command workspace version: a list of saved-filter counts and the buyer distribution.

Open design choice: Command workspace defaults to dark, while Floor plan and Timeline are light. Recommend light by default with a dark toggle, because staff will use it on a bright show floor.

Next step is one merged prototype on the same data, before building in Next.js.

---

## 5. Data model

Postgres, Drizzle schema. Every row scoped to an `event_id` except `admins`.

| Table | Purpose | Key columns |
|---|---|---|
| `admins`, `sessions`, `accounts`, `verifications` | Better Auth tables | admins also get invited_by, disabled_at |
| `events` | One per show | name, event_date, timezone (IANA, e.g. `America/Los_Angeles`), status (`draft`, `imported`, `matched`, `locked`, `sent`, `archived`) |
| `event_settings` | Per-event tunables | slot_count, slots jsonb `[{n, start, end}]`, supplier_target (9), buyer_min (7), buyer_max (9), buyer_ideal (8), mutual_top_n (10), hotel_rank_cutoff (27), biztech_opt_in_rule |
| `participants` | Buyers | email (unique per event), first_name, last_name, organization, title, display_name, biztech_opt_in bool, status (`active`, `withdrawn`) |
| `suppliers` | Suppliers | name, type (`business`, `hotel`), desk_number, desk_override bool, admin_contact (email, name), attendee_contact (email, name), status (`active`, `withdrawn`) |
| `name_aliases` | Raw text seen in files mapped to an entity | raw_text, entity_type, entity_id, source (`auto`, `manual`) |
| `imports` | One per uploaded file | kind (`participants`, `buyer_biztech_rankings`, `buyer_hotel_rankings`, `supplier_rankings`), blob_url, status, validation jsonb, row_count |
| `rankings` | Normalised preferences | ranker_type, ranker_id, target_type, target_id, rank int nullable, is_rejection bool, import_id |
| `match_runs` | Each engine execution | status, settings_snapshot jsonb, stats jsonb, duration_ms, is_active, parent_run_id (set when a re-run keeps pinned appointments), version int (bumped on every save) |
| `appointments` | The schedule | run_id, slot, buyer_id, supplier_id, buyer_rank, supplier_rank, source (`engine`, `manual`), pinned bool. Unique (run_id, slot, buyer_id). Unique (run_id, slot, supplier_id). Unique (run_id, buyer_id, supplier_id) |
| `audit_events` | Added. One log for every change: imports, roster edits, settings, matching runs, manual schedule edits, lock and unlock, sends, admin changes | event_id (nullable for admin changes), admin_id, action (e.g. `appointment.replace`, `participant.withdraw`, `schedule.unlock`), entity_type, entity_id, before jsonb, after jsonb, note, created_at |
| `access_tokens` | Participant links | contact_type (`buyer`, `supplier_admin`, `supplier_attendee`), entity_id, token_hash, expires_at, revoked_at, last_viewed_at |
| `email_campaigns` | A send | name, from_name, from_email, reply_to, subject, html_body, audience (`all`, `buyers`, `suppliers`, `selected`, `changed_since_last_send`), kind (`initial`, `reminder`, `update`), sent_at |
| `email_messages` | One per recipient | campaign_id, access_token_id, to_email, provider_message_id, status (`queued`, `sent`, `delivered`, `bounced`, `complained`, `failed`), events jsonb, schedule_hash (hash of the schedule the person was sent) |

Uniqueness constraints on `appointments` enforce the three hard rules at the database layer, not just in code.

`audit_events` replaces the earlier `schedule_changes` table, so there is one audit log instead of two. The "manual changes applied" count is a query on it. Undo replays the `before` value of an event.

A person has "changed since last send" when the hash of their current schedule differs from the `schedule_hash` on their most recent delivered email.

---

## 6. Modules in detail

### 2.1 Foundation

- Next.js scaffold, shadcn init, lint, format. GitHub repo connected to Vercel, so every push gets a preview deployment.
- Neon Postgres added through the Vercel Marketplace, with a database branch per preview. Vercel Blob store added.
- Better Auth email + password. No self-signup. A seed script creates the first admin only.
- Event CRUD and settings form. Settings are the only place slot times and thresholds live.
- Resend account and domain verification handoff to D&A (DNS records for them to add by Oct 20).

Added:

- **Team page.** Any admin can invite a colleague by email, resend an invite, and disable an account. Disabling ends that person's sessions. The last active admin cannot be disabled. All admins have the same access; there are no roles.
- **Password reset.** "Forgot password" on the login page sends a single-use reset link through Resend. Links expire after 1 hour.
- **Event timezone.** Each event stores its timezone. Every slot time, export and email shows times in the event's local time, whatever device is viewing.
- **Security basics.**
  - Rate limits on login, password reset, and participant links, using Better Auth's built-in limiter plus a per-IP limit on `/s/[token]`.
  - Security headers set in `next.config`: Content-Security-Policy, HSTS, X-Frame-Options deny, Referrer-Policy no-referrer on participant pages.
  - Admin sessions expire after 12 hours of inactivity.
- **Monitoring.** Sentry captures server and browser errors and emails Olive. An uptime monitor checks the login page and a test participant link every 5 minutes, and alerts Olive if either fails.

### 2.2 Matching engine (`src/engine`)

Pure function. Input: buyers, suppliers, rankings, settings. Output: appointments, stats, warnings. Deterministic given the same input. Called from a Server Action, which loads the inputs with Drizzle and saves the result as a new `match_runs` row.

Algorithm, as the 2025 rules written down:

1. Build eligibility. A pair is eligible unless buyer rejected the supplier (`N/A`), the buyer is not opted in to biztech and the supplier is business (pending rule definition), or the pair already exists.
2. Phase 1: business suppliers. Phase 2: hotel suppliers. Within a phase, process suppliers with the fewest eligible mutual top-10 candidates first. Most constrained first gives better fill.
3. For each supplier, fill to `supplier_target` slots:
   - Pass A: mutual top-N candidates, best combined rank first.
   - Pass B: alternate. Take the best unused candidate by buyer rank, then by supplier rank, repeat. For hotels, skip buyer ranks above `hotel_rank_cutoff` in this pass.
   - Pass C: fill from any eligible buyer, including blanks and ranks past the cutoff, lowest-count buyers first.
   - A buyer is skipped if at `buyer_max`. Prefer buyers below `buyer_ideal`.
   - Slot choice: a slot free for both, picking the slot with the most remaining global capacity so later suppliers have room.
4. Repair pass. For each buyer below `buyer_min`, look for a buyer at `buyer_max` sharing a supplier slot where the low buyer is eligible and free. Swap if it does not drop anyone below `buyer_min`. Bounded iterations.
5. Stats: the full section A to G of the quality report, computed once here and reused by the UI and the text export.

Added, re-running without losing edits:

- The engine accepts a list of pinned appointments. It treats them as already placed and fills only the remaining gaps. Withdrawn people are excluded from the input.
- On the matching screen, "Re-run and keep existing appointments" pins every appointment in the active run that does not involve a withdrawn person. The new run records the old one as its parent.
- An admin can also pin or unpin single appointments in the schedule workspace, for example to protect a match a supplier asked for.
- Before activating a re-run, the screen shows what changed: appointments added, removed, and people whose count moved.

At about 500 appointments the engine runs in well under a second, far inside Vercel's function time limit.

Testing:

- Synthetic fixtures for every hard constraint.
- The 2025 preference files (due Oct 6) as a regression fixture. Target: meet or beat 2025 numbers (100% suppliers at 9, at least 89% buyers at 7 to 8, at least 25% mutual top-10). Not a byte-identical reproduction, since 2025 had 12 hand edits.
- Property tests: no double booking, no duplicate pairs, no rejected pairs, every supplier at target.

Engine sign-off requires D&A written approval on the 2025 regression output.

### 2.3 Import

- Four uploads per event. Files go to Vercel Blob, then a Server Action parses them.
- Source files are small, about 50 KB for the sample. If a real file nears the Server Action body limit, switch that upload to Vercel Blob client uploads.
- Olive-defined templates for the participants file. Ranking files accept the eShow `CHOICE #n` list format. The 2025 matrix format is supported as a second parser only if D&A still has data in that shape. Otherwise it is dropped.
- Validation report per file: unknown names (with fuzzy suggestions from the alias table and current entities), duplicate emails, missing emails, rows with zero rankings, suppliers ranked by nobody, participants who ranked nobody.
- Alias mapping screen: unresolved raw names on the left, Combobox of entities on the right. Saved aliases persist across years.
- Re-import replaces that file's rankings and re-validates. Nothing is matched until all four files are green or explicitly accepted with warnings.

Added, editing people in the app:

- The participants and suppliers pages allow adding, editing, and withdrawing a person without re-importing a file. Typical uses: fixing an email typo, a supplier sending a different attendee, a buyer cancelling.
- Withdrawing removes the person from future matching runs and flags their current appointments as gaps to fill. It does not delete their rankings, so the withdrawal can be reversed.
- Changing a contact email revokes the old participant link and issues a new one.
- Every roster change writes an `audit_events` row.

### 2.4 Schedule views and exports

- One schedule workspace, as described in section 4. Views: by slot (floor plan), by supplier and by buyer (timeline), quality and alerts. Search and Cmd-K everywhere. Free-in-slot filter. Rank badges, mutual top-10 highlight, business vs hotel tone, count health flags outside 7 to 9.
- Stats: totals, buyer distribution, mutual top-10, one-side top-10, neither, blanks. Lists of buyers above and below target. Manual change count.
- Exports, all streamed from Route Handlers:
  - `Master_Schedule_<year>_Final.csv`: Slot, Start, End, Buyer, Supplier, Desk, Buyer Rank, Supplier Rank. Sorted slot then buyer.
  - ZIP: `buyer_schedules/Buyer_Schedule_<name>.csv` (all 9 rows, `OPEN` for empty) and `supplier_schedules/Supplier_Schedule_<name>.csv`. Filenames sanitised and capped at 80 characters, de-duplicated with a numeric suffix.
  - `Matching_Quality_Report_<year>.txt`: sections A to G.
  - Participant access CSV: name, email, contact type, link. This is the email fallback.

### 2.5 Manual adjustment editor

- Edit mode in the schedule workspace. Disabled when locked.
- Click an appointment or an empty supplier slot. A Sheet opens with a ranked Combobox of alternative buyers: free in that slot, not rejected, not already paired with this supplier. Sorted by combined rank. Each option shows `B:` and `S:` ranks and what the buyer's count becomes.
- Preview panel lists affected appointments before save. Any hard-constraint conflict blocks the save button with a reason.
- Save is a Server Action that writes the appointment and an `audit_events` row in one transaction. Stats recompute.
- Lock schedule: sets event status to `locked`. Editor, re-run, and re-import are disabled. Unlock requires a confirm dialog and is logged.
- Desks: on lock, assign numbers alphabetically by supplier name. Per-supplier override field. Re-assign button that respects overrides.

Added:

- **Two admins editing at once.** Every save sends the run's `version`. If another admin saved first, the save is rejected with "Someone else changed this schedule. Review their change, then try again," and the view reloads. No silent overwrites.
- **Activity log.** An Activity page lists every `audit_events` row for the event, newest first, filterable by person, admin, and type of change.
- **Undo.** Any manual schedule change in the log can be undone, as long as the result passes the same hard-constraint checks as a normal edit. The undo is itself logged.

### 2.6 Participant access

- Token generated per contact on lock. Three contact types: buyer, supplier admin, supplier attendee. Supplier contacts share one supplier schedule, separate tokens.
- Route `/s/[token]`, a Server Component rendered on request. Mobile-first. Shows event name, the person's name, desk (suppliers), and all 9 slots with start, end, counterpart, and desk. Empty slots say `OPEN`. Reuses the `PersonSchedule` composite.
- Token is 32 random bytes, base64url, stored as SHA-256. Expiry configurable, default 60 days after event. Revoke and regenerate per contact from the admin side.
- No rank data on the participant page. Page sets `noindex` and no-store caching.

### 2.7 Email notifications

- Campaign editor: from name, from email (D&A sending domain), reply-to address (a D&A inbox, required, so participant replies reach a person), subject, Tiptap HTML body. Merge fields inserted as chips: `{{first_name}}`, `{{last_name}}`, `{{organization}}`, `{{supplier_name}}`, `{{desk}}`, `{{schedule_link}}`, `{{event_name}}`, `{{event_date}}`.
- Preview renders for a chosen recipient. Test send to an admin address.
- Audience: all, buyers only, suppliers only, or selected rows from a Data Table.
- Send uses Resend's batch API from a Server Action and writes one `email_messages` row per recipient. About 130 recipients fits in two batch calls. No queue system.
- Resend webhook Route Handler (signature verified) updates message status: delivered, bounced, complained. Campaign page shows a status table with filters and a "resend to bounced" action.
- Reminder: duplicate campaign with a new body, kind `reminder`.
- Fallback if DNS is not ready by Oct 20: the participant access CSV from 2.4.

Added, sending updates to only the people affected:

- Each sent email stores a hash of the schedule it described. The participants and suppliers pages show a "Changed since last email" flag, and the dashboard shows how many people are affected.
- "Send update" creates a campaign of kind `update` with the audience `changed_since_last_send`. It uses the same editor and send path as reminders, with a default body that says the schedule changed and links to it.
- Exports show when they were generated and warn if the schedule has changed since the last export.

### 2.8 Tuning and live-run support

- Load real 2026 files as they arrive. Tune thresholds in settings, not code.
- Dry run with D&A on a preview deployment before Oct 30.
- On-call during Nov 2 to 6. Bug fixes under the SOW.

---

## 7. Screens

Admin, all behind login:

| Route | Purpose |
|---|---|
| `/login` | Email and password |
| `/forgot-password`, `/reset-password` | Added. Request and complete a password reset |
| `/invite/[token]` | Added. Accept an invite and set a password |
| `/team` | Added. Invite, resend invite, disable admins |
| `/events` | List, create |
| `/events/[id]` | Dashboard: status stepper, counts, next action |
| `/events/[id]/settings` | Slots, times, targets, thresholds, biztech rule |
| `/events/[id]/participants` | Data Table, contacts, opt-in flag, token status, add, edit, withdraw, "changed since last email" flag |
| `/events/[id]/suppliers` | Data Table, type, desk, contacts, token status, add, edit, withdraw, "changed since last email" flag |
| `/events/[id]/imports` | Four upload cards with validation state |
| `/events/[id]/imports/[importId]` | Validation report and alias mapping |
| `/events/[id]/matching` | Run engine, re-run keeping existing appointments, list runs, compare a run with its parent, set active |
| `/events/[id]/schedule` | The schedule workspace from section 4, with edit mode, pinning, and lock |
| `/events/[id]/activity` | Added. Audit log with filters and undo |
| `/events/[id]/exports` | Four download buttons |
| `/events/[id]/emails` | Campaign list |
| `/events/[id]/emails/[campaignId]` | Editor, preview, audience, send, delivery table |

Public:

| Route | Purpose |
|---|---|
| `/s/[token]` | Participant schedule |

---

## 8. Vercel deployment

One Vercel project on Olive's account, per SOW section 4. Commercial use needs the Pro plan; the Hobby plan does not allow it.

| Resource | Spec | Approx monthly |
|---|---|---|
| Vercel Pro | 1 seat, functions, preview deployments, Cron | $20 |
| Neon Postgres | Via Vercel Marketplace, smallest paid tier, point-in-time recovery | $0 to $20 |
| Vercel Blob | Under 1 GB of uploads and exports | under $1 |
| Resend | Free tier covers about 130 recipients a few times | $0 |
| Sentry and uptime monitor | Free tiers | $0 |
| Total | | about $20 to $45 |

How it runs:

- **Environments.** Production deploys from `main`. Every pull request gets a preview deployment with its own Neon database branch, so the D&A dry run can use a preview without touching production data.
- **Secrets.** `DATABASE_URL` is set by the Neon integration. `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TOKEN_PEPPER`, and `BLOB_READ_WRITE_TOKEN` are Vercel environment variables, set per environment.
- **Migrations.** The build command runs `drizzle-kit migrate` before `next build`, so each deployment migrates its own database branch first. A failed migration fails the deploy, and the previous deployment keeps serving.
- **Rollback.** Use Vercel's instant rollback to the previous deployment. Neon point-in-time restore covers data mistakes.
- **Domain.** A D&A subdomain, for example `schedule.dennisonassociates.com`, set up with a CNAME to Vercel. D&A adds it alongside the email DNS records.
- **Monitoring.** Sentry is connected through its Vercel integration, so source maps upload on each deploy. Alerts go to Olive's support inbox. The uptime monitor uses a test participant link from a dedicated test event.
- **Data retention.** A Vercel Cron job calls the retention route daily. It deletes participant data 90 days after the event unless D&A has asked to keep it.

---

## 9. Hours by module

Fills the empty table in SOW section 6.

| Module | SOW scope | Added | Total |
|---|---|---|---|
| 2.1 Foundation | 18 | 10 (team page, password reset, timezone, security, monitoring) | 28 |
| 2.2 Matching engine | 35 | 6 (re-run keeping existing appointments) | 41 |
| 2.3 Import | 25 | 6 (editing and withdrawing people) | 31 |
| 2.4 Schedule views and exports | 35 | 0 | 35 |
| 2.5 Manual adjustment editor | 25 | 6 (concurrent edits, activity log, undo) | 31 |
| 2.6 Participant access | 10 | 0 | 10 |
| 2.7 Email notifications | 22 | 6 (reply-to, updates to changed people only) | 28 |
| 2.8 Tuning, dry run, live support | 15 | 0 | 15 |
| QA, project management, eShow calls | 20 | 0 | 20 |
| Total | 205 | 34 | 239 |

Moving to Vercel cuts Foundation time, since there's no infrastructure code to write. That time goes to the schedule workspace, which now combines three view types.

The added items take the estimate to 239 hours, above the SOW's 170 to 220 range on a $9,000 fixed fee. Decide this on the Oct 7 call, before scope freezes. The options are:

- **Change order** for the 34 added hours.
- **Fold into the fixed fee** by cutting from section 13's cut list: reminder re-send, delivery table filters, Playwright smoke tests, the timeline's "now" line. That recovers about 12 hours, so it doesn't close the whole gap.
- **A mix of both.** Some added items protect the live run directly: re-running without losing edits, editing people, updates to changed people, and concurrent edits. Those are hard to argue as optional.

---

## 10. Build plan

Today is Oct 4. Build window is Oct 7 to Oct 30, 3.5 weeks, one engineer.

| Week | Dates | Deliver |
|---|---|---|
| 0 | Oct 4 to 6 | Merged design prototype. Next.js scaffold, shadcn init, Drizzle schema, Vercel project with Neon, Blob, and Sentry. Auth with team page and password reset. Engine with synthetic fixtures, including pinned appointments. Nothing format-dependent. |
| 1 | Oct 7 to 11 | Formats frozen. Import parsers and validation. Engine against 2025 files. Alias mapping UI. Editing and withdrawing people. |
| 2 | Oct 14 to 18 | Schedule workspace, stats, all four exports. Re-run keeping existing appointments. Engine sign-off with D&A. |
| 3 | Oct 21 to 25 | Editor with concurrent-edit check, activity log and undo, lock, desks. Participant tokens and page. Email campaigns, webhook, and updates to changed people. |
| 4 | Oct 28 to 30 | Security headers and rate limits, uptime monitor. Dry run with D&A on a preview deployment, including a withdrawal and update email. Fixes. Production deploy. Production-ready sign-off. |
| Live | Nov 2 to 6 | Real run. On call. |

Week 0 can start now. The engine does not need the real files to be built, only to be validated.

---

## 11. Do after go-live

Useful, not needed for the 2026 live run. Each is a candidate for the annual support agreement or a change order before the 2027 event.

| Item | What it does | Estimate |
|---|---|---|
| Add to calendar | An `.ics` download on the participant page with all 9 slots, in the event's timezone. | 2 hours |
| Printable sheets | A desk sheet per supplier for their table, and a print view of any person's schedule. | 4 hours |
| Import templates in the app | Download buttons for each Olive template, with an example row, on the imports page. | 1 hour |
| Copy an event | Start next year's event from this one, copying settings and name mappings but no people or schedules. | 3 hours |
| Training event and guides | A demo event with anonymised 2025 data, a short admin guide, and a live-run runbook covering bad results, bounced emails, and wrong files. | 6 hours |

---

## 12. Open questions for the Oct 7 freeze

These block parts of the build. Ranked by impact.

1. **Biztech opt-in rule.** Named in SOW 2.2, defined nowhere. Working assumption: a participant who submitted a biztech ranking file row is opted in; others never meet business suppliers. Confirm.
2. **Email in the ranking exports.** The sample eShow export has no email column. SOW section 4 says email is the identifier across all files. Can eShow add it, or do we match on `FULL_NAME` against the participants file? Name matching brings back the 2025 alias problem.
3. **Rejections in the list format.** 2025 had an explicit `N/A`. The 2026 `CHOICE #n` format has no way to say "never." Is an omitted supplier a rejection, or just unranked? This changes the engine's eligibility rule and Pass C.
4. **Supplier ranking file shape.** Same `CHOICE #n` layout with participants as the choices? Capped at 40 with 65 participants?
5. **Participants file columns.** Need the final template: email, first, last, organization, title, biztech opt-in, anything else.
6. **Supplier contacts.** Where do supplier admin and attendee emails come from? A column in the supplier list, or a separate file?
7. **Event date, slot times, rankings close date.** Due Oct 7 per SOW.
8. **2025 files.** Due Oct 6. Both buyer and supplier preference files in their original matrix format.
9. **Business vs hotel classification.** A column in the supplier file, or admin sets it in the app?
10. **App domain.** Which D&A subdomain should host the app? Needed for participant links and the email sending domain.
11. **Payment split.** SOW mentions a "second build payment" but no amounts or trigger for the first.
12. **Added scope.** 34 added hours for operational requirements, taking the estimate to 239. Change order, fold into the fee, or a mix? See section 9.
13. **Reply-to inbox.** Which D&A inbox should receive participant replies to schedule emails?

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Formats slip past Oct 7 | Parsers are isolated in one module. Everything downstream works on normalised `rankings` rows. |
| 2025 files arrive late | Engine ships on synthetic fixtures. Regression runs the day files land. |
| Engine quality below 2025 | Repair pass plus manual editor. Thresholds are settings. Worst case, more manual edits than 2025. |
| DNS not done by Oct 20 | Access CSV export is the SOW fallback and costs nothing extra. |
| 3.5 weeks for 239 hours | That is roughly 65 hours a week for one engineer, which is not sustainable. Week 0 starts now. Bring in a second engineer for the email and participant modules, or cut from the list below. Cut order if needed: reminder re-send, delivery table filters, Playwright, the timeline's "now" line. Never cut: engine, import, views, exports, lock, re-run keeping existing appointments, editing people. |
| A late change goes out to everyone, or to no one | Updates go only to people whose schedule hash changed. The dry run includes a withdrawal and an update email. |
| Two admins overwrite each other during live week | Version check on every save. A rejected save explains what happened. |
| Name mismatches in free-text choices | Alias table with fuzzy suggestions. Mapping is a first-class screen, not a one-off script. |
| Upload exceeds the Server Action body limit | Source files are about 50 KB. Switch to Vercel Blob client uploads if a real file is large. |

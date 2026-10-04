# Decisions

Decisions made while building, where the source documents were silent or ambiguous. Each one can be reversed by D&A before engine sign-off. Dates are 2026.

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | Oct 4 | Biztech opt-in: a participant is opted in when they appear with at least one choice in the biztech ranking file. Opted-out participants are never matched with business suppliers. Admins can flip the flag per participant. | The SOW names the rule but does not define it. The three-file import makes the biztech file the natural signal. |
| D2 | Oct 4 | In the eShow `CHOICE #n` list format, a supplier missing from a row is unranked, not rejected. Rejection (`is_rejection`) only comes from an explicit `N/A` in the 2025 matrix format or from an admin marking it in the app. | The list format has no way to say never. Treating omission as rejection would make most pairs ineligible. |
| D3 | Oct 4 | Ranking files are matched to people by `FULL_NAME` through the alias table when they carry no email. The participants file is the only place email is required. | The sample eShow export has no email column. |
| D4 | Oct 4 | Supplier type (business or hotel) comes from a `type` column in the suppliers template. Admins can change it in the app. | Nothing in the source files classifies suppliers. |
| D5 | Oct 4 | Light theme by default, dark toggle available. | Staff use the app on a bright show floor. |
| D6 | Oct 4 | One Postgres driver, postgres.js, for Neon and local Docker. PGlite for tests and for local dev when `DATABASE_URL` is unset. | Keeps one code path in production while letting tests run with no services. |
| D7 | Oct 4 | File storage goes through a tiny adapter: Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, otherwise the local `.data/uploads` folder. | Lets the app run locally without a Vercel account. |
| D8 | Oct 4 | Email goes through an adapter: Resend when `RESEND_API_KEY` is set, otherwise a logger that prints the message. | Same reason as D7, and it keeps tests from sending mail. |
| D9 | Oct 4 | The engine ships as `src/engine` inside the app, not a workspace package. A lint rule forbids it from importing Next.js or the database. | One app is simpler than a monorepo. The lint rule keeps the engine pure. |
| D10 | Oct 4 | Pinned appointments survive a re-run. "Re-run and keep existing" pins every appointment that does not involve a withdrawn person. | Required so late changes do not throw away manual edits. |
| D11 | Oct 4 | Optimistic concurrency uses a `version` column on `match_runs`. Every schedule save sends the version it read. | Cheapest way to stop two admins overwriting each other. |
| D12 | Oct 4 | One `audit_events` table for every change, with before and after JSON. Undo replays `before`. | One log is easier to read and query than several. |
| D13 | Oct 4 | A person has "changed since last send" when the hash of their current schedule differs from the hash stored on their most recent delivered email. | Lets update emails go only to affected people. |
| D14 | Oct 4 | Participant tokens: 32 random bytes, base64url in the link, SHA-256 in the database. Default expiry 60 days after the event date. | Standard unguessable link pattern, no accounts. |
| D15 | Oct 4 | All admins have equal access. No roles. Disabling an admin ends their sessions. The last active admin cannot be disabled. | The SOW has one kind of user. |
| D16 | Oct 4 | Slot times are stored as minutes from midnight in the event timezone, with a per-slot start and end. Display always uses the event timezone. | Avoids date-time bugs when staff travel. |
| D17 | Oct 4 | Desk numbers are assigned alphabetically by supplier name at lock time. Suppliers with a manual override keep their number. | SOW 2.5. |
| D18 | Oct 4 | The 2025 matrix format is supported by the importer in addition to the eShow list format. | D&A still has the 2025 files in that shape and the engine regression needs them. |

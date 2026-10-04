<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AW Appointment Matching App

Admin workspace and participant schedule pages for the AW appointment show, built by Olive Technologies for Dennison & Associates. Full requirements: `docs/PROJECT_SCOPE.md`. Decisions where the requirements were silent: `docs/DECISIONS.md`. Architecture and module boundaries: `docs/ARCHITECTURE.md`. Visual direction: `../designs/03-resource-timeline/index.html` (the design mockup, outside this repo).

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Dev server | `pnpm dev` (http://localhost:3000) |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Unit and integration tests | `pnpm test` |
| One test file | `pnpm test src/engine/match.test.ts` |
| Generate a migration after a schema change | `pnpm db:generate` |
| Apply migrations | `pnpm db:migrate` |
| Seed a demo event with 2025 data | `pnpm db:seed` |
| Create the first admin (no invite needed) | `pnpm create-admin <email> "<name>" <password>` |
| Build | `pnpm build` |
| All checks | `pnpm check` (typecheck, lint, test) |

Local database: with no `DATABASE_URL`, dev and tests use PGlite under `.data/`. With `DATABASE_URL`, postgres.js connects to it. `docker compose up -d` starts a local Postgres and `.env.example` has its URL.

## Stack

Next.js 16 App Router, React 19, TypeScript strict. shadcn/ui (Radix base, Nova preset) on Tailwind v4. Drizzle ORM. Better Auth. zod 4. Vitest. See `package.json` for versions. Next.js docs for this exact version are in `node_modules/next/dist/docs/`; middleware is now `src/proxy.ts`.

## Where things live

```
src/app/            Routes only. Pages are thin: load data through src/server, render components.
  (auth)/           Login, forgot and reset password, invite acceptance
  (admin)/          Everything behind login. Layout checks the session.
  s/[token]/        Participant schedule page, public, token-gated
  api/              Route handlers: auth, exports, webhooks, cron
src/engine/         Pure matching engine. No imports from next, react, or src/db. Enforced by eslint.
src/db/             Drizzle schema (schema.ts), client (client.ts), migrations/
src/server/         Server-only code, one folder per module: auth, events, roster, imports, matching, schedule, exports, email, audit, tokens
  <module>/queries.ts   Reads used by pages
  <module>/actions.ts   'use server' mutations. Every action checks the session first.
  <module>/*.test.ts    Tests against PGlite
src/lib/            Shared helpers: zod schemas (schemas/), time, csv, storage and email adapters, errors
src/components/ui/  shadcn primitives. Installed by the CLI. Do not hand-edit except to fix a bug.
src/components/app/ App composites. Allowed list is in docs/ARCHITECTURE.md. A new one needs two call sites.
fixtures/           2025 results and sample eShow files for tests and the seed script
scripts/            seed.ts and other one-off tools
```

## Rules

- Server Actions: `'use server'` file, zod-parse the input, `requireSession()` first, then do the work in one transaction where more than one row changes, write an `audit_events` row for anything an admin would want to undo or see, `revalidatePath` at the end. Return `{ ok: true, data }` or `{ ok: false, error }`. Never throw for expected failures.
- Reads: Server Components call query functions in `src/server/<module>/queries.ts`. No client-side fetching of our own data except file downloads.
- Schema changes: edit `src/db/schema.ts`, run `pnpm db:generate`, commit the migration. Never edit a committed migration.
- Hard constraints of the schedule (no double booking, no duplicate pair, exactly one supplier per desk-slot) are unique indexes on `appointments`. Code checks them too, for better error messages, but the database is the authority.
- Every time shown to a human is in the event's timezone. Use helpers in `src/lib/time.ts`; never `new Date().getHours()` style code.
- Participants have no accounts. `/s/[token]` compares a SHA-256 of the token with `access_tokens.token_hash`. Nothing on that page shows rankings.
- Components: primitives from `src/components/ui` only. Use `cn()` for classes, semantic tokens (`bg-primary`, `text-muted-foreground`) not raw palette colors, `flex gap-*` not `space-y-*`. Forms use `Field` and `FieldGroup` from shadcn with react-hook-form and the zod schema from `src/lib/schemas`.
- Copy: sentence case, plain verbs, the same word for the same action everywhere (Lock, Unlock, Withdraw, Send). Buttons say what happens. Errors say what went wrong and what to do.
- Dependencies: do not add one without a reason written in the commit body. Check shadcn first for anything UI-shaped.
- Secrets live in `.env.local` and Vercel. Never log them, never commit them. `.env.example` lists every variable with a comment.

## Definition of done

A change is done when `pnpm check` passes, new behavior has a test (engine and server modules always, components when they hold logic), docs in `docs/` and `.env.example` are updated if commands, variables, or behavior changed, and the diff contains only the change described.

## Invariants that are easy to break

- A locked event rejects every mutation except unlock, exports, and email sends. Check `event.status` in the action, not only in the UI.
- Withdrawn people are excluded from matching input and from "free in slot" lists, but their rankings and past appointments stay in the database.
- `match_runs.version` increments on every save. A save with a stale version returns the conflict error, never overwrites.
- The engine must be deterministic for the same input. No `Math.random`, no `Date.now()` inside `src/engine`.
- Export filenames: sanitised, 80 characters max including extension, unique within the ZIP.

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

Open http://localhost:3000. With no `DATABASE_URL` the app uses an embedded Postgres (PGlite) under `.data/`, so nothing else needs to be running.

## Checks

```bash
pnpm check   # typecheck, lint, tests
```

## Deploy

One Vercel project. Add the Neon Postgres and Blob integrations, set the variables listed in `.env.example`, and push to `main`. Migrations run during the build. Details in `docs/ARCHITECTURE.md`.

## Docs

- `AGENTS.md`: how the code is organised and the rules for changing it.
- `docs/ARCHITECTURE.md`: layers, modules, engine contract, theme.
- `docs/DECISIONS.md`: choices made where the requirements were silent.

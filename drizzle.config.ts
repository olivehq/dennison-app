import { defineConfig } from "drizzle-kit";

// drizzle-kit only needs a live connection for push/pull/studio. `generate`
// reads the schema file, so the default URL is a harmless placeholder.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://aw:aw@localhost:5432/aw",
  },
});

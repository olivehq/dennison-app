import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const restrictImports = (patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/db/migrations/**",
  ]),
  {
    // shadcn's sidebar hook ships this pattern. Installed by the CLI, not hand-edited.
    files: ["src/hooks/use-mobile.ts"],
    rules: { "react-hooks/set-state-in-effect": "off" },
  },
  {
    // The engine stays pure: no framework, no database, no environment.
    files: ["src/engine/**/*.{ts,tsx}"],
    rules: restrictImports([
      {
        group: ["next", "next/*", "react", "react-dom", "react-dom/*"],
        message: "src/engine must not depend on Next.js or React.",
      },
      {
        group: ["@/db", "@/db/*", "@/server", "@/server/*", "@/lib/env"],
        message: "src/engine must not touch the database, server modules, or environment.",
      },
    ]),
  },
  {
    // Server modules never render anything.
    files: ["src/server/**/*.{ts,tsx}"],
    rules: restrictImports([
      {
        group: ["react", "react-dom", "react-dom/*", "@/components", "@/components/*"],
        message: "src/server must not import React or components.",
      },
    ]),
  },
  {
    // Components receive data as props and call actions.
    files: ["src/components/**/*.{ts,tsx}"],
    rules: restrictImports([
      {
        group: ["@/db", "@/db/*"],
        message: "Components must not import the database. Load data in src/server and pass props.",
      },
    ]),
  },
]);

export default eslintConfig;

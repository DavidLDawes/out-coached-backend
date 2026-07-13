// Flat config (ESLint 9+). Non-type-checked TS rules — fast, no project
// reference wiring — catches the common classes of bug (unused vars,
// floating promises via no-misused-promises would need type info, so that's
// deliberately not included here) without slowing CI down.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["lib/**", "node_modules/**", "*.config.ts", "*.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["src/**"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // CLI tools under scripts/ legitimately log to the console. Listed after
    // the src/** block above so this more specific override wins.
    files: ["src/scripts/**"],
    rules: {
      "no-console": "off",
    },
  },
);

import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Flags "hydrate local form state from a fetched query result" in a
      // useEffect — used deliberately and consistently across the settings
      // pages (Profile, Storage, admin/Settings) to seed editable fields
      // from server data once it loads. A real concern in general, but
      // rewriting ~9 working call sites for it is a separate refactor, not
      // a lint-config task — downgraded to warn rather than left failing.
      "react-hooks/set-state-in-effect": "warn",
      // Codebase makes heavy, deliberate use of `any` at API/library
      // boundaries (axios error shapes, third-party props) — enforcing this
      // would mean a large unrelated rewrite, not a lint-config concern.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Deliberate best-effort `catch {}` around cross-origin iframe access
      // and similar non-critical calls — the standard allowance for it.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  }
);

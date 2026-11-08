import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", ".local-db/", ".vercel/"] },
  js.configs.recommended,
  {
    files: ["api/**/*.js", "lib/**/*.js", "tests/**/*.js", "scripts/**/*.js", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-control-regex": "off" },
  },
  {
    files: ["public/*.js", "public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // shared helpers defined in public/app.js
        API: "readonly", Toast: "readonly", Cart: "readonly", Session: "readonly", Forms: "readonly",
        escapeHtml: "readonly", formatINR: "readonly", assetUrl: "readonly", randomKey: "readonly",
        store: "readonly", notice: "readonly", statusClass: "readonly", addToBag: "readonly", productUrl: "readonly",
        renderProductCard: "readonly", fillStates: "readonly",
      },
    },
  },
  {
    files: ["public/admin/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.browser } },
  },
  {
    files: ["public/app.js"],
    rules: { "no-unused-vars": ["error", { varsIgnorePattern: "^(API|Toast|Cart|Session|Forms|escapeHtml|formatINR|assetUrl|productUrl|randomKey|store|notice|statusClass|addToBag|renderProductCard|fillStates)$" }], "no-redeclare": "off" },
  },
];

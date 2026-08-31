import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-playwright/**",
    "out/**",
    "build/**",
    "playwright-report/**",
    "test-results/**",
    ".playwright-data/**",
    "python/.venv/**",
    "python/.pytest_cache/**",
    "python/.ruff_cache/**",
    "python/build/**",
    "python/dist/**",
    "python/src/*.egg-info/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

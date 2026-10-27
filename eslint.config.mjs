import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // The pricing core is framework-free: no Next.js, React or web-app imports.
  // src/lib/pricing/__tests__/core-boundary.test.ts also checks the transitive graph.
  {
    files: ["src/lib/pricing/**/*.ts"],
    ignores: ["src/lib/pricing/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["next", "next/*", "react", "react/*", "react-dom", "react-dom/*"], message: "The pricing core must stay framework-free." },
            { group: ["@/app/*", "@/components/*", "@/hooks/*", "@/store/*", "@/middleware/*", "@/lib/adapters/*"], message: "The pricing core must not depend on the web app or adapters." },
            { group: ["**/apple-connect/client", "**/google-play/client"], message: "The pricing core does no network I/O; use an adapter." },
          ],
        },
      ],
    },
  },
  // The CLI uses the core and the adapters directly: no Next.js, React or web-app imports.
  // The "CLI boundary" tests in src/lib/pricing/__tests__/core-boundary.test.ts also check the transitive graph.
  {
    files: ["src/cli/**/*.ts"],
    ignores: ["src/cli/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["next", "next/*", "react", "react/*", "react-dom", "react-dom/*"], message: "The CLI must not depend on Next.js or React." },
            { group: ["@/app/*", "@/components/*", "@/hooks/*", "@/store/*", "@/middleware/*", "@/lib/session"], message: "The CLI must not depend on the web app or its sessions." },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

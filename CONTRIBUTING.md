# Contributing to PricingKit

Thanks for helping out. PricingKit edits real prices on real store accounts, so the bar for
correctness is high and the rules below about tests and store access are strict.

## Setup

1. Install Node 22 or later (`.nvmrc` pins 22; `nvm use` picks it up).
2. Install dependencies:

   ```bash
   npm ci
   ```

3. Start the dev server:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000. `ENCRYPTION_KEY` is optional under `npm run dev` (sessions fall
   back to a plaintext base64 cookie), but required for `npm start`, `npm run preview` and
   deployed instances. To test production behaviour locally, add to `.env.local`:

   ```env
   ENCRYPTION_KEY=<output of: openssl rand -base64 32>
   OPEN_EXCHANGE_RATES_APP_ID=<optional, for live exchange rates>
   ```

   Never expose a dev server to a network.

You do not need store credentials to work on most of the app: the Index Checker
(`/index-checker`), the pricing indexes and the export transforms all run without signing in.
If you test against a store, use a test app and an API key with the least permissions you
need. Never commit credentials (`.gitignore` already excludes `AuthKey*.p8`, common
service-account JSON names and `.env*`, but check `git status` before you commit).

## Checks

Run all three before opening a pull request. CI (`.github/workflows/ci.yml`) runs the same
commands on Node 22 for every pull request, and all three must pass.

```bash
npm test            # Vitest, all tests
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
```

Run a single file with `npm test -- src/lib/google-play/__tests__/currency.test.ts`, or use
`npm run test:watch` while working.

## Testing conventions

- **Location.** Tests live next to the code in a `__tests__` folder and end in `.test.ts`, for
  example `src/lib/export/__tests__/csv.test.ts` or
  `src/app/api/export/__tests__/route.test.ts`. `vitest.config.ts` only includes
  `src/**/__tests__/**/*.test.ts`, so tests anywhere else do not run.
- **Never hit a live store.** No test may call the Google Play Developer API, App Store
  Connect, or any other network service, and no test may read credentials from disk.
  - For client-level tests, stub `fetch` with `vi.stubGlobal('fetch', vi.fn(...))` and return
    `Response` objects. Restore it in `afterEach` (`vi.unstubAllGlobals()`).
  - For route and higher-level tests, mock the store modules with `vi.mock(...)` (see
    `src/app/api/export/__tests__/route.test.ts`). Provide only the functions the code under
    test should call, so an unexpected write call fails.
  - If a test needs to sign a JWT, generate a throwaway key with `crypto.subtle.generateKey`
    in the test. Use placeholder identifiers such as `com.example.app`, never real app,
    bundle or product IDs.
- **Timers.** Retry and backoff code waits between attempts. Use `vi.useFakeTimers()` and/or
  pass a small `retry` option (e.g. `{ retry: { maxAttempts: 2 } }`) so tests stay fast.
- **What to cover.** Pricing maths (`currency.ts`, conversion indexes), anything that builds a
  store write request, and error mapping. A change to what PricingKit sends to a store should
  come with a test that asserts the exact request body.

## Code guidelines

- Match the surrounding style, naming and comment density. `CLAUDE.md` describes the
  architecture and the project's rules in more detail.
- Store errors go through `ApiError` (`src/lib/utils/api-error.ts`); use `toApiError()` for
  unknown errors instead of `String(err)`.
- Store HTTP calls go through `googlePlayFetch` or `appleApiRequest`, which handle retries,
  `Retry-After` and the optional `RequestBudget`. Don't call the store APIs with `fetch`
  directly.
- Keep store writes minimal: change only what the user asked for, send everything else back
  as fetched, and surface the store's own error rather than guessing. Never add writes to
  read-only paths (sign-in, app switching, export).
- Code must work both self-hosted (single user, Node or Workers) and on a shared hosted
  instance: no per-user state in module-level variables unless it is keyed by the
  credential, and nothing written to disk that the app relies on.
- To add a pricing strategy, follow the touchpoint list in `CLAUDE.md`.

## Pull requests

- Keep each PR focused on one change. Separate refactors from behaviour changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
  (`fix(google-play): ...`, `feat(export): ...`, `docs: ...`, `test: ...`).
- Describe what changed, why, and how you tested it. For anything that writes to a store,
  say which test asserts the request and whether you also tried it on a test app.
- Add an entry under `Unreleased` in `CHANGELOG.md` for any user-visible behaviour change,
  with an upgrade note if self-hosters need to do something.
- Update `README.md` / `CLAUDE.md` when you change commands, environment variables or
  architecture.
- Don't commit planning or design `.md` files (at the repo root or under `docs/`); put that in the PR description.
- Report security issues privately as described in `SECURITY.md`, not in a public issue or PR.

## License

By contributing you agree that your contributions are licensed under the
[GPL-3.0-or-later](LICENSE) license that covers the project.

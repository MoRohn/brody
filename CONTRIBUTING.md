# Contributing to Brody

Thanks for helping. Brody is a local repository-intelligence tool: it parses code, it does not run it. Please keep that boundary intact.

## Development setup

CI and the Docker image use Node 24 (`.nvmrc`).

```bash
npm install
cp .env.example .env          # optional: ANTHROPIC_API_KEY or OPENAI_API_KEY
npm run dev                   # http://localhost:3003
```

`npm install` does not run dependency install scripts (`.npmrc`). Optional local tools:

* `ruff` and `python3` for Python analysis
* [Lean 4](https://lean-lang.org/install) for formal-verification tests (`REQUIRE_LEAN=1` makes a missing toolchain a failure)
* FFmpeg, with H.264 and AAC, for explainer videos

Docker:

```bash
cp .env.example .env
docker compose up --build     # http://localhost:3003
```

The sample repository is `fixtures/sample-shop`.

## Checks

```bash
npm test                      # unit and integration tests
npm run typecheck
npm run lint                  # zero warnings
npm run lockfile:check        # lockfile must match Node 24's npm
```

Before a large change, `npm run validate` runs those checks, both production builds, and the performance budgets. `npm run test:e2e` is the Playwright suite. `npm run verify:ai` calls a live model and is billable; do not run it unless you mean to.

If a newer Node rewrites `package-lock.json`, `npm run lockfile:fix` rewrites it for CI's npm.

## What to know before you change the pipeline

* Imported repositories are untrusted data. Analyzers parse. They do not execute project code, project ESLint configs, or model-written Lean that the source screen rejects. See [SECURITY.md](SECURITY.md) and the security model in the README.
* New static rules belong in `src/lib/analysis/rules.ts` with a test. A new analyzer must not execute repository code.
* Parser or prompt changes bump the cache versions named in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (`PARSER_VERSION`, `PROMPT_VERSION`, `FORMAL_VERSION`, and the explainer versions).
* Do not spread a repository-sized array into a call. Use `maxOf` and `pushAll` from `src/lib/util/arrays.ts`.
* UI colours are the tokens in `src/app/globals.css`. `npm test` checks WCAG AA contrast at all five brightness levels.

## Landing site

The GitHub Pages site is static HTML in `site/`. It is not part of the Next.js build.

```bash
node site/build.mjs           # writes site/dist; uses ffmpeg when it is installed
```

Product screenshots come from `docs/screenshots/`. Do not invent figures. Deploy is `.github/workflows/pages.yml`.

## Pull requests

Open a pull request against `main` with what changed and how you tested it. The template in `.github/PULL_REQUEST_TEMPLATE.md` is the checklist. Issues use the forms in `.github/ISSUE_TEMPLATE/`.

By submitting a contribution you agree it is licensed under the [MIT License](LICENSE).

## Security and conduct

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. Do not file a public issue for a security bug. Community standards are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

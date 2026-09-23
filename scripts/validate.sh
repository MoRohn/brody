#!/usr/bin/env bash
# One command for the whole validation: syntax, types, lint, tests, both production builds, performance budgets and the
# browser suite (layout at four widths, five brightness levels, accessibility, keyboard, web performance budgets).
#   npm run validate            everything
#   npm run validate -- --quick skip the browser suite
# Every step must pass with zero warnings, so a regression in any of them fails the run.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
export AI_PROVIDER=none AI_SETTINGS_PATH="${TMPDIR:-/tmp}/brody-validate-ai-settings-unused.json"

step "Types";            npx tsc --noEmit
step "Lint";             npx eslint src tests e2e scripts --max-warnings=0
step "Unit and integration tests"; npx vitest run
step "Production build (webpack, as in Docker)"
out=$(npx next build --webpack 2>&1) || { echo "$out"; exit 1; }
if echo "$out" | grep -qiE "compiled with warnings|Module not found|Critical dependency"; then echo "$out" | grep -iE -A3 "warning|not found|critical"; echo "The webpack build has warnings."; exit 1; fi
step "Production build (Turbopack)"
out=$(npx next build 2>&1) || { echo "$out"; exit 1; }
if echo "$out" | grep -qE "build encountered [0-9]+ warning"; then echo "$out" | grep -A12 "Warning:"; echo "The Turbopack build has warnings."; exit 1; fi
node tools/build-worker.mjs
step "Performance budgets"; npx tsx scripts/benchmark.mts --budget 200 1000 2>&1 | grep -vE "localstorage-file|trace-warnings"
if [[ "${1:-}" != "--quick" ]]; then step "Browser suite"; npx playwright test; fi
printf '\n\033[1;32mValidation passed.\033[0m\n'

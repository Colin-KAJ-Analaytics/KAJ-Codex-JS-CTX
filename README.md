# KAJ Codex JS CTX

`kaj-js-ctx` is a dependency-free Node CLI for token-efficient JavaScript and TypeScript inspection.

It is designed as the second context layer after `kaj-repo-ctx`:

1. Use `kaj-repo-ctx` to identify the important directories and files.
2. Use `kaj-js-ctx` to inspect JS/TS symbols, imports, routes, API calls, and source slices before reading full files.

## Commands

```bash
kaj-js-ctx map ./frontend
kaj-js-ctx symbols ./frontend/src/pages/QuotesPage.tsx
kaj-js-ctx slice ./frontend/src/pages/QuotesPage.tsx --symbol QuotesPage
kaj-js-ctx imports ./frontend/src/pages/QuotesPage.tsx --depth 2
kaj-js-ctx routes ./frontend
kaj-js-ctx search ./frontend --symbol createQuote --with-slices
```

Use `--format json` for compact structured output, or `--format jsonl` when consuming the result from shell automation.

All commands enforce a default estimated output budget of 4,000 tokens. Adjust it when needed:

```bash
kaj-js-ctx search ./frontend --symbol createQuote --with-slices --token-budget 6000 --max-results 20
kaj-js-ctx map ./frontend --format json --no-files
```

The output includes `estimatedTokens`, `tokenBudget`, and `truncated` metadata so an agent can decide whether to request more context. `--no-files` removes project file details and follow-up commands.

## Claude Code shell workflow

Use the CLI from Claude Code through the shell, starting with a compact map and then requesting only the relevant symbols or slices:

```bash
kaj-js-ctx map . --format json --token-budget 2000
kaj-js-ctx search . --symbol createQuote --format json --max-results 20
kaj-js-ctx slice ./src/quotes.ts --symbol createQuote --format text --token-budget 4000
```

This keeps repository context bounded and lets Claude Code request progressively more detail instead of loading whole files.

## Verification

```bash
npm test
npm run check
```

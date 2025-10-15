# Repository Guidelines

## Project Structure & Module Organization
- Entry point: `index.js` (exposes `diffy-cli`).
- Core logic: `lib/` (helpers, workers, utilities).
- Examples and fixtures: `examples/`, `test_jobs/`.
- Docker assets: `docker/` with `docker-compose.yml` at root.
- Logs and artifacts: `log/` (git-ignored as needed).
- Playwright worker prototype: `playwright-worker/` (experimental).

## Build, Test, and Development Commands
- `npm start` — run `index.js` locally.
- `node --env-file=.env index.js --file=test_jobs/screenshot1.json` — run a sample job.
- `node --inspect-brk=0.0.0.0:9229 --env-file=.env index.js --file=...` — debug mode.
- `npm run build` — create a standalone binary via `pkg` into `build/`.
- `npm run lint` — lint JavaScript sources with ESLint (Standard config).
- Docker: `docker compose -f docker-compose.yml up` to start the stack.

## Coding Style & Naming Conventions
- Language: Node.js (CommonJS).
- Indentation: 2 spaces; max line width ~100 chars.
- Filenames: `kebab-case.js` for scripts, `camelCase` for variables/functions, `PascalCase` for classes.
- Prefer async/await; avoid promise chains where possible.
- Run `npm run lint` before pushing; fix with `eslint --fix` if needed.

## Testing Guidelines
- Test jobs live in `test_jobs/` JSON files; use them for local validation.
- Add minimal repro JSONs for edge cases (e.g., `test_jobs/viewport-scroll.json`).
- Aim for functional coverage of CLI flags (`--local`, `--file`, `--env-file`).
- Validate screenshots and logs in `log/`; keep fixtures small and deterministic.

## Commit & Pull Request Guidelines
- Commits: use concise, imperative subjects (e.g., "add SQS retry backoff").
- Group related changes per commit; keep noise low.
- PRs must include: summary, rationale, test instructions (commands), and screenshots/log snippets when relevant.
- Link issues and note any Docker/Chromium version updates explicitly.

## Security & Configuration Tips
- Copy `.env.example` to `.env` and fill required keys (S3/SQS, etc.).
- Pin Chromium versions compatible with Puppeteer; document any changes in README.
- Never commit secrets or large artifacts; prefer S3 for heavy outputs.


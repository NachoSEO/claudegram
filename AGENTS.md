# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the TypeScript source. Key areas: `src/bot/` (Telegram handlers/middleware), `src/claude/` (Claude Agent SDK integration), `src/telegram/` (formatting/Telegraph helpers), `src/tts/` (OpenAI TTS wiring), and `src/config.ts` (Zod-validated env config).
- `dist/` is the compiled output from `npm run build`.
- `scripts/` holds operational tooling (e.g., `claudegram-botctl.sh` plus optional Medium helpers).
- `docs/` and top-level `*.md` files document setup and migrations.

## Build, Test, and Development Commands
- `npm run dev`: start in watch mode with hot reload via `tsx`.
- `npm run typecheck`: TypeScript type checking only.
- `npm run build`: compile to `dist/`.
- `npm start`: run the compiled bot from `dist/index.js`.
- `./scripts/claudegram-botctl.sh prod start|restart`: manage the production bot without hot reload (recommended for self-editing).

## Coding Style & Naming Conventions
- TypeScript ESM (`"type": "module"`); keep import paths using `.js` extensions (e.g., `./config.js`).
- Indentation: 2 spaces; use semicolons and single quotes to match existing files.
- Filenames are kebab-case with role suffixes (e.g., `command.handler.ts`, `request-queue.ts`).
- Add new env vars in `src/config.ts` and document them in `.env.example`.

## Testing Guidelines
- No automated test framework is configured yet. Use `npm run typecheck` and a manual smoke run (`npm run dev` or `npm start`) to verify behavior.
- When adding new behavior, exercise key commands in Telegram and verify logs/output paths.

## Commit & Pull Request Guidelines
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:` (see recent history).
- PRs should include a short summary, testing notes (commands run), and note any new/changed env vars. Include example Telegram commands or screenshots when UX changes.

## Security & Configuration Tips
- `.env` is gitignored; keep secrets out of commits. Update `.env.example` when adding required config.
- Avoid enabling dangerous modes unless you understand the implications (see README security notes).

## Agent-Specific Workflow
- If the bot edits its own repo, avoid `npm run dev`. Use `./scripts/claudegram-botctl.sh prod start`, then `prod restart` to apply changes and `/continue` or `/resume` in Telegram.

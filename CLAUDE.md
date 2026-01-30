# Claudegram -- Development Knowledge Base

> If you are an AI agent reading this file, congratulations -- you just got the cheat codes.
> Read this whole thing. Seriously. It will save you from making the kind of mistakes that get PRs rejected and devs roasted.

---

## Project Overview

Claudegram is a Telegram bot that wraps the **Claude Code SDK**, giving users a full-blown AI agent experience right inside a Telegram chat. You send a message, Claude thinks about it, uses tools, and replies -- all streamed live with a terminal-style UI if you want the fancy spinners.

But it is way more than a chatbot skin. This thing has integrations:

- **Reddit fetching** -- native TypeScript module (no Python dependency). Pulls posts, comments, subreddit listings, and even downloads v.redd.it videos with audio muxing.
- **Medium / Freedium** -- fetches paywalled Medium articles through a Freedium mirror. No Playwright. No headless browser. Just HTTP and good vibes.
- **Media extraction** -- `/extract` command for YouTube, TikTok, and Instagram. Uses yt-dlp under the hood. Supports transcription of extracted audio via Groq Whisper.
- **Voice transcription** -- send a voice note, get a transcript back via Groq Whisper, then Claude processes the text as your prompt.
- **Text-to-Speech** -- toggle TTS per chat. Supports Groq (Orpheus) and OpenAI providers. Claude's response becomes an audio message.
- **Telegraph publishing** -- responses that exceed Telegram's message length limit get auto-published to Telegraph and sent as a link. Clean formatting, no truncation.
- **Image handling** -- upload photos, Claude sees them via multimodal input. Validates file types (including HEIC/HEIF detection).

The bot is access-controlled via `ALLOWED_USER_IDS` -- only whitelisted Telegram users can interact with it. No public access, no anonymous queries.

---

## Architecture

Here is how the codebase is organized. Once you see it, everything clicks.

```
src/
  index.ts              # Entry point -- boots bot and agent
  config.ts             # Zod-validated env config (the single source of truth for all settings)

  bot/
    bot.ts              # grammY bot setup, command registration, handler wiring
    handlers/
      command.handler.ts    # Slash command dispatch (/reddit, /medium, /extract, /tts, etc.)
      message.handler.ts    # Free-text messages -> Claude agent
      photo.handler.ts      # Image uploads -> multimodal Claude input
      voice.handler.ts      # Voice notes -> transcribe -> Claude agent
    middleware/
      auth.middleware.ts     # ALLOWED_USER_IDS gate -- rejects unauthorized users
      stale-filter.ts        # Drops stale updates so the bot does not process a backlog on restart

  claude/
    agent.ts              # Claude Code SDK wrapper -- creates conversations, streams responses
    command-parser.ts     # Parses bot commands into structured args
    request-queue.ts      # Serializes concurrent requests per chat (no race conditions)
    session-history.ts    # Conversation memory management
    session-manager.ts    # Per-chat session lifecycle (create, resume, reset)

  reddit/
    redditfetch.ts        # Native Reddit API client (OAuth2 script-app flow)
    vreddit.ts            # v.redd.it video+audio download and ffmpeg muxing

  medium/
    freedium.ts           # Freedium mirror fetcher for paywalled Medium articles

  media/
    extract.ts            # yt-dlp wrapper for YouTube/TikTok/Instagram extraction

  audio/
    transcribe.ts         # Groq Whisper transcription service

  tts/
    tts.ts                # TTS synthesis (Groq Orpheus / OpenAI)
    tts-settings.ts       # Per-chat TTS toggle state
    voice-reply.ts        # Sends TTS audio back as Telegram voice message

  telegram/
    deduplication.ts      # Prevents duplicate message processing
    markdown.ts           # Telegram MarkdownV2 escaping and formatting
    message-sender.ts     # Chunked message sending, edit-in-place for streaming
    telegraph.ts          # Telegraph API for long-form responses
    terminal-renderer.ts  # Terminal-style UI (spinners, tool call status)
    terminal-settings.ts  # Per-chat terminal UI toggle

  utils/
    caffeinate.ts         # Keep-alive for long-running sessions
    download.ts           # URL validation, SSRF-safe fetch, isValidUrl(), isValidProtocol()
    file-type.ts          # MIME sniffing, HEIC/HEIF brand detection, isValidImageFile()
    sanitize.ts           # sanitizeError(), sanitizePath() -- security helpers
```

**The flow:** Telegram message hits grammY -> middleware (auth + stale filter) -> handler (command/message/photo/voice) -> handler either calls a service directly (reddit, medium, extract) or routes to the Claude agent -> agent streams response back -> message-sender pushes updates to Telegram (with optional terminal UI and TTS).

Pending results are keyed by **messageId**, not chatId. This avoids race conditions when the same user fires multiple messages quickly. If you ever think "should I key this by chatId?" -- the answer is no. Use messageId.

---

## Repo & Workflow

### Fork Structure

| Remote   | URL                                           | Role                          |
|----------|-----------------------------------------------|-------------------------------|
| `origin` | `https://github.com/NachoSEO/claudegram.git` | Upstream parent repo          |
| `myfork` | `https://github.com/lliWcWill/claudegram.git` | User's fork -- PRs go here   |

Local `main` tracks `myfork/main`. When syncing upstream changes, create a branch like `sync/upstream-merge` and PR it into `myfork/main`.

### PR Workflow

1. **Branch** off `main` with a descriptive name (`feature/thing`, `fix/thing`, `sync/upstream-merge`).
2. **Commit** with clear messages. Conventional commits preferred (`feat:`, `fix:`, `refactor:`, etc.).
3. **Push** to `myfork`.
4. **Open a PR** on `lliWcWill/claudegram` using `gh pr create`.
5. **CodeRabbit reviews automatically.** Wait for it. Read what it says. It is not just decoration.
6. **Fix findings**, commit, push. Use `gh api graphql` with the `resolveReviewThread` mutation to resolve threads programmatically:
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_NODE_ID"}) { thread { isResolved } } }'
   ```
7. **NEVER merge without explicit user approval.** This is not a suggestion. This is a rule. The user reviews the final diff and says "merge it." Until then, you wait. Patiently. Like a professional.

### CodeRabbit

The CodeRabbit plugin is installed as a Claude Code plugin. You can invoke it via the `coderabbit:review` skill. Use it. It catches things you will miss. Ego aside.

### Compile Check

```bash
npx tsc --noEmit
```

Run this before pushing. If it fails, do not push. Fix it first. TypeScript errors are not "warnings" -- they are the compiler telling you that you wrote something wrong.

---

## Code Conventions

### Language & Imports

- **TypeScript everywhere.** No `.js` source files.
- **ES Modules** (`"type": "module"` in package.json). Use `import`/`export`, not `require`.
- **Aliased imports** are common and encouraged for readability:
  ```ts
  import { escapeMarkdownV2 as esc } from '../telegram/markdown.js';
  ```

### Shared Utilities -- Use Them

Do not reinvent the wheel. These exist for a reason:

| Utility | File | What It Does |
|---------|------|-------------|
| `sanitizeError()` | `src/utils/sanitize.ts` | Strips sensitive info from errors before showing to users |
| `sanitizePath()` | `src/utils/sanitize.ts` | Prevents path traversal attacks |
| `isValidUrl()` | `src/utils/download.ts` | URL validation with SSRF protection (blocks private IPs) |
| `isValidProtocol()` | `src/utils/download.ts` | Ensures URL uses http/https only |
| `isValidImageFile()` | `src/utils/file-type.ts` | MIME-based image validation including HEIC/HEIF brand detection |

If you are handling user-provided URLs, files, or error messages, check whether one of these already does what you need before writing new code. Odds are, it does.

### Security Patterns

- **sanitizeError() on all user-facing errors.** No stack traces in Telegram. No internal paths. No API keys in error messages. If the user sees it, it goes through `sanitizeError()` first.
- **isValidUrl() includes SSRF private IP blocking.** It rejects `127.0.0.1`, `10.x.x.x`, `192.168.x.x`, `169.254.x.x` (link-local), IPv6 loopback, and IPv6 link-local addresses. Do not bypass this. Do not "temporarily" disable it.
- **No tokens in process arguments.** When calling external tools (curl, yt-dlp, etc.), pass secrets via stdin, environment variables, or temp files -- never as CLI args. Process args are visible in `ps` output.
- **`.unref()` all cleanup intervals.** If you create a `setInterval` or `setTimeout` for cleanup/housekeeping, call `.unref()` on it so the Node process can exit cleanly. Otherwise the bot hangs on shutdown like it has separation anxiety.

### Pending Results

Maps that track in-flight operations are keyed by `messageId`, not `chatId`. This prevents race conditions when a user sends multiple messages before the first one finishes. If you add a new pending-result map, follow this convention.

---

## Untracked Files (Do Not Touch)

The following files appear in `git status` on `main` but are **not part of the codebase**:

```
MEDIUM_SCRAPER_HANDOFF.md
MEDIUM_STATUS_HANDOFF.md
scripts/medium_fetch.py
scripts/medium_login.py
```

These are **personal dev notes and local scripts**. They are not committed, not branched, and not part of any PR. Here is what you need to know:

- **Do not commit them.** Do not add them to staging. Do not include them in PRs.
- **Do not review them.** If CodeRabbit starts opining about a "Playwright medium scraper" -- that is CodeRabbit hallucinating based on these files. The project uses **Freedium** (see `src/medium/freedium.ts`), not Playwright.
- **Do not reference them** in code, docs, or PR descriptions.
- They should eventually be added to `.gitignore` so they stop showing up in `git status`. But that is a separate task, not your problem right now.

---

## Security Checklist

Before you commit anything that touches external input -- URLs, files, user text, API responses -- run through this list. It is not optional. It is the difference between "secure bot" and "someone just used your bot to SSRF your internal network."

- [ ] **URL protocol validation** -- use `isValidProtocol()` from `src/utils/download.ts`. Only `http:` and `https:` allowed.
- [ ] **URL SSRF protection** -- use `isValidUrl()` from `src/utils/download.ts`. Blocks private IPs (IPv4 and IPv6), link-local addresses, and loopback. Do not roll your own.
- [ ] **Path sanitization** -- use `sanitizePath()` from `src/utils/sanitize.ts`. Prevents `../../etc/passwd` type nonsense.
- [ ] **Error sanitization** -- use `sanitizeError()` before sending any error to the user. No stack traces, no file paths, no secrets.
- [ ] **File content validation** -- use `isValidImageFile()` for image uploads. Checks actual file bytes, not just the extension.
- [ ] **No tokens in process args** -- secrets go through stdin or env vars, never as CLI arguments.
- [ ] **Cleanup intervals use `.unref()`** -- any `setInterval` or `setTimeout` for housekeeping must call `.unref()`. Otherwise the bot will not shut down gracefully and you will be debugging "why won't it stop" at 2am.
- [ ] **Pending results keyed by messageId** -- not chatId. If you add a new tracking map, follow the existing pattern.

---

## Website Maintenance

When shipping features, keep `docs/index.html` updated:

**New feature?** Add a feature card:
```html
<div class="feature-card">
  <div class="feature-icon">[emoji]</div>
  <h3>Feature Name</h3>
  <p>Brief description of what the feature does.</p>
</div>
```

**New command?** Add a command row:
```html
<div class="command-row">
  <code class="command-code">/command &lt;args&gt;</code>
  <span class="command-desc">Description of what the command does</span>
</div>
```

**New contributor?** Add a contributor card:
```html
<a href="https://github.com/username" class="contributor-card" target="_blank">
  <img src="https://github.com/username.png" alt="username" class="contributor-avatar">
  <span class="contributor-name">Display Name</span>
  <span class="contributor-role">Contributor</span>
</a>
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Dev mode (watch) | `npm run dev` |
| Build | `npm run build` |
| Start (production) | `npm run start` |
| Type check | `npx tsc --noEmit` |
| Create PR | `gh pr create --repo lliWcWill/claudegram` |
| Resolve review thread | `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "ID"}) { thread { isResolved } } }'` |
| CodeRabbit review | Use `coderabbit:review` skill |

---

*Last updated: 2026-01-29. If this file is out of date, update it. Future you will be grateful.*

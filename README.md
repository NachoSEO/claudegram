<div align="center">

# Claudegram

**Your personal AI agent, running on your machine, controlled from Telegram.**

[![Website](https://img.shields.io/badge/Website-claudegram.com-00ffd5?logo=googlechrome&logoColor=white)](https://claudegram.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Telegram](https://img.shields.io/badge/Telegram_Bot-Grammy-26a5e4?logo=telegram&logoColor=white)](https://grammy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<br />

```
  Telegram  ──▶  Grammy Bot  ──▶  Claude Agent SDK  ──▶  Your Machine
  voice/text     command router     agentic runtime       bash, files, code
```

</div>

---

## What is this?

Claudegram bridges Telegram to a **full Claude Code agent** running locally on your machine. Send a message in Telegram — Claude reads your files, runs commands, writes code, browses Reddit, fetches Medium articles, transcribes voice notes, and speaks responses back. All from your phone.

This is not a simple API wrapper. It's the real Claude Code agent with tool access — Bash, file I/O, code editing, web browsing — packaged behind a Telegram interface with streaming responses, session memory, and rich output formatting.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### Agent Core
- Full Claude Code with tool access (Bash, Read, Write, Edit, Glob, Grep)
- Session resume across messages — Claude remembers everything
- Project-based working directories
- Streaming responses with live-updating messages
- Model picker: Sonnet · Opus · Haiku
- Plan mode, explore mode, loop mode

### Reddit Integration
- `/reddit` — posts, subreddits, user profiles
- `/vreddit` — download & send Reddit-hosted videos
- Auto-compression for videos > 50 MB (CRF → two-pass)
- Original oversized videos archived locally
- Large threads auto-export to JSON

### Medium Integration
- `/medium` — fetch paywalled articles via Freedium
- Telegraph Instant View, save as Markdown, or both
- Pure TypeScript, no Python/Playwright needed

</td>
<td width="50%" valign="top">

### Voice & Audio
- Send a voice note → transcribed via Groq Whisper → fed to Claude
- `/transcribe` — standalone transcription (reply-to or prompt)
- `/tts` — agent responses spoken back as Telegram voice notes
- 13 voices via OpenAI TTS (`gpt-4o-mini-tts`)

### Rich Output
- MarkdownV2 formatting with automatic escaping
- Telegraph Instant View for long responses & tables
- Smart chunking that preserves code blocks
- ForceReply interactive prompts for multi-step commands
- Inline keyboards for settings (model, mode, TTS, clear)

### Image Uploads
- Send photos or image docs in chat
- Saved to project under `.claudegram/uploads/`
- Claude is notified with path + caption

</td>
</tr>
</table>

---

## Quick Start

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | with npm |
| **Claude Code CLI** | installed and authenticated — `claude` in your PATH |
| **Telegram bot token** | from [@BotFather](https://t.me/botfather) |
| **Your Telegram user ID** | from [@userinfobot](https://t.me/userinfobot) |

### Setup

```bash
git clone https://github.com/NachoSEO/claudegram.git
cd claudegram
cp .env.example .env
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_USER_IDS=your_user_id
```

### Run

```bash
npm install
npm run dev        # dev mode with hot reload
```

Open your bot in Telegram → `/start`

---

## Commands

### Session
| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/project` | Set working directory (interactive picker) |
| `/newproject <name>` | Create and switch to a new project |
| `/clear` | Clear conversation + session |
| `/status` | Current session info |
| `/sessions` | List saved sessions |
| `/resume` | Pick from recent sessions |
| `/continue` | Resume most recent session |

### Agent Modes
| Command | Description |
|---------|-------------|
| `/plan` | Plan mode for complex tasks |
| `/explore` | Explore codebase to answer questions |
| `/loop` | Run iteratively until task complete |
| `/model` | Switch Sonnet / Opus / Haiku |
| `/mode` | Toggle streaming / wait |

### Content
| Command | Description |
|---------|-------------|
| `/reddit` | Fetch Reddit posts, subreddits, profiles |
| `/vreddit` | Download Reddit-hosted videos |
| `/medium` | Fetch Medium articles via Freedium |
| `/file` | Download a project file |
| `/telegraph` | Toggle Instant View for long responses |

### Voice & TTS
| Command | Description |
|---------|-------------|
| `/tts` | Toggle voice replies, pick voice |
| `/transcribe` | Transcribe audio to text |
| *Send voice note* | Auto-transcribed → processed by Claude |

### Utility
| Command | Description |
|---------|-------------|
| `/ping` | Health check |
| `/context` | Show Claude context / token usage |
| `/botstatus` | Bot process status |
| `/restartbot` | Restart the bot |
| `/cancel` | Cancel current request |
| `/commands` | Show all commands |

---

## Optional Integrations

<details>
<summary><strong>Reddit — <code>/reddit</code> & <code>/vreddit</code></strong></summary>

`/reddit` requires [redditfetch.py](https://github.com/lliWcWill/redditfetch) for text content. `/vreddit` works out of the box (uses Reddit's DASH manifests + ffmpeg).

```bash
# .env
REDDITFETCH_PATH=/absolute/path/to/redditfetch.py
```

Video downloads need `ffmpeg` and `ffprobe` on your PATH (standard on most Linux/macOS systems). Videos over 50 MB are automatically compressed before sending to Telegram.

</details>

<details>
<summary><strong>Medium — <code>/medium</code></strong></summary>

Pure TypeScript via Freedium mirror — no extra dependencies.

```bash
# .env (optional tuning)
FREEDIUM_HOST=freedium-mirror.cfd
MEDIUM_TIMEOUT_MS=15000
```

</details>

<details>
<summary><strong>Voice Transcription — Groq Whisper</strong></summary>

```bash
# .env
GROQ_API_KEY=your_groq_key
GROQ_TRANSCRIBE_PATH=/absolute/path/to/groq_transcribe.py
```

</details>

<details>
<summary><strong>Text-to-Speech — OpenAI TTS</strong></summary>

```bash
# .env
OPENAI_API_KEY=your_openai_key
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=coral
TTS_RESPONSE_FORMAT=opus
```

13 voices available: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`, `sage`, `shimmer`, `verse`

</details>

---

## Configuration Reference

All config lives in `.env`. See [`.env.example`](.env.example) for the full annotated reference.

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs |

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key (optional with Claude Max subscription) |
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | Path to Claude Code CLI |
| `BOT_NAME` | `Claudegram` | Bot name in system prompt |
| `STREAMING_MODE` | `streaming` | `streaming` or `wait` |
| `DANGEROUS_MODE` | `false` | Auto-approve all tool permissions |

### Reddit

| Variable | Default | Description |
|----------|---------|-------------|
| `REDDITFETCH_PATH` | — | Path to `redditfetch.py` |
| `REDDIT_VIDEO_MAX_SIZE_MB` | `50` | Max video size before compression |
| `REDDITFETCH_TIMEOUT_MS` | `30000` | Execution timeout |
| `REDDITFETCH_JSON_THRESHOLD_CHARS` | `8000` | Auto-switch to JSON output |

### Medium / Freedium

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEDIUM_HOST` | `freedium-mirror.cfd` | Freedium mirror host |
| `MEDIUM_TIMEOUT_MS` | `15000` | Fetch timeout |
| `MEDIUM_FILE_THRESHOLD_CHARS` | `8000` | File save threshold |

### Voice & TTS

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key for Whisper |
| `GROQ_TRANSCRIBE_PATH` | — | Path to `groq_transcribe.py` |
| `OPENAI_API_KEY` | — | OpenAI API key for TTS |
| `TTS_VOICE` | `coral` | Default TTS voice |
| `TTS_MODEL` | `gpt-4o-mini-tts` | TTS model |

---

## Architecture

```
src/
├── bot/
│   ├── bot.ts                     # Bot setup, handler registration
│   ├── handlers/
│   │   ├── command.handler.ts     # All slash commands + inline keyboards
│   │   ├── message.handler.ts     # Text routing, ForceReply dispatch
│   │   ├── voice.handler.ts       # Voice download, transcription, agent relay
│   │   └── photo.handler.ts       # Image save + agent notification
│   └── middleware/
│       ├── auth.ts                # User whitelist
│       └── stale-filter.ts        # Ignore stale messages on restart
├── claude/
│   ├── agent.ts                   # Claude Agent SDK, session resume, system prompt
│   ├── session-manager.ts         # Per-chat session state
│   ├── request-queue.ts           # Sequential request queue
│   └── command-parser.ts          # Help text + command descriptions
├── reddit/
│   └── vreddit.ts                 # Reddit video download + compression pipeline
├── medium/
│   └── freedium.ts                # Freedium article fetcher
├── telegram/
│   ├── message-sender.ts          # Streaming, chunking, Telegraph routing
│   ├── markdown.ts                # MarkdownV2 escaping
│   ├── telegraph.ts               # Telegraph Instant View client
│   └── deduplication.ts           # Message dedup
├── tts/
│   ├── tts.ts                     # TTS provider routing (Groq / OpenAI)
│   ├── tts-settings.ts            # Per-chat voice settings
│   └── voice-reply.ts             # TTS hook for agent responses
├── audio/
│   └── transcribe.ts              # Shared transcription utilities
├── config.ts                      # Zod-validated environment config
└── index.ts                       # Entry point
```

---

## Development

```bash
npm run dev          # Dev mode with hot reload (tsx watch)
npm run typecheck    # Type check only
npm run build        # Compile to dist/
npm start            # Run compiled build
```

### Bot Control Script

```bash
./scripts/claudegram-botctl.sh dev start      # Start dev mode
./scripts/claudegram-botctl.sh dev restart     # Restart dev
./scripts/claudegram-botctl.sh prod start      # Start production
./scripts/claudegram-botctl.sh dev log         # Tail logs
./scripts/claudegram-botctl.sh dev status      # Check if running
```

### Self-Editing Workflow

If Claudegram is editing its own codebase, use **prod mode** to avoid hot-reload restarts:

```bash
./scripts/claudegram-botctl.sh prod start      # No hot reload
# ... let Claude edit files ...
./scripts/claudegram-botctl.sh prod restart     # Apply changes
```

Then `/continue` or `/resume` in Telegram to restore your session.

---

## Security

- **User whitelist** — only approved Telegram IDs can interact
- **Project sandbox** — Claude operates within the configured working directory
- **Permission mode** — uses `acceptEdits` by default
- **Dangerous mode** — opt-in auto-approve for all tool permissions
- **Secrets** — loaded from `.env` (gitignored), never committed

---

## Credits

Original project by [NachoSEO](https://github.com/NachoSEO/claudegram). Extended with Reddit video downloads, voice transcription, TTS, Medium integration, Telegraph output, image uploads, and session continuity.

## License

MIT

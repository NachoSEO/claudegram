<div align="center">

# Claudegram

**Multi-platform AI agent system — Telegram, Discord, and real-time dashboard, powered by OpenAI.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI_Agents_SDK-GPT--5.3--Codex-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![Telegram](https://img.shields.io/badge/Telegram_Bot-Grammy-26a5e4?logo=telegram&logoColor=white)](https://grammy.dev/)
[![Discord](https://img.shields.io/badge/Discord_Bot-discord.js-5865f2?logo=discord&logoColor=white)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)


<br />

```
  Telegram  ──▶  Grammy Bot  ──▶  OpenAI Agents SDK  ──▶  Your Machine
  voice/text     command router     agentic runtime        bash, files, code

  Discord   ──▶  discord.js  ──▶  OpenAI Agents SDK  ──▶  Your Machine
  voice/text     slash commands     agentic runtime        bash, files, code
```

</div>

---

## Why OpenAI? The Architecture Shift

Claudegram originally ran on the **Claude Agent SDK** (Anthropic). In early 2026, Anthropic introduced restrictions on OAuth token usage for third-party applications, making it impractical to run Claude Code as a backend agent in bots and external services.

**OpenAI has no such restrictions.** The ChatGPT Pro subscription supports OAuth PKCE authentication for programmatic access via the Codex backend — meaning you can run a full agentic runtime against your existing Pro subscription without separate API credits.

Claudegram now runs on the **OpenAI Agents SDK** (`@openai/agents` v0.4.14) with `gpt-5.3-codex` as the default model. The provider layer is abstracted, so swapping between Claude and OpenAI is a single environment variable (`AGENT_PROVIDER=openai` or `AGENT_PROVIDER=claude`).

---

## What is this?

Claudegram bridges **Telegram** and **Discord** to a full AI agent running locally on your machine. Send a message — the agent reads your files, runs commands, writes code, browses Reddit, fetches Medium articles, extracts media from YouTube/Instagram/TikTok, transcribes voice notes, reviews code, runs DevOps jobs, and speaks responses back. All from your phone.

This is not a simple API wrapper. It's a real agentic runtime with tool access — shell execution, file I/O, code editing, web browsing, memory persistence — packaged behind Telegram and Discord interfaces with streaming responses, session memory, and rich output formatting.

---

## Features

### Agent Core
- **OpenAI Agents SDK** with full tool access (Shell, Editor, Read, fsuite CLI tools)
- **Provider abstraction** — swap Claude/OpenAI with `AGENT_PROVIDER` env var
- **ChatGPT Pro OAuth** — authenticate with your Pro subscription (no API key needed)
- Resilient token refresh with Codex CLI fallback and refresh mutex
- Session resume across messages — agent remembers everything
- Project-based working directories with interactive picker
- Streaming responses with live-updating messages
- Model picker with provider-aware catalogs
- Plan mode, explore mode, loop mode
- Teleport sessions to terminal (`/teleport`)
- ShieldCortex MCP integration — persistent memory across sessions

### DevOps & Code Review
- `/devops` — build jobs with approval gate buttons and modals
- `/creview` — background CodeRabbit code review jobs
- Disk-backed job runner with Discord notifications
- Approval gate UX — Approve / Deny / Change buttons (no more "say go")
- Autonomous deep-loop tool for maintenance tasks

### Media Extraction
- `/extract` — extract content from **YouTube**, **Instagram**, and **TikTok**
- Pull **transcripts** (plain text, SRT, or VTT subtitles)
- Download **audio** (MP3) or **video** (MP4)
- Groq Whisper transcription for videos without subtitles
- Cookie support for age-restricted / private content
- Proxy fallback for IP-blocked platforms
- SSRF protection (blocks private/internal hosts)
- Transcripts stored as artifacts, long replies auto-chunked

### Reddit Integration
- `/reddit` — posts, subreddits, user profiles with sorting & time filters
- `/vreddit` — download and send Reddit-hosted videos
- Native TypeScript Reddit API client (no external Python dependency)
- Auto-compression for videos > 50 MB (two-pass encoding)
- Large threads auto-export to JSON

### Medium Integration
- `/medium` — fetch paywalled articles via Freedium
- Telegraph Instant View, save as Markdown, or both
- Pure TypeScript, no Python/Playwright needed

### Voice & Audio
- Send a voice note → transcribed via **Groq Whisper** → fed to agent
- `/transcribe` — standalone transcription (reply-to or prompt)
- Audio file transcription (MP3, WAV, FLAC, OGG)
- Large file chunking for files exceeding Groq limits

### Text-to-Speech
- `/tts` — agent responses spoken back as voice notes
- **Groq Orpheus** (default): 6 voices — autumn, diana, hannah, austin, daniel, troy
- **OpenAI TTS**: 13 voices — alloy, ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer, verse
- Speed adjustment (0.25x – 4.0x), tone instructions (gpt-4o-mini-tts)

### Rich Output
- MarkdownV2 formatting with automatic escaping
- Telegraph Instant View for long responses
- Smart chunking that preserves code blocks
- ForceReply interactive prompts for multi-step commands
- Inline keyboards for settings (model, mode, TTS, clear)
- Terminal UI mode with animated spinners and tool status

### Image Handling
- Send photos or image documents in chat
- Vision input support — images sent as vision inputs to the agent
- Image action buttons with optional structured OCR
- Data URI and URL image formats supported

### Discord Bot (Full-Featured Interface)
- Full slash command parity with Telegram (22 guild commands)
- **Gemini Live** real-time voice channel conversations (Google 2.5-flash)
- Built-in Google Search, translation, and utility tools in voice
- Factory Droid integration via `/droid`
- Streaming responses with tool call visibility (real-time progress display)
- Tool action icons and detail extraction for all local + MCP tools

---

## Quick Start

### Prerequisites

- **Node.js 24+** with npm
- **Telegram bot token** — from [@BotFather](https://t.me/botfather) (for Telegram)
- **Discord bot token** — from [Discord Developer Portal](https://discord.com/developers/applications) (for Discord)
- **ChatGPT Pro subscription** — for OpenAI agent (or set `OPENAI_API_KEY` for API credits)

### Setup

```bash
git clone https://github.com/lliWcWill/claudegram.git
cd claudegram
cp .env.example .env
```

Edit `.env`:

```bash
# Pick your platform(s)
TELEGRAM_BOT_TOKEN=your_bot_token       # for Telegram
DISCORD_BOT_TOKEN=your_discord_token    # for Discord

# Auth
ALLOWED_USER_IDS=your_telegram_id
DISCORD_ALLOWED_USER_IDS=your_discord_id

# Provider (default: openai)
AGENT_PROVIDER=openai
```

### OpenAI Pro Authentication

Authenticate with your ChatGPT Pro subscription — no API key required:

```bash
# Option A: Use Codex CLI tokens (if you have Codex CLI installed)
codex login    # tokens auto-imported from ~/.codex/auth.json

# Option B: Direct OAuth login
npx tsx scripts/openai-login.ts   # opens browser for one-time auth
```

### Run

```bash
npm install
npm run dev        # dev mode with hot reload
```

Open your bot in Telegram or Discord.

---

## Commands

### Session Management

- `/start` — Welcome message and getting started guide
- `/project` — Set working directory (interactive folder browser)
- `/clear` — Clear conversation + session (with confirmation)
- `/status` — Current session info (model, provider, session ID)
- `/resume` — Pick from recent sessions via inline keyboard
- `/continue` — Resume most recent session instantly
- `/teleport` — Fork session to terminal (get a CLI command to continue in your shell)
- `/softreset` — Cancel + clear session

### Agent Modes

- `/plan <task>` — Plan mode for complex, multi-step tasks
- `/explore <question>` — Explore codebase to answer questions
- `/loop <task>` — Run iteratively until task complete (max iterations configurable)
- `/model` — Switch models (provider-aware catalog)
- `/mode` — Toggle streaming (live updates) vs. wait (single message)
- `/context` — Show context window / token usage breakdown

### DevOps & Review

- `/devops` — Run build/deploy jobs with approval gates
- `/creview` — Background CodeRabbit code review
- `/droid` — Factory Droid autonomous coding sprints (Discord)

### Media Extraction

- `/extract <url>` — Extract content from YouTube, Instagram, or TikTok
  - **Text** — downloads subtitles or transcribes audio via Groq Whisper
  - **Audio** — downloads and sends MP3
  - **Video** — downloads and sends MP4 (compressed if > 50 MB)
  - **All** — transcript + audio + video
  - Supports subtitle format selection (plain text, SRT, VTT)

### Reddit

- `/reddit <target>` — Fetch Reddit content
  - Targets: post URL, post ID, `r/<subreddit>`, `u/<username>`, share links
  - Flags: `--sort <hot|new|top|rising>`, `--limit <n>`, `--time <day|week|month|year|all>`, `--depth <n>`, `-f <markdown|json>`
- `/vreddit <url>` — Download Reddit-hosted videos (DASH + ffmpeg)

### Medium

- `/medium <url>` — Fetch Medium articles via Freedium

### Voice & TTS

- `/tts` — Toggle voice replies, pick voice and provider
- `/transcribe` — Transcribe audio to text
- *Send voice note* — Auto-transcribed and fed to agent
- *Send audio file* — Auto-transcribed (MP3, WAV, FLAC, OGG)

### Utility

- `/ping` — Health check (bypasses queue)
- `/cancel` — Cancel current request
- `/commands` — Show all available commands

---

## Architecture

### Provider Layer

```
                    ┌─────────────────────────────┐
                    │      AgentProvider Interface  │
                    │    (src/providers/types.ts)   │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                  ▼
   ┌────────────────────┐            ┌────────────────────┐
   │   OpenAI Provider   │            │   Claude Provider   │
   │  (Agents SDK)       │            │  (Agent SDK)        │
   │  gpt-5.3-codex      │            │  opus/sonnet/haiku  │
   │  OAuth PKCE auth    │            │  API key auth       │
   └────────────────────┘            └────────────────────┘
```

The provider abstraction (`AGENT_PROVIDER` env var) lets you swap the AI backend without changing any consumer code. The OpenAI provider uses the Agents SDK with full tool registration, streaming, and server-managed multi-turn context.

### OpenAI Auth Flow

```
  Codex CLI login  ──▶  ~/.codex/auth.json  ──▶  Claudegram imports tokens
                                                         │
                              ┌───────────────────────────┘
                              ▼
                    Token valid? ──yes──▶ Use directly
                              │
                             no (expiring)
                              │
                    Refresh with our token ──ok──▶ Save + use
                              │
                          failed (token_reused)
                              │
                    Re-import from Codex CLI ──▶ Use fresh tokens
                              │
                          also expired
                              │
                    Refresh with CLI token ──▶ Save + use
                              │
                          all failed
                              │
                    Log: "run codex login" ──▶ Return undefined
```

### File Structure

```
src/
├── providers/
│   ├── types.ts                     # AgentProvider interface, shared types
│   ├── factory.ts                   # Provider singleton factory
│   ├── system-prompt.ts             # Shared system prompt logic
│   ├── model-catalog.ts             # Provider-aware model lists
│   ├── openai-provider.ts           # OpenAI Agents SDK provider
│   ├── openai-auth.ts               # OAuth PKCE + token management
│   ├── openai-agent-cache.ts        # Per-chat agent/session cache
│   ├── openai-tools.ts              # fsuite CLI + shell/editor/read tools
│   ├── openai-tool-context.ts       # Tool callback context bridge
│   ├── openai-mcp.ts                # Multi-MCP server manager
│   └── claude-provider.ts           # Claude Agent SDK provider
├── bot/
│   ├── bot.ts                       # Telegram bot setup
│   ├── handlers/
│   │   ├── command.handler.ts       # Slash commands + inline keyboards
│   │   ├── message.handler.ts       # Text routing, ForceReply dispatch
│   │   ├── voice.handler.ts         # Voice transcription + agent relay
│   │   └── photo.handler.ts         # Image save + agent notification
│   └── middleware/
│       ├── auth.middleware.ts        # User whitelist
│       └── stale-filter.ts          # Ignore stale messages on restart
├── claude/
│   ├── agent.ts                     # Thin facade delegating to provider
│   ├── session-manager.ts           # Per-chat session state
│   ├── request-queue.ts             # Sequential request queue
│   ├── context-monitor.ts           # Real-time context window tracking
│   ├── command-parser.ts            # Help text + command descriptions
│   └── session-history.ts           # Session persistence
├── discord/
│   ├── discord-bot.ts               # Discord setup + command registration
│   ├── approvals/                   # Approval gate buttons/modals
│   ├── commands/                    # 22 slash commands
│   │   ├── chat.ts, ask-claude.ts   # Chat commands
│   │   ├── devops.ts                # Build jobs + approval gates
│   │   ├── creview.ts               # CodeRabbit review jobs
│   │   ├── droid.ts                 # Factory Droid integration
│   │   ├── extract.ts               # Media extraction
│   │   ├── reddit.ts, vreddit.ts    # Reddit integration
│   │   ├── voice.ts                 # Voice channel management
│   │   ├── teleport.ts              # Session to terminal
│   │   └── ...                      # model, status, project, etc.
│   ├── handlers/                    # Message, interaction, voice handlers
│   ├── jobs/                        # Disk-backed job runner + notifier
│   └── voice-channel/               # Gemini Live audio pipeline
├── media/
│   └── extract.ts                   # YouTube / Instagram / TikTok
├── reddit/
│   ├── redditfetch.ts               # Native TypeScript Reddit client
│   └── vreddit.ts                   # Reddit video download + compression
├── medium/
│   └── freedium.ts                  # Freedium article fetcher
├── audio/
│   └── transcribe.ts                # Groq Whisper integration
├── tts/
│   ├── tts.ts                       # TTS provider routing
│   ├── tts-settings.ts              # Per-chat voice settings
│   └── voice-reply.ts               # TTS hook for agent responses
├── telegram/
│   ├── message-sender.ts            # Streaming, chunking, Telegraph
│   ├── markdown.ts                  # MarkdownV2 escaping
│   ├── telegraph.ts                 # Telegraph Instant View client
│   ├── deduplication.ts             # Message dedup
│   └── terminal-settings.ts         # Terminal UI settings
├── dashboard/
│   ├── server.ts                    # Express + WebSocket dashboard
│   ├── event-bus.ts                 # 20 event types across 5 files
│   ├── ws-server.ts                 # WebSocket server
│   ├── api.ts                       # REST API
│   └── types.ts                     # Dashboard types
├── droid/
│   └── droid-bridge.ts              # Factory Droid JSON/streaming bridge
├── utils/
│   ├── download.ts                  # Secure file downloads
│   ├── resolve-bin.ts               # Binary path resolution (systemd-safe)
│   ├── sanitize.ts                  # Error/path sanitization
│   ├── proxy.ts                     # Proxy dispatcher
│   └── file-type.ts                 # MIME type detection
├── config.ts                        # Zod-validated environment config
├── index.ts                         # Telegram entry point
└── discord-index.ts                 # Discord entry point
```

---

## Agent Tools

The OpenAI provider registers the following tools for the agent:

### fsuite CLI Tools
- **ftree** — directory tree visualization with depth control, filtering, snapshot/recon modes
- **fsearch** — fast filename/path search with glob patterns
- **fcontent** — search inside files (ripgrep-powered)
- **fmap** — code structure mapping (functions, classes, imports) across 12 languages
- **fmetrics** — telemetry analytics (stats, history, predict, profile)

### System Tools (gated behind DANGEROUS_MODE)
- **shell** — execute shell commands with byte-aware output truncation
- **editor** — apply V4A unified diffs with path jail protection
- **read_file** — read files with secret deny list

### MCP Tools
- **ShieldCortex** — persistent memory (remember, recall, get_context, consolidate, etc.)
- **Playwright** — browser automation (navigate, click, screenshot, evaluate, etc.)

---

## Optional Integrations

<details>
<summary><strong>Media Extraction — <code>/extract</code></strong></summary>

Extracts text transcripts, audio, and video from YouTube, Instagram, and TikTok.

**System requirements:** `yt-dlp`, `ffmpeg`, `ffprobe`

```bash
# Install on Debian/Ubuntu
sudo apt install ffmpeg
pip install yt-dlp

# .env (optional)
YTDLP_COOKIES_PATH=/path/to/cookies.txt
EXTRACT_TRANSCRIBE_TIMEOUT_MS=180000
```

</details>

<details>
<summary><strong>Reddit — <code>/reddit</code> & <code>/vreddit</code></strong></summary>

Native TypeScript Reddit API client. Create a "script" app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps/).

```bash
# .env
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USERNAME=your_bot_account
REDDIT_PASSWORD=your_bot_password
```

</details>

<details>
<summary><strong>Medium — <code>/medium</code></strong></summary>

Pure TypeScript via Freedium mirror — no extra dependencies.

```bash
# .env (optional)
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
<summary><strong>Text-to-Speech</strong></summary>

Two providers available:

**Groq Orpheus** (default, faster):
```bash
TTS_PROVIDER=groq
TTS_VOICE=troy
TTS_SPEED=1.5
```

**OpenAI TTS** (more voices, tone instructions):
```bash
TTS_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=coral
TTS_SPEED=1.0
TTS_INSTRUCTIONS="Speak in a friendly, natural conversational tone."
```

</details>

<details>
<summary><strong>Discord Bot</strong></summary>

```bash
# .env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_APPLICATION_ID=your_app_id
DISCORD_GUILD_ID=your_guild_id
DISCORD_ALLOWED_USER_IDS=your_discord_id
```

**Discord-exclusive features:**
- **Gemini Live** — real-time voice channel conversations via Google 2.5-flash
- **Factory Droid** — `/droid` for autonomous coding sprints
- **DevOps jobs** — `/devops` build with approval gate buttons
- **Code review** — `/creview` background CodeRabbit reviews
- **Voice tools** — Google Search, translation, dice, coin flip, math in voice

Requires a [Discord application](https://discord.com/developers/applications) with MESSAGE_CONTENT privileged intent enabled.

</details>

---

## Configuration Reference

All config lives in `.env`. See [`.env.example`](.env.example) for the full annotated reference.

### Required

- **`AGENT_PROVIDER`** — `openai` (default) or `claude`
- **`TELEGRAM_BOT_TOKEN`** / **`DISCORD_BOT_TOKEN`** — Bot token(s) for your platform(s)
- **`ALLOWED_USER_IDS`** / **`DISCORD_ALLOWED_USER_IDS`** — Authorized user IDs

### OpenAI Provider

- **`OPENAI_API_KEY`** — API key (optional — omit to use ChatGPT Pro OAuth instead)
- **`OPENAI_DEFAULT_MODEL`** — Default model (default: `gpt-5.3-codex-high`)

### Claude Provider

- **`ANTHROPIC_API_KEY`** — API key (optional with Claude Max subscription)
- **`CLAUDE_EXECUTABLE_PATH`** — Path to Claude Code CLI (default: `claude`)

### Core

- **`WORKSPACE_DIR`** — Root directory for project picker (default: `$HOME`)
- **`BOT_NAME`** — Bot name in system prompt (default: `Claudegram`)
- **`STREAMING_MODE`** — `streaming` or `wait` (default: `streaming`)
- **`DANGEROUS_MODE`** — Enable shell/editor tools (default: `false`)
- **`MAX_LOOP_ITERATIONS`** — Max iterations for `/loop` (default: `5`)

### MCP Servers

- **`MCP_PLAYWRIGHT_ENABLED`** — Enable Playwright browser tools (default: `false`)
- **`MCP_PLAYWRIGHT_COMMAND`** / **`MCP_PLAYWRIGHT_ARGS`** — Playwright MCP server config

---

## Development

```bash
npm run dev          # Dev mode with hot reload (tsx watch)
npm run typecheck    # Type check only
npm run build        # Compile to dist/
npm start            # Run compiled build
```

### Systemd Services

```bash
# Discord bot (production)
systemctl --user start claudegram-discord
systemctl --user status claudegram-discord

# Log rotation runs automatically on each restart via ExecStartPre
```

### Self-Editing Workflow

If the agent is editing its own codebase, use **prod mode** to avoid hot-reload restarts:

```bash
npm run build && npm start     # No hot reload
# ... let the agent edit files ...
npm run build && npm start     # Apply changes
```

Then `/continue` or `/resume` to restore your session.

---

## Security

- **User whitelist** — only approved Telegram/Discord IDs can interact
- **Project sandbox** — agent operates within the configured working directory
- **OAuth token security** — tokens stored with 0600 permissions, never committed
- **Tool gating** — shell/editor tools require `DANGEROUS_MODE=true`
- **Path jail** — editor tool validates all paths against working directory
- **Secret deny list** — read_file tool blocks sensitive paths
- **SSRF protection** — media extraction blocks private/internal hosts
- **Diff validation** — editor rejects out-of-order hunks and mismatched context lines

---

## Changelog (Fork Highlights)

This fork (`lliWcWill/claudegram`) extends the original with:

### Architecture
- **Provider abstraction** — swappable AI backend (OpenAI/Claude) via single env var
- **OpenAI Agents SDK** — full migration from raw Chat Completions to `@openai/agents`
- **ChatGPT Pro OAuth** — PKCE auth flow with resilient token refresh and Codex CLI fallback
- **Multi-MCP support** — ShieldCortex (memory) + Playwright (browser) as MCP servers
- **Agent tool suite** — fsuite CLI, shell, editor, read_file with proper gating

### Discord
- 22 slash commands with full feature parity
- DevOps build jobs with approval gate buttons/modals
- Background CodeRabbit code review jobs
- Factory Droid autonomous coding integration
- Image action buttons with structured OCR
- Tool call visibility with real-time progress icons
- Gemini Live voice channel conversations

### Reliability
- Resilient OAuth with JWT expiry decoding, refresh mutex, Codex CLI fallback
- Disk-backed job runner with completion notifications
- ESM-clean imports (no bare directory imports)
- Context-monitor with accurate token math
- Session persistence across restarts
- Log rotation on service restart

### Media & Content
- Vision input support for image uploads
- Transcript artifact storage
- Long reply auto-chunking

---

## Credits

Original project by [NachoSEO](https://github.com/NachoSEO/claudegram). Extended with OpenAI Agents SDK provider, ChatGPT Pro OAuth, DevOps jobs, CodeRabbit reviews, approval gates, media extraction (YouTube/Instagram/TikTok), Reddit integration, voice transcription (Groq Whisper), dual TTS (Groq Orpheus + OpenAI), Medium/Freedium, Telegraph output, image vision, Discord bot with Gemini Live voice channels, ShieldCortex MCP, Factory Droid, session continuity, context monitoring, and systemd service management.

## License

MIT

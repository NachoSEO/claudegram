<div align="center">

# Claudegram

**Your personal AI agent, running on your machine, controlled from Telegram.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Telegram](https://img.shields.io/badge/Telegram_Bot-Grammy-26a5e4?logo=telegram&logoColor=white)](https://grammy.dev/)
[![Discord](https://img.shields.io/badge/Discord_Bot-discord.js-5865f2?logo=discord&logoColor=white)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

https://github.com/user-attachments/assets/7dc72e9d-ddf8-4c98-89d6-f8bff4f3645d


<br />

```
  Telegram  ──▶  Grammy Bot  ──▶  Claude Agent SDK  ──▶  Your Machine
  voice/text     command router     agentic runtime       bash, files, code

  Discord   ──▶  discord.js  ──▶  Claude Agent SDK  ──▶  Your Machine
  voice/text     slash commands     agentic runtime       bash, files, code
```

</div>

---

## What is this?

Claudegram bridges **Telegram** and **Discord** to a full [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent running locally on your machine. Send a message — Claude reads your files, runs commands, writes code, browses Reddit, fetches Medium articles, extracts media from YouTube/Instagram/TikTok, transcribes voice notes, and speaks responses back. All from your phone.

This is not a simple API wrapper. It's the real Claude Code agent with tool access — Bash, file I/O, code editing, web browsing — packaged behind a Telegram and Discord interface with streaming responses, session memory, and rich output formatting.

---

## Features

### Agent Core
- Full Claude Code with tool access (Bash, Read, Write, Edit, Glob, Grep)
- Session resume across messages — Claude remembers everything
- Project-based working directories with interactive picker
- Streaming responses with live-updating messages
- Model picker: **Sonnet** / **Opus** / **Haiku**
- Plan mode, explore mode, loop mode
- Teleport sessions to terminal (`/teleport`)

### Media Extraction
- `/extract` — extract content from **YouTube**, **Instagram**, and **TikTok**
- Pull **transcripts** (plain text, SRT, or VTT subtitles)
- Download **audio** (MP3) or **video** (MP4)
- Groq Whisper transcription for videos without subtitles
- Cookie support for age-restricted / private content
- Proxy fallback for IP-blocked platforms
- SSRF protection (blocks private/internal hosts)

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
- Send a voice note → transcribed via **Groq Whisper** → fed to Claude
- `/transcribe` — standalone transcription (reply-to or prompt)
- Audio file transcription (MP3, WAV, FLAC, OGG)
- Large file chunking for files exceeding Groq limits

### Text-to-Speech
- `/tts` — agent responses spoken back as Telegram voice notes
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

### Image Uploads
- Send photos or image documents in chat
- Saved to project under `.claudegram/uploads/`
- Claude is notified with path + caption for visual context

### Discord Bot (Parallel Interface)
- Full slash command parity with Telegram
- **Gemini Live** real-time voice channel conversations (Google 2.5-flash)
- Built-in Google Search, translation, and utility tools in voice
- Factory Droid integration via `/droid`
- Streaming responses with configurable debounce

---

## Quick Start

### Prerequisites

- **Node.js 18+** with npm
- **Claude Code CLI** — installed and authenticated (`claude` in your PATH)
- **Telegram bot token** — from [@BotFather](https://t.me/botfather)
- **Your Telegram user ID** — from [@userinfobot](https://t.me/userinfobot)

### Setup

```bash
git clone https://github.com/lliWcWill/claudegram.git
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

### Session Management

- `/start` — Welcome message and getting started guide
- `/project` — Set working directory (interactive folder browser)
- `/newproject <name>` — Create and switch to a new project
- `/clear` — Clear conversation + session (with confirmation)
- `/status` — Current session info (model, session ID, created date)
- `/sessions` — List all saved sessions with restore options
- `/resume` — Pick from recent sessions via inline keyboard
- `/continue` — Resume most recent session instantly
- `/teleport` — Fork session to terminal (get a CLI command to continue in your shell)

### Agent Modes

- `/plan <task>` — Plan mode for complex, multi-step tasks
- `/explore <question>` — Explore codebase to answer questions
- `/loop <task>` — Run iteratively until task complete (max iterations configurable)
- `/model` — Switch between Sonnet / Opus / Haiku
- `/mode` — Toggle streaming (live updates) vs. wait (single message)
- `/context` — Show Claude context window / token usage breakdown

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
  - Choose: Telegraph Instant View, Markdown file, or both

### Voice & TTS

- `/tts` — Toggle voice replies on/off, pick voice and provider
- `/transcribe` — Transcribe audio to text (reply to a voice note or send one after)
- *Send voice note* — Auto-transcribed and fed to Claude as context
- *Send audio file* — Auto-transcribed (MP3, WAV, FLAC, OGG supported)

### Files & Output

- `/file <path>` — Download a project file to Telegram
- `/telegraph` — View Markdown content as a Telegraph Instant View page
- `/terminalui` — Toggle terminal-style UI (animated spinners, tool status display)

### Utility

- `/ping` — Health check (bypasses queue)
- `/context` — Show Claude context / token usage
- `/botstatus` — Bot process status (uptime, memory, CPU)
- `/restartbot` — Restart the bot (with confirmation)
- `/cancel` — Cancel current request (bypasses queue)
- `/softreset` — Cancel + clear session
- `/commands` — Show all available commands

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
YTDLP_COOKIES_PATH=/path/to/cookies.txt          # for age-restricted content
EXTRACT_TRANSCRIBE_TIMEOUT_MS=180000              # timeout per chunk (ms)
```

Cookie files enable access to age-restricted YouTube, private Instagram accounts, and mature TikTok content. Export from your browser using the "Get cookies.txt LOCALLY" extension.

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

> **Note:** Reddit's script-app OAuth requires the actual account password. Use a dedicated bot account — not your personal Reddit credentials.

Video downloads (`/vreddit`) need `ffmpeg` and `ffprobe` on your PATH. Videos over 50 MB are automatically compressed before sending to Telegram.

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

Used for voice note transcription, `/transcribe` command, and `/extract` text mode (when videos lack subtitles).

</details>

<details>
<summary><strong>Text-to-Speech</strong></summary>

Two providers available:

**Groq Orpheus** (default, faster):
```bash
# .env
TTS_PROVIDER=groq
# Reuses GROQ_API_KEY from above
TTS_VOICE=troy          # autumn, diana, hannah, austin, daniel, troy
TTS_SPEED=1.5
```

**OpenAI TTS** (more voices, tone instructions):
```bash
# .env
TTS_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=coral         # alloy, ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer, verse
TTS_SPEED=1.0
TTS_INSTRUCTIONS="Speak in a friendly, natural conversational tone."
```

</details>

<details>
<summary><strong>Discord Bot</strong></summary>

Run the Discord bot alongside or instead of Telegram.

```bash
# .env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_APPLICATION_ID=your_app_id
DISCORD_GUILD_ID=your_guild_id              # optional, for instant slash command updates
DISCORD_ALLOWED_USER_IDS=your_discord_id
```

**Discord-exclusive features:**
- **Gemini Live** — real-time voice channel conversations via Google 2.5-flash
- **Factory Droid** — `/droid` for autonomous coding sprints
- **Voice tools** — Google Search, translation, dice, coin flip, math in voice

Requires a [Discord application](https://discord.com/developers/applications) with MESSAGE_CONTENT privileged intent enabled.

</details>

---

## Configuration Reference

All config lives in `.env`. See [`.env.example`](.env.example) for the full annotated reference.

### Required

- **`TELEGRAM_BOT_TOKEN`** — Bot token from @BotFather
- **`ALLOWED_USER_IDS`** — Comma-separated Telegram user IDs

### Core

- **`ANTHROPIC_API_KEY`** — API key (optional with Claude Max subscription)
- **`WORKSPACE_DIR`** — Root directory for project picker (default: `$HOME`)
- **`CLAUDE_EXECUTABLE_PATH`** — Path to Claude Code CLI (default: `claude`)
- **`BOT_NAME`** — Bot name in system prompt (default: `Claudegram`)
- **`STREAMING_MODE`** — `streaming` or `wait` (default: `streaming`)
- **`STREAMING_DEBOUNCE_MS`** — Debounce interval for live edits (default: `500`)
- **`MAX_MESSAGE_LENGTH`** — Character limit before Telegraph fallback (default: `4096`)
- **`DANGEROUS_MODE`** — Auto-approve all tool permissions (default: `false`)
- **`MAX_LOOP_ITERATIONS`** — Max iterations for `/loop` (default: `5`)

### Reddit

- **`REDDIT_CLIENT_ID`** / **`REDDIT_CLIENT_SECRET`** — Reddit API credentials
- **`REDDIT_USERNAME`** / **`REDDIT_PASSWORD`** — Bot Reddit account
- **`REDDITFETCH_TIMEOUT_MS`** — Execution timeout (default: `30000`)
- **`REDDITFETCH_DEFAULT_LIMIT`** — Default post limit (default: `10`)
- **`REDDITFETCH_DEFAULT_DEPTH`** — Default comment depth (default: `5`)
- **`REDDITFETCH_JSON_THRESHOLD_CHARS`** — Auto-switch to JSON (default: `8000`)
- **`REDDIT_VIDEO_MAX_SIZE_MB`** — Max video size before compression (default: `50`)

### Medium / Freedium

- **`FREEDIUM_HOST`** — Freedium mirror host (default: `freedium-mirror.cfd`)
- **`FREEDIUM_RATE_LIMIT_MS`** — Rate limit between requests (default: `2000`)
- **`MEDIUM_TIMEOUT_MS`** — Fetch timeout (default: `15000`)
- **`MEDIUM_FILE_THRESHOLD_CHARS`** — File save threshold (default: `8000`)

### Voice & TTS

- **`GROQ_API_KEY`** — Groq API key for Whisper + Orpheus TTS
- **`GROQ_TRANSCRIBE_PATH`** — Path to `groq_transcribe.py`
- **`VOICE_SHOW_TRANSCRIPT`** — Show transcript before agent response (default: `true`)
- **`VOICE_MAX_FILE_SIZE_MB`** — Max voice file size (default: `19`)
- **`VOICE_LANGUAGE`** — ISO 639-1 language code (default: `en`)
- **`TTS_PROVIDER`** — `groq` or `openai` (default: `groq`)
- **`TTS_VOICE`** — Voice name (default: `troy` for Groq, `coral` for OpenAI)
- **`TTS_SPEED`** — Speech speed 0.25–4.0 (default: `1.5`)
- **`TTS_MAX_CHARS`** — Max chars before skipping voice (default: `4096`)
- **`OPENAI_API_KEY`** — OpenAI API key (only for `TTS_PROVIDER=openai`)

### Media Extraction

- **`YTDLP_COOKIES_PATH`** — Path to cookies.txt for yt-dlp
- **`EXTRACT_TRANSCRIBE_TIMEOUT_MS`** — Transcription timeout per chunk (default: `180000`)

### Discord

- **`DISCORD_BOT_TOKEN`** — Discord bot token
- **`DISCORD_APPLICATION_ID`** — Discord application ID
- **`DISCORD_GUILD_ID`** — Guild ID for guild-scoped commands
- **`DISCORD_ALLOWED_USER_IDS`** — Comma-separated Discord user IDs
- **`DISCORD_ALLOWED_ROLE_IDS`** — Comma-separated Discord role IDs
- **`DISCORD_STREAMING_DEBOUNCE_MS`** — Streaming edit debounce (default: `1500`)
- **`GEMINI_API_KEY`** — Google Gemini API key (for Discord voice channels)

### UI

- **`TERMINAL_UI_DEFAULT`** — Enable terminal-style UI by default (default: `false`)
- **`IMAGE_MAX_FILE_SIZE_MB`** — Max image upload size (default: `20`)

---

## Architecture

```
src/
├── bot/
│   ├── bot.ts                        # Bot setup, handler registration
│   ├── handlers/
│   │   ├── command.handler.ts        # All slash commands + inline keyboards
│   │   ├── message.handler.ts        # Text routing, ForceReply dispatch
│   │   ├── voice.handler.ts          # Voice download, transcription, agent relay
│   │   └── photo.handler.ts          # Image save + agent notification
│   └── middleware/
│       ├── auth.middleware.ts         # User whitelist
│       └── stale-filter.ts           # Ignore stale messages on restart
├── claude/
│   ├── agent.ts                      # Claude Agent SDK, session resume, system prompt
│   ├── session-manager.ts            # Per-chat session state
│   ├── request-queue.ts              # Sequential request queue
│   ├── command-parser.ts             # Help text + command descriptions
│   └── session-history.ts            # Session persistence
├── media/
│   └── extract.ts                    # YouTube / Instagram / TikTok extraction
├── reddit/
│   ├── redditfetch.ts                # Native TypeScript Reddit API client
│   └── vreddit.ts                    # Reddit video download + compression
├── medium/
│   └── freedium.ts                   # Freedium article fetcher
├── audio/
│   └── transcribe.ts                 # Groq Whisper integration
├── tts/
│   ├── tts.ts                        # TTS provider routing (Groq / OpenAI)
│   ├── tts-settings.ts               # Per-chat voice settings
│   └── voice-reply.ts                # TTS hook for agent responses
├── telegram/
│   ├── message-sender.ts             # Streaming, chunking, Telegraph routing
│   ├── markdown.ts                   # MarkdownV2 escaping
│   ├── telegraph.ts                  # Telegraph Instant View client
│   ├── deduplication.ts              # Message dedup
│   └── terminal-settings.ts          # Terminal UI settings
├── discord/
│   ├── discord-bot.ts                # Discord setup + slash command registration
│   ├── handlers/                     # Message, interaction, voice handlers
│   ├── commands/                     # 17 slash commands
│   └── voice-channel/                # Gemini Live audio pipeline
├── droid/
│   └── droid-bridge.ts               # Factory Droid JSON/streaming bridge
├── utils/
│   ├── download.ts                   # Secure file downloads
│   ├── resolve-bin.ts                # Binary path resolution (systemd-safe)
│   ├── sanitize.ts                   # Error/path sanitization
│   ├── proxy.ts                      # Proxy dispatcher for blocked content
│   └── file-type.ts                  # MIME type detection
├── config.ts                         # Zod-validated environment config
├── index.ts                          # Telegram entry point
└── discord-index.ts                  # Discord entry point
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

- **User whitelist** — only approved Telegram/Discord IDs can interact
- **Project sandbox** — Claude operates within the configured working directory
- **Permission mode** — uses `acceptEdits` by default
- **Dangerous mode** — opt-in auto-approve for all tool permissions
- **SSRF protection** — media extraction blocks private/internal hosts
- **Secrets** — loaded from `.env` (gitignored), never committed

---

## Credits

Original project by [NachoSEO](https://github.com/NachoSEO/claudegram). Extended with media extraction (YouTube/Instagram/TikTok), Reddit integration (native TypeScript client + video downloads), voice transcription (Groq Whisper), dual TTS (Groq Orpheus + OpenAI), Medium/Freedium integration, Telegraph output, image uploads, Discord bot with Gemini Live voice channels, session continuity, terminal UI, and Factory Droid integration.

## License

MIT

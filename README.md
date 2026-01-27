# Claudegram

A Telegram bot that bridges messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) running on your local machine, giving you full agentic capabilities — Bash, file operations, code editing, Reddit browsing, voice transcription, and text-to-speech — all from Telegram.

```
Telegram App  ->  Telegram API  ->  Claudegram  ->  Claude Code SDK  ->  Your Machine
    voice/text        bot token         Grammy         @anthropic-ai       local files
```

## Features

### Agent Core
- Full Claude Code agent with tool access (Bash, Read, Write, Edit, Glob, Grep)
- Conversation continuity via session resume across messages
- Project-based sessions with working directory picker
- User whitelist authentication — only approved Telegram IDs can interact
- Streaming responses with live-updating messages
- Configurable AI model (Sonnet, Opus, Haiku)
- Plan mode, explore mode, and loop mode for complex tasks

### Reddit Integration
- `/reddit` command for fetching posts, subreddits, and user profiles
- Natural language Reddit queries ("show me today's top posts on r/programming")
- Share links, bare post IDs, and `r/` / `u/` shortcuts supported
- Large threads automatically fall back to **JSON output**, saved under `.claudegram/reddit/` and sent as a file
- Threshold is configurable via `REDDITFETCH_JSON_THRESHOLD_CHARS`
- Semantic mapping in the agent prompt: "trending" → `--sort hot`, "this week's best" → `--sort top --time week`

### Medium Integration
- `/medium` command for fetching Medium articles
- Headless Playwright fetch to bypass Cloudflare blocks on public posts
- Clean, agent-friendly Markdown output with local images
- Images saved under `.claudegram/medium/<slug>/images`
- Outputs `article.md`, `article.html`, `article.txt`, and `metadata.json`

### Voice Transcription
- Send a voice note -> Groq Whisper transcribes it -> transcript is fed to the agent as a message
- Shows transcript preview before processing
- Retries with curl for reliable file downloads
- Configurable language, timeout, and file size limits

### Text-to-Speech (TTS)
- Toggle with `/tts` — agent responses are spoken back as Telegram voice notes
- Powered by OpenAI TTS API (`gpt-4o-mini-tts` with `instructions` for tone control)
- 13 built-in voices (recommended: coral, marin, cedar)
- OGG/Opus output — displays as a native voice bubble in Telegram
- Markdown is stripped before synthesis for natural-sounding speech
- Per-chat voice and toggle settings

### Image Uploads
- Send photos or image documents directly in chat
- Files are saved to the active project under `.claudegram/uploads/`
- Claude is notified with the saved path + caption so it can reference, move, or edit images
- Supports multiple images and Telegram albums (each image is handled and saved)

### Rich Output
- MarkdownV2 formatting with automatic escaping
- Telegraph Instant View for long responses (> 2500 chars or tables)
- Smart message chunking with code block preservation
- File downloads via `/file`
- ForceReply interactive prompts for multi-step commands

## Quick Start

### 1. Prerequisites

- **Node.js 18+** and npm
- **Claude Code CLI** installed and authenticated (`claude` in your PATH)
- A **Telegram bot token** from [@BotFather](https://t.me/botfather)
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot)
- If `claude` isn't in your PATH, set `CLAUDE_EXECUTABLE_PATH` in `.env`

### 2. Clone & Configure

```bash
git clone https://github.com/lliWcWill/claudegram.git
cd claudegram
cp .env.example .env
```

Edit `.env` with your values (see [Configuration](#configuration) for all options):

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_USER_IDS=your_user_id
```

### 3. Install & Run

```bash
npm install
npm run dev
```

Open your bot in Telegram and send `/start`.

## Optional Integrations

### Reddit (`/reddit`)
1. Install the redditfetch tool (see `redditTools/README.md` in that repo).
2. Set `REDDITFETCH_PATH` in `.env` to the absolute path of `redditfetch.py`.
3. Configure Reddit API credentials in the redditfetch `.env` (client ID/secret, username, password).

Example `.env` (Claudegram):
```
REDDITFETCH_PATH=/absolute/path/to/redditfetch.py
```

### Medium (`/medium`)
1. Install Python deps (Playwright, bs4, html2text, requests) in a venv.
2. Install Chromium: `python -m playwright install chromium`
3. Set `MEDIUM_FETCH_PATH` and `MEDIUM_FETCH_PYTHON` in `.env`.
4. (Optional) Set proxy and cookie storage if Cloudflare blocks.
5. (Optional) Generate cookies with `scripts/medium_login.py` and set `MEDIUM_FETCH_STORAGE_STATE`.

Example `.env`:
```
MEDIUM_FETCH_PATH=/absolute/path/to/claudegram/scripts/medium_fetch.py
MEDIUM_FETCH_PYTHON=/absolute/path/to/venv/bin/python
```

Optional:
```
MEDIUM_FETCH_PROXY=http://user:pass@host:port
MEDIUM_FETCH_PROXY_LIST=/absolute/path/to/proxies.txt
MEDIUM_FETCH_PROXY_ROTATE=random
MEDIUM_FETCH_PROXY_RETRIES=3
MEDIUM_FETCH_VERBOSE=true
MEDIUM_FETCH_CURL_CFFI_FIRST=true
MEDIUM_FETCH_CURL_CFFI_IMPERSONATE=chrome
MEDIUM_FETCH_STORAGE_STATE=/absolute/path/to/storage_state.json
MEDIUM_FETCH_NETSCAPE_COOKIES=/absolute/path/to/cookies.txt
MEDIUM_FETCH_SAVE_STORAGE_STATE=/absolute/path/to/save_state.json
MEDIUM_FETCH_RSS_FALLBACK=true
```

Cookie capture helper (manual login):
```
python3 scripts/medium_login.py --storage-state /absolute/path/to/storage_state.json
```

Decodo Scraper API (bypasses Playwright/Cloudflare when enabled):
```
MEDIUM_FETCH_DECODO_API_KEY=your_decodo_api_key_or_user:pass
# or
MEDIUM_FETCH_DECODO_USER=U0000...
MEDIUM_FETCH_DECODO_PASS=PW_...
MEDIUM_FETCH_DECODO_ADVANCED=false
MEDIUM_FETCH_DECODO_ENDPOINT=https://scraper-api.decodo.com/v2/scrape
MEDIUM_FETCH_DECODO_TARGET=universal
MEDIUM_FETCH_DECODO_EXTRA_JSON={"render": true}
MEDIUM_FETCH_FORCE_PLAYWRIGHT=false
```

PingProxies (residential API):
```
PROXY_API_PUBLIC_KEY=your_public_key
PROXY_API_PRIVATE_KEY=your_private_key
PROXY_API_PROVIDER=pingproxies
PROXY_API_PROXY_USER_ID=your_proxy_user_id
PROXY_API_COUNTRY_ID=us
PROXY_API_LIST_SESSION_TYPE=sticky
PROXY_API_LIST_COUNT=10
PROXY_API_LIST_FORMAT=http
PROXY_API_BASE_URL=https://api.pingproxies.com/1.0/public
```

### Voice Transcription (Groq Whisper)
1. Place `groq_transcribe.py` somewhere on your machine.
2. Set `GROQ_API_KEY` and `GROQ_TRANSCRIBE_PATH` in `.env`.

Example:
```
GROQ_API_KEY=your_groq_key
GROQ_TRANSCRIBE_PATH=/absolute/path/to/groq_transcribe.py
```

### Text-to-Speech (OpenAI)
1. Set `OPENAI_API_KEY` in `.env`.
2. Optionally customize `TTS_MODEL`, `TTS_VOICE`, `TTS_INSTRUCTIONS`, and `TTS_RESPONSE_FORMAT`.

Example:
```
OPENAI_API_KEY=your_openai_key
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=coral
TTS_RESPONSE_FORMAT=opus
```

### Image Uploads
No extra setup required. Images sent in chat are saved to:
```
<project>/.claudegram/uploads/
```

## Commands

### Session Management
| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/project` | Set working directory (interactive picker) |
| `/newproject <name>` | Create and open a new project |
| `/clear` | Clear conversation history and session |
| `/status` | Show current session info |
| `/sessions` | List all saved sessions |
| `/resume` | Pick from recent sessions |
| `/continue` | Resume most recent session |

**Note:** `/resume` and `/continue` restore the last project + Claude session ID. This enables conversation continuity across bot restarts.

### Agent Modes
| Command | Description |
|---------|-------------|
| `/plan` | Enter plan mode for complex tasks |
| `/explore` | Explore codebase to answer questions |
| `/loop` | Run iteratively until task complete |
| `/model` | Switch between Sonnet / Opus / Haiku |
| `/mode` | Toggle streaming / wait mode |

### Reddit
| Command | Description |
|---------|-------------|
| `/reddit` | Fetch posts, subreddits, or user profiles |

### Medium
| Command | Description |
|---------|-------------|
| `/medium` | Fetch Medium article with local images |

### Voice & TTS
| Command | Description |
|---------|-------------|
| `/tts` | Toggle voice replies on/off, change voice |
| *Send voice note* | Auto-transcribed and processed as text |
| *Send photo / image doc* | Saved to project and passed to agent |

### File Operations
| Command | Description |
|---------|-------------|
| `/file` | Download a file from your project |
| `/telegraph` | View markdown with Instant View |

### Utility
| Command | Description |
|---------|-------------|
| `/ping` | Check if bot is responsive |
| `/botstatus` | Show bot process status |
| `/restartbot` | Restart the bot process |
| `/cancel` | Cancel the current request |
| `/commands` | Show all available commands |

## Configuration

All configuration is via environment variables. See `.env.example` for the full reference with descriptions.

### Required
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs |

### Optional — Core
| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (optional if using Claude Max) |
| `CLAUDEGRAM_ENV_PATH` | — | Explicit path to `.env` (if starting from another directory) |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | Path to Claude Code CLI |
| `BOT_NAME` | `Claudegram` | Bot personality name in system prompt |
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `STREAMING_MODE` | `streaming` | `streaming` or `wait` |
| `MAX_MESSAGE_LENGTH` | `4096` | Chars before switching to Telegraph |
| `DANGEROUS_MODE` | `false` | Auto-approve all tool permissions |

### Optional — Reddit
| Variable | Default | Description |
|----------|---------|-------------|
| `REDDITFETCH_PATH` | — | Path to `redditfetch.py` script |
| `REDDITFETCH_TIMEOUT_MS` | `30000` | Execution timeout |
| `REDDITFETCH_DEFAULT_LIMIT` | `10` | Default `--limit` |
| `REDDITFETCH_DEFAULT_DEPTH` | `5` | Default comment `--depth` |
| `REDDITFETCH_JSON_THRESHOLD_CHARS` | `8000` | Auto-switch to JSON output above this size |

### Optional — Medium
| Variable | Default | Description |
|----------|---------|-------------|
| `MEDIUM_FETCH_PATH` | — | Path to `medium_fetch.py` script |
| `MEDIUM_FETCH_PYTHON` | `python3` | Python interpreter for Medium fetch |
| `MEDIUM_FETCH_TIMEOUT_MS` | `60000` | Execution timeout |
| `MEDIUM_FETCH_FILE_THRESHOLD_CHARS` | `8000` | Send Markdown file above this size |
| `MEDIUM_FETCH_PROXY` | — | Proxy URL for Playwright |
| `MEDIUM_FETCH_PROXY_LIST` | — | Path to proxy list file |
| `MEDIUM_FETCH_PROXY_ROTATE` | `round_robin` | Proxy rotation strategy |
| `MEDIUM_FETCH_PROXY_RETRIES` | `3` | Proxy attempts before failing |
| `MEDIUM_FETCH_VERBOSE` | `false` | Enable verbose logging for Medium fetch |
| `MEDIUM_FETCH_CURL_CFFI_FIRST` | `false` | Try curl_cffi before Playwright |
| `MEDIUM_FETCH_CURL_CFFI_IMPERSONATE` | `chrome` | curl_cffi impersonation profile |
| `MEDIUM_FETCH_PROXY_API_PROVIDER` | — | Proxy API provider (pingproxies) |
| `MEDIUM_FETCH_PROXY_API_USER_ID` | — | Proxy API user ID |
| `MEDIUM_FETCH_PROXY_API_COUNTRY` | `us` | Proxy API country |
| `MEDIUM_FETCH_PROXY_API_SESSION_TYPE` | `sticky` | Proxy API session type |
| `MEDIUM_FETCH_PROXY_API_COUNT` | `10` | Proxy API list count |
| `MEDIUM_FETCH_PROXY_API_FORMAT` | `http` | Proxy API list format |
| `MEDIUM_FETCH_PROXY_API_BASE_URL` | `https://api.pingproxies.com/1.0/public` | Proxy API base URL |
| `MEDIUM_FETCH_DECODO_API_KEY` | — | Decodo Scraper API key or `user:pass` (bypasses Playwright) |
| `MEDIUM_FETCH_DECODO_USER` | — | Decodo username (if not using key) |
| `MEDIUM_FETCH_DECODO_PASS` | — | Decodo password (if not using key) |
| `MEDIUM_FETCH_DECODO_ADVANCED` | `false` | Use Decodo Advanced headless mode |
| `MEDIUM_FETCH_DECODO_ENDPOINT` | `https://scraper-api.decodo.com/v2/scrape` | Decodo API endpoint |
| `MEDIUM_FETCH_DECODO_TARGET` | `universal` | Decodo target for Web Scraping API |
| `MEDIUM_FETCH_DECODO_EXTRA_JSON` | — | Extra Decodo payload JSON (string) |
| `MEDIUM_FETCH_FORCE_PLAYWRIGHT` | `false` | Force Playwright even if Decodo key is set |
| `MEDIUM_FETCH_STORAGE_STATE` | — | Playwright storage state JSON (cookies) |
| `MEDIUM_FETCH_NETSCAPE_COOKIES` | — | Netscape cookie file (txt) |
| `MEDIUM_FETCH_SAVE_STORAGE_STATE` | — | Save storage state after fetch |
| `MEDIUM_FETCH_RSS_FALLBACK` | `true` | Use RSS fallback when blocked |

### Optional — Proxy API Keys
| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_API_PUBLIC_KEY` | — | Proxy API public key |
| `PROXY_API_PRIVATE_KEY` | — | Proxy API private key |
| `PROXY_API_PROVIDER` | — | Proxy API provider (pingproxies) |
| `PROXY_API_PROXY_USER_ID` | — | Proxy API proxy_user_id |
| `PROXY_API_COUNTRY_ID` | `us` | Country targeting |
| `PROXY_API_LIST_SESSION_TYPE` | `sticky` | Session type |
| `PROXY_API_LIST_COUNT` | `10` | Proxies to generate |
| `PROXY_API_LIST_FORMAT` | `http` | Format (http/socks5/socks5h) |
| `PROXY_API_BASE_URL` | `https://api.pingproxies.com/1.0/public` | Base URL |

### Optional — Voice Transcription
| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key for Whisper |
| `GROQ_TRANSCRIBE_PATH` | — | Path to `groq_transcribe.py` script |
| `VOICE_SHOW_TRANSCRIPT` | `true` | Show transcript before response |
| `VOICE_MAX_FILE_SIZE_MB` | `19` | Max voice file size |
| `VOICE_LANGUAGE` | `en` | Transcription language (ISO 639-1) |
| `VOICE_TIMEOUT_MS` | `60000` | Transcription timeout |

### Optional — Text-to-Speech
| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key for TTS |
| `TTS_MODEL` | `gpt-4o-mini-tts` | TTS model |
| `TTS_VOICE` | `coral` | Default voice |
| `TTS_INSTRUCTIONS` | *friendly tone* | Tone instructions (gpt-4o-mini-tts) |
| `TTS_SPEED` | `1.0` | Speech speed (0.25–4.0) |
| `TTS_MAX_CHARS` | `4096` | Skip voice for longer responses |
| `TTS_RESPONSE_FORMAT` | `opus` | Audio format (`opus`, `mp3`, `wav`, `flac`, `aac`) |

### Optional — Image Uploads
| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_MAX_FILE_SIZE_MB` | `20` | Max image size for download/save |

## Architecture

```
src/
  bot/
    bot.ts                  # Bot setup, command & handler registration
    handlers/
      command.handler.ts    # /project, /reddit, /tts, /mode, etc.
      message.handler.ts    # Text message routing & response pipeline
      voice.handler.ts      # Voice note download, transcription, agent relay
      photo.handler.ts      # Image download, save, and agent notification
    middleware/
      auth.ts               # User whitelist enforcement
      stale-filter.ts       # Ignore old messages on restart
  claude/
    agent.ts                # Claude Code SDK integration, session resume, system prompt
    session-manager.ts      # Per-chat session state (working dir, activity)
    request-queue.ts        # Sequential request queue per chat
    command-parser.ts       # Help text and command descriptions
  telegram/
    message-sender.ts       # Streaming, chunking, Telegraph, MarkdownV2
    markdown.ts             # MarkdownV2 escaping and formatting
    telegraph.ts            # Telegraph Instant View page creation
    deduplication.ts        # Message dedup to prevent double-processing
  tts/
    openai-tts.ts           # OpenAI TTS API client
    tts-settings.ts         # Per-chat TTS settings (enabled, voice)
    voice-reply.ts          # maybeSendVoiceReply() — TTS hook for responses
  config.ts                 # Zod-validated environment config
  index.ts                  # Entry point
```

## Development

```bash
# Dev mode with hot reload
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build

# Run production build
npm start
```

## Self‑Editing Workflow (Bot Working on Itself)

If you’re using Claudegram to modify its own codebase, **avoid dev/watch mode**. Hot reload will restart the bot on every file change and interrupt your session.

Recommended flow:
1. Start **prod** mode (no hot reload): `./scripts/claudegram-botctl.sh prod start`
2. Let the bot edit files safely without restarts.
3. When you’re ready to apply changes: `./scripts/claudegram-botctl.sh prod restart`
4. In Telegram, run `/continue` or `/resume` to restore your session.

Notes:
- Changes only take effect **after** a restart in prod mode.
- Use `/botstatus` to verify the bot is running.

## Security

- Only configured Telegram user IDs can interact with the bot
- Claude operates within the configured working directory
- Uses `acceptEdits` permission mode by default
- `DANGEROUS_MODE` auto-approves all tool permissions — use with caution
- API keys are loaded from `.env` (gitignored) — never committed

## Credits

Original project by [NachoSEO](https://github.com/NachoSEO/claudegram).

Extended with Reddit integration, voice transcription, TTS voice replies, image uploads, conversation continuity, and rich output formatting.

## License

MIT

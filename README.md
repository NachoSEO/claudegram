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
- File-based workflow: large posts are saved to `.reddit/` and analyzed with Read/Grep — no context bloat
- Semantic mapping: "trending" -> `--sort hot`, "this week's best" -> `--sort top --time week`

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

### Voice & TTS
| Command | Description |
|---------|-------------|
| `/tts` | Toggle voice replies on/off, change voice |
| *Send voice note* | Auto-transcribed and processed as text |

### File Operations
| Command | Description |
|---------|-------------|
| `/file` | Download a file from your project |
| `/telegraph` | View markdown with Instant View |

### Utility
| Command | Description |
|---------|-------------|
| `/ping` | Check if bot is responsive |
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

### Optional — Voice Transcription
| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key for Whisper |
| `GROQ_TRANSCRIBE_PATH` | — | Path to `groq_transcribe.py` script |
| `VOICE_SHOW_TRANSCRIPT` | `true` | Show transcript before response |
| `VOICE_MAX_FILE_SIZE_MB` | `19` | Max voice file size |
| `VOICE_LANGUAGE` | `en` | Transcription language (ISO 639-1) |

### Optional — Text-to-Speech
| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key for TTS |
| `TTS_MODEL` | `gpt-4o-mini-tts` | TTS model |
| `TTS_VOICE` | `coral` | Default voice |
| `TTS_INSTRUCTIONS` | *friendly tone* | Tone instructions (gpt-4o-mini-tts) |
| `TTS_SPEED` | `1.0` | Speech speed (0.25–4.0) |
| `TTS_MAX_CHARS` | `4096` | Skip voice for longer responses |

## Architecture

```
src/
  bot/
    bot.ts                  # Bot setup, command & handler registration
    handlers/
      command.handler.ts    # /project, /reddit, /tts, /mode, etc.
      message.handler.ts    # Text message routing & response pipeline
      voice.handler.ts      # Voice note download, transcription, agent relay
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

## Security

- Only configured Telegram user IDs can interact with the bot
- Claude operates within the configured working directory
- Uses `acceptEdits` permission mode by default
- `DANGEROUS_MODE` auto-approves all tool permissions — use with caution
- API keys are loaded from `.env` (gitignored) — never committed

## Credits

Original project by [NachoSEO](https://github.com/NachoSEO/claudegram).

Extended with Reddit integration, voice transcription, TTS voice replies, conversation continuity, and rich output formatting.

## License

MIT

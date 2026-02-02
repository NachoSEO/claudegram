# GEMINI.md - Claudegram Project Context

## Project Overview

Claudegram is a sophisticated Telegram bot that acts as a bridge to the **Claude Code agent** running locally on a machine. It allows users to control their local environment, execute bash commands, read/write files, and perform agentic tasks directly from Telegram.

The project is designed to be more than just an API wrapper; it integrates the full Claude Agent SDK with features like session memory, streaming responses, and specialized tools for Reddit, Medium, and media extraction.

### Main Technologies
- **Runtime:** Node.js (v18+)
- **Language:** TypeScript (ESM)
- **Telegram Framework:** [Grammy](https://grammy.dev/)
- **Agent Integration:** [@anthropic-ai/claude-agent-sdk](https://docs.anthropic.com/en/docs/claude-code)
- **Configuration:** Zod (for validation) and dotenv
- **Formatting:** Telegram MarkdownV2 and Telegra.ph (Instant View)
- **Integrations:** Groq (Whisper for transcription), OpenAI (TTS), Freedium (Medium scraping)

## Architecture Summary

The project follows a modular structure in `src/`:

- `bot/`: Bot initialization and handlers.
    - `handlers/`: Logic for slash commands, text messages, voice notes, and photos.
    - `middleware/`: Authentication (whitelist) and stale message filtering.
- `claude/`: Core agent logic.
    - `agent.ts`: Integration with Claude Agent SDK, system prompts, and loop/explore modes.
    - `session-manager.ts`: Per-chat session state and working directory management.
    - `request-queue.ts`: Ensures sequential processing of requests per chat.
    - `session-history.ts`: Persists session data for resume/continue capabilities.
- `telegram/`: Telegram-specific utilities.
    - `message-sender.ts`: Handles streaming, chunking, and Telegraph routing.
    - `markdown.ts`: Advanced MarkdownV2 escaping and code block preservation.
    - `telegraph.ts`: Client for publishing long responses as Instant View pages.
    - `terminal-renderer.ts`: Logic for "Terminal UI" mode (spinners, tool icons).
- `reddit/`, `medium/`, `media/`, `audio/`, `tts/`: Specialized integration modules.
- `utils/`: Common utilities (file type detection, sanitization, caffeinate).

## Building and Running

### Development
```bash
npm install
npm run dev          # Start with hot reload (tsx watch)
npm run typecheck    # Run TypeScript compiler in no-exit mode
```

### Production
```bash
npm run build        # Compile TypeScript to dist/
npm start            # Run the compiled code
```

### Bot Control Script
A helper script is provided in `scripts/claudegram-botctl.sh` for managing the bot process (start, stop, restart, logs) in both dev and prod modes.

## Development Conventions

### 1. Modules and Types
- Use **ESM** (ECMAScript Modules). Imports must include the `.js` extension (e.g., `import { x } from './y.js'`).
- Leverage **TypeScript** strictly. Use interfaces for complex objects.
- Use **Zod** for any new configuration or external data validation (see `src/config.ts`).

### 2. Request Handling
- **Sequentiality:** All requests for a specific `chatId` MUST be queued via `queueRequest` in `src/claude/request-queue.ts`. This prevents race conditions in the local environment.
- **Streaming:** Prefer streaming responses for long-running agent tasks. Use `messageSender.startStreaming` and `messageSender.updateStream`.

### 3. Telegram Formatting
- **MarkdownV2:** Always escape text for MarkdownV2 using `escapeMarkdownV2` from `src/telegram/markdown.ts`.
- **Telegraph:** For responses exceeding ~2500 characters, use `telegraph.ts` to create an Instant View page.
- **Chunking:** `splitMessage` in `src/telegram/markdown.ts` should be used to break long messages while preserving code block integrity.

### 4. Sessions and Paths
- Sessions are persisted in `.claudegram/sessions.json`.
- `resolveWorkingDirectory` in `session-manager.ts` handles path portability across different Operating Systems (remaps home directories).
- Working directories should be validated with `fs.existsSync` before initializing the agent.

### 5. Claude Agent Context
- The agent's system prompt is constructed in `src/claude/agent.ts`. It includes specific instructions for Telegraph rendering (e.g., "NEVER use markdown tables; use lists or pre blocks").
- Agent modes (`plan`, `explore`, `loop`) use specific `permissionMode` settings in the SDK.

## Key Files
- `src/config.ts`: Central configuration schema.
- `src/claude/agent.ts`: The bridge to Claude Code.
- `src/bot/handlers/message.handler.ts`: Entry point for all incoming text messages.
- `src/telegram/message-sender.ts`: Complex response delivery logic.

## Environment Variables
Refer to `.env.example` for all required and optional variables. Key ones include:
- `TELEGRAM_BOT_TOKEN`: Your bot's token.
- `ALLOWED_USER_IDS`: Whitelist of Telegram IDs.
- `WORKSPACE_DIR`: Default root for project discovery.
- `CLAUDE_EXECUTABLE_PATH`: Path to the `claude` CLI.

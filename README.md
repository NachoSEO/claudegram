# Claudegram

A Telegram bot that bridges messages to Claude Code running on your local machine, providing full agent capabilities (Bash, Read, Write, Edit, etc.) via Telegram.

## Architecture

```
Telegram App → Telegram API → Claudegram Bot → Claude Agent SDK → Local Machine
```

## Setup

1. **Create a Telegram Bot**
   - Open [@BotFather](https://t.me/botfather) in Telegram
   - Send `/newbot` and follow the instructions
   - Copy the bot token

2. **Get Your Telegram User ID**
   - Open [@userinfobot](https://t.me/userinfobot) in Telegram
   - It will send you your user ID

3. **Configure Environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your values:
   ```bash
   TELEGRAM_BOT_TOKEN=your_bot_token
   ALLOWED_USER_IDS=your_user_id
   ANTHROPIC_API_KEY=your_anthropic_key
   ```

4. **Install Dependencies**
   ```bash
   npm install
   ```

5. **Run the Bot**
   ```bash
   npm run dev
   ```

## Usage

1. Open your bot in Telegram
2. Send `/start` to see available commands
3. Set your project directory: `/project /path/to/your/project`
4. Start chatting with Claude about your code!

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/project <path>` | Set working directory |
| `/clear` | Clear session and start fresh |
| `/status` | Show current session info |
| `/mode` | Show response mode |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | Required |
| `ALLOWED_USER_IDS` | Comma-separated user IDs | Required |
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Required |
| `STREAMING_MODE` | `streaming` or `wait` | `streaming` |
| `STREAMING_DEBOUNCE_MS` | Update debounce in ms | `500` |
| `MAX_MESSAGE_LENGTH` | Max Telegram message length | `4000` |

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build

# Run production build
npm start
```

## Security

- Only configured user IDs can interact with the bot
- Claude operates within the specified working directory
- Uses `acceptEdits` permission mode for file operations

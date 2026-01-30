# Medium Scraper Handoff

Date: 2026-01-26

## What was built

A headless Playwright pipeline that fetches a Medium article, cleans it, converts it to Markdown, downloads images locally, and appends image references. It is designed to be agent‑friendly and integrated into Claudegram as `/medium`.

## Why

Medium pages are often blocked by Cloudflare when fetched via `requests` (403). Playwright usually works, but can still be blocked. We now support **Decodo Scraper API** as a first‑class fetch mode to bypass Cloudflare when available, then transform the returned HTML into Markdown + local images.

## Key Files

### Claudegram
- `scripts/medium_fetch.py` — CLI tool (Playwright → HTML → cleaned Markdown/JSON/text + images)
- `src/bot/handlers/command.handler.ts` — `/medium` command + executor
- `src/bot/handlers/message.handler.ts` — ForceReply handling for `/medium`
- `src/bot/bot.ts` — command registration
- `src/claude/command-parser.ts` — `/commands` list updated
- `src/claude/agent.ts` — system prompt includes Medium tool usage
- `src/config.ts` + `.env.example` — new env vars
- `README.md` — Medium integration + setup + config vars

### External reference repo (for testing)
- `~/medium-tools/medium2md/` — cloned repo used for validation
- `~/medium-tools/medium2md/scripts/medium_playwright_md.py` — standalone test script (safe reference)

## CLI Usage

```bash
python3 scripts/medium_fetch.py "<url>" \
  [--format markdown|json|text] \
  [--out-dir <dir>] \
  [--no-images] \
  [--no-clean] \
  [--proxy <url>] \
  [--proxy-list <file>] \
  [--proxy-rotate round_robin|random] \
  [--decodo-api-key <key>] \
  [--decodo-advanced] \
  [--decodo-endpoint <url>] \
  [--storage-state <file>] \
  [--save-storage-state <file>]
```

Outputs (in out-dir):
- `article.md`
- `article.html`
- `article.txt`
- `metadata.json`
- `images/` folder

The markdown includes an **Image References** section with local path + original URL.

## Claudegram /medium Behavior

- `/medium <url>` invokes `scripts/medium_fetch.py` via `MEDIUM_FETCH_PYTHON`
- Saves output under `.claudegram/medium/<slug>/...`
- Sends Markdown in chat; if output is large, sends `article.md` as a file

## New Env Vars

```
MEDIUM_FETCH_PATH=/absolute/path/to/claudegram/scripts/medium_fetch.py
MEDIUM_FETCH_PYTHON=/absolute/path/to/venv/bin/python
MEDIUM_FETCH_TIMEOUT_MS=60000
MEDIUM_FETCH_FILE_THRESHOLD_CHARS=8000
MEDIUM_FETCH_PROXY=
MEDIUM_FETCH_PROXY_LIST=
MEDIUM_FETCH_PROXY_ROTATE=round_robin
MEDIUM_FETCH_PROXY_RETRIES=3
MEDIUM_FETCH_VERBOSE=false
MEDIUM_FETCH_CURL_CFFI_FIRST=false
MEDIUM_FETCH_CURL_CFFI_IMPERSONATE=chrome
MEDIUM_FETCH_DECODO_API_KEY=token_or_user:pass
MEDIUM_FETCH_DECODO_USER=U0000...
MEDIUM_FETCH_DECODO_PASS=PW_...
MEDIUM_FETCH_DECODO_ADVANCED=false
MEDIUM_FETCH_DECODO_ENDPOINT=https://scraper-api.decodo.com/v2/scrape
MEDIUM_FETCH_DECODO_TARGET=universal
MEDIUM_FETCH_DECODO_EXTRA_JSON={"render": true}
MEDIUM_FETCH_NETSCAPE_COOKIES=/absolute/path/to/cookies.txt
MEDIUM_FETCH_STORAGE_STATE=/absolute/path/to/storage_state.json
MEDIUM_FETCH_SAVE_STORAGE_STATE=/absolute/path/to/save_state.json
MEDIUM_FETCH_RSS_FALLBACK=true
```

## Playwright Setup (required)

```bash
python -m venv .venv
.venv/bin/pip install playwright html2text beautifulsoup4 requests
.venv/bin/python -m playwright install chromium
```

Then point `MEDIUM_FETCH_PYTHON` to `.venv/bin/python`.

## Cookie capture (manual login)

```bash
python3 scripts/medium_login.py --storage-state /absolute/path/to/storage_state.json
```

Set `MEDIUM_FETCH_STORAGE_STATE` to the saved file so `medium_fetch.py` reuses cookies.

## Test URL

```
https://medium.com/@peltomakiw/how-a-single-email-turned-my-clawdbot-into-a-data-leak-1058792e783a
```

### Manual validation
- `scripts/medium_fetch.py <url>` should output Markdown + save images
- Check `.claudegram/medium/<slug>/images` for downloaded files
- Ensure `article.md` contains local image paths

## Known Limitations

- UI noise can still appear; we remove common elements and post‑clean Markdown.
- Some Medium posts may lazy‑load images; Playwright should still capture them.
- If Chromium install fails, Playwright will error — fix via `python -m playwright install chromium`.
- If you use SOCKS proxies, image downloads and RSS fallback may bypass the proxy (requests does not include socks by default).
- Decodo API mode ignores Playwright storage state (cookies).

## PingProxies (Residential API)

If Cloudflare blocks requests, use PingProxies residential proxies. The script can auto-generate proxies when the API keys are available.

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

The script will call `/user/residential/list` and use the first proxy (or a random one when `--proxy-rotate random` is set).

## Next Steps

1. Add a small cleanup step to strip leftover UI strings if you see more noise.
2. Consider adding a `--max-images` option if storage becomes an issue.
3. Optional: add a cached HTML fetch to avoid repeated Playwright runs.

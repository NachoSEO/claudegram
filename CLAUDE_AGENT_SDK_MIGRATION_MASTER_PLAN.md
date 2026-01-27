# Claudegram → Agent SDK Migration (Master PRD + Safe Plan)

Audience: Claude Code (implementation agent)

Purpose: Provide a complete, low‑risk migration plan from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk` in **TypeScript**, preserving all current behavior while enabling future upgrades (MCP status, supported models, hooks, rewind, etc.).

---

## 1) Executive Summary

We are migrating Claudegram’s agent layer from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk`.

**Why migrate?** The Agent SDK is the official successor with richer APIs (hooks, MCP server status, supported models/commands, file rewind, structured outputs, sandboxing, programmatic agents). It is a superset of current capabilities.

**Key constraint:** `/context` is **not yet supported** programmatically in SDK (open issue #507). This migration **does not fix /context**; we keep the CLI fallback for now.

**Success criteria:** Claudegram behaves identically for all existing bot commands and conversations, while switching the underlying SDK and preserving session continuity.

---

## 2) Goals

- Replace `@anthropic-ai/claude-code` with `@anthropic-ai/claude-agent-sdk` in the agent layer.
- Preserve **all current functionality**: streaming, tool use, resume, model switching, permission mode, Reddit, TTS, images, voice, queueing, and error handling.
- Maintain session continuity (resume by session ID) and conversation history.
- Keep CLI‑based admin commands (`/botstatus`, `/restartbot`, `/context` fallback) working.
- Ensure CLAUDE.md or project settings are loaded consistently (explicit `settingSources`).

## 3) Non‑Goals (for this migration)

- Implementing new Agent SDK features beyond parity (hooks, MCP SDK tools, rewind, etc.).
- Fixing `/context` (not supported via SDK yet). Continue to show a graceful “not supported” message.
- Changing the user-facing behavior or command surface area.

---

## 4) Migration Decision: Pros / Cons

**Pros**
- First‑class `model` option (no cast hack)
- Full access to `supportedModels()`, `supportedCommands()`, `mcpServerStatus()`, `accountInfo()`
- Built‑in executable (removes `CLAUDE_EXECUTABLE_PATH` dependency for agent queries)
- Structured outputs, sandboxing, file rewind, hooks, and MCP SDK tools are now available

**Cons / Risks**
- SDK defaults differ: **settings are not loaded unless `settingSources` is set**
- System prompt API changes: must use `systemPrompt` with preset
- Small message schema differences possible → need careful testing
- `/context` still unavailable (same limitation)

**Bottom line:** Migration is a net win if we reproduce defaults carefully and test parity.

---

## 5) Parity Checklist (Must Keep Working)

- ✅ Resume/continue session (uses stored Claude session ID)
- ✅ Project path handling and session state
- ✅ Streaming vs wait response modes
- ✅ Queue / cancel / loop / explore / plan commands
- ✅ All tool permissions and tool use restrictions
- ✅ Logging and error handling still stable
- ✅ TTS, voice, image, Reddit features unaffected

---

## 6) Plan: Phased, Safe Migration

### Phase 0 — Prep (No behavior change)
1. Add migration plan doc (this file).
2. Confirm tests pass pre‑migration.

### Phase 1 — Dependency switch (low risk)
1. Add dependency: `@anthropic-ai/claude-agent-sdk`.
2. Remove `@anthropic-ai/claude-code` from dependencies.
3. Update imports in `src/claude/agent.ts`.

### Phase 2 — Agent layer changes (core)
Update `src/claude/agent.ts`:
- Replace:
  - `appendSystemPrompt` → `systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT }`
  - `pathToClaudeCodeExecutable` → **remove** (SDK bundles its own)
  - `(queryOptions as Record<string, unknown>).model` → `model` (typed)
- Add **explicit `settingSources`**: recommended `['project']` (so CLAUDE.md works)
- Ensure `allowedTools`, `permissionMode`, `cwd`, `resume`, `abortController` are set the same as before
- Keep stderr logging callback

### Phase 3 — Compatibility checks
- Verify message stream types still match expectations (`assistant`, `result`, `system`)
- If anything changes in message shape, update parsing logic accordingly

### Phase 4 — Testing & rollout
- Run typecheck + build
- Run bot in prod mode and test all core commands
- If errors, rollback via git or reinstall old SDK

---

## 7) Exact Code Mapping (Old → New)

**Old:**
```ts
import { query, type SDKMessage } from '@anthropic-ai/claude-code';

const queryOptions = {
  cwd: session.workingDirectory,
  allowedTools: ['Bash','Read','Write','Edit','Glob','Grep','Task'],
  permissionMode,
  abortController: controller,
  pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH,
  appendSystemPrompt: SYSTEM_PROMPT,
  stderr: (data) => console.error('[Claude stderr]:', data),
};
if (existingSessionId) queryOptions.resume = existingSessionId;
(queryOptions as Record<string, unknown>).model = effectiveModel;
```

**New:**
```ts
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const queryOptions = {
  cwd: session.workingDirectory,
  allowedTools: ['Bash','Read','Write','Edit','Glob','Grep','Task'],
  permissionMode,
  abortController: controller,
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: SYSTEM_PROMPT,
  },
  settingSources: ['project'], // ensures CLAUDE.md is loaded
  stderr: (data: string) => console.error('[Claude stderr]:', data),
  resume: existingSessionId,
  model: effectiveModel,
};
```

---

## 8) Configuration & Env Changes

- Keep `CLAUDE_EXECUTABLE_PATH` for CLI utilities (not used by SDK query). Do not delete unless you also remove CLI utilities.
- No new env required for SDK.

Optional future additions:
- `AGENT_BACKEND=agent-sdk|claude-code` (feature flag for fallback)
- `SETTING_SOURCES=project|user|local` (string list → array)

---

## 9) Testing Plan (Must Pass)

### CLI smoke tests
- `npm run typecheck`
- `npm run build`

### Telegram tests (prod)
1. `/project <path>` — sets project
2. Send normal text → agent responds
3. `/resume` then send text → agent remembers
4. `/model` → change model, send text
5. `/loop` and `/plan` flows
6. `/reddit` command still works
7. TTS on/off, voice reply works
8. Voice note transcription works
9. Image upload -> stored in project
10. `/context` still returns “not supported” (expected)

---

## 10) Rollback Plan

If any regression:
1. `git revert` the migration commit(s)
2. Reinstall old dependency: `@anthropic-ai/claude-code`
3. Restart bot via `/restartbot`

---

## 11) Known Gaps

- `/context` is **not supported** via SDK or CLI in `-p` mode yet. Keep graceful failure.
- Feature request: <https://github.com/anthropics/claude-agent-sdk-python/issues/507>

---

## 12) Implementation Checklist (for Claude Code)

- [x] Update `package.json` dependencies — `@anthropic-ai/claude-agent-sdk@^0.2.19`, removed `@anthropic-ai/claude-code`, upgraded `zod@^4.3.6`
- [x] Update imports in `src/claude/agent.ts` — `@anthropic-ai/claude-agent-sdk` with `PermissionMode`, `SettingSource` types
- [x] Replace query options per mapping — `systemPrompt` preset+append, `model` first-class, `allowDangerouslySkipPermissions`
- [x] Add `settingSources: ['project']` — ensures CLAUDE.md is loaded
- [x] Remove `pathToClaudeCodeExecutable` from query — SDK bundles its own executable
- [x] Fix zod v4 breaking change — `error.format()` → `error.message` in `src/config.ts`
- [x] Run typecheck + build — clean, zero errors
- [ ] Restart prod bot
- [ ] Run full Telegram test suite
- [ ] Summarize changes + any regressions

---

## 13) Acceptance Criteria

- Bot works exactly as before (no regressions)
- Session resume and memory persist
- Tools and permissions behave the same
- No TypeScript errors
- README does not require updates (optional future doc update)

---

## 14) Notes for Claude Code

- This plan is intentionally conservative. Do **not** add new features during migration.
- If message shapes differ, adjust parsing logic only to restore parity.
- If settingSources causes unexpected behavior, test `['project','user']` but **do not** enable local by default.


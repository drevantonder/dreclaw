# dréclaw

`dréclaw` is a personal Cloudflare-first Telegram AI assistant.

## v0 Scope

- Telegram private chat-only, single-user (me)
- Chat SDK + Telegram adapter runtime
- Commands: `/help`, `/status`, `/model`, `/new`, `/reset`, `/factory-reset`, `/stop`, `/verbose`, `/thinking`, `/reasoning`, `/google ...`
- Core tool: `codemode`
- Persistent memory: D1 episodic/fact memory + Vectorize semantic recall
- Hybrid memory pipeline: D1 episodic/fact memory + Vectorize semantic recall (Workers AI embeddings)
- AI SDK provider switch: `opencode`, `opencode-go`, or `workers` (Workers AI)

## Architecture (High-level)

```mermaid
flowchart TD
  U[Telegram Chat] --> W[Worker Gateway]
  W --> C[Chat SDK]
  C --> M[Model Loop]
  M --> MM[Memory: episodes/facts]
  M --> T[Tool: codemode]
  C --> W --> U
```

- Worker routes Telegram webhooks into Chat SDK.
- Chat SDK handles Telegram transport, subscriptions, streaming, and locking via a D1-backed state adapter.
- Runtime retrieves memory context (hybrid semantic + lexical + recency) and injects it into the system prompt.
- Agent loop runs on AI SDK `ToolLoopAgent` with runtime-managed memory persistence.
- OpenCode uses `AI_PROVIDER=opencode` (Zen default URL) or `AI_PROVIDER=opencode-go` (Go default URL).
- Workers AI runs via `workers-ai-provider` binding (`env.AI`) when `AI_PROVIDER=workers`.
- Agent can run sandboxed JS with `codemode`.

## Setup

### Prereqs

- Cloudflare account
- Telegram bot
- `vp` and a Node.js runtime managed by Vite+

### Environment

Copy `.env.example` to `.env` and fill values.

Create local Wrangler config from template (not committed):

```bash
cp wrangler.toml.example wrangler.toml
```

Then set your own Cloudflare resource IDs in `wrangler.toml`.
Also set `route` in `wrangler.toml`.

Set Worker secret:

```bash
vp run cf:secrets:sync
```

This loads `.env` automatically and syncs the selected vars as Worker secrets (`TELEGRAM_*`, `AI_PROVIDER`, `OPENCODE_API_KEY`, `GOOGLE_OAUTH_*`, `MODEL`, `BASE_URL`).

### Deploy

Route is read from `wrangler.toml`:

```bash
vp run cf:deploy
```

## Usage

- Message the bot in a private Telegram chat.
- `/help` lists commands.
- `/status` shows model/provider/memory/google/verbose status.
- `/model` lists aliases including `glm`, `workers-kimi`, `kimi`, `fireworks-kimi`, and `fireworks-minimax`.
- `/new` starts a fresh session and keeps thread settings.
- `/reset` clears conversation context and restores chat defaults.
- `/factory-reset` clears conversation, memory, runtime state, and workspace files.
- `/stop` cooperatively stops the current run.
- `/verbose on|off` toggles tool traces, including codemode code, writes, and result summaries.
- `/thinking on|off` controls model thinking effort for the chat.
- `/reasoning on|off` toggles visible reasoning text when available.
- `/google connect` starts Google OAuth linking flow.
- `/google status` shows current Google link status and scopes.
- `/google disconnect` removes stored Google OAuth token.

Normal text messages stream a single assistant reply per turn.

## Testing

- Testing policy lives in [`docs/testing.md`](docs/testing.md).
- Requirement tests are promoted intentionally under `test/requirements/...`.
- Automated tests are split between `test/requirements/...` and `test/supporting/...`.
- Run full tests: `vp test`
- Run supporting tests only: `vp run test:supporting`
- Run requirement tests only: `vp run test:requirements`
- Check format, lint, and types: `vp check`
- Run live model smoke test (real OpenCode Go + tool loop): `vp run smoke:live -- --prompt "hey"`
- Run Telegram live test via GramJS: `vp run live:telegram -- --prompt "hey"`
- Run pre-deploy gate: `vp run cf:verify:predeploy`

### Telegram live harness

- Uses a real Telegram user account via GramJS, not Telegram Web.
- Add local-only env vars: `TELEGRAM_TEST_API_ID`, `TELEGRAM_TEST_API_HASH`, `TELEGRAM_TEST_BOT_USERNAME`, `TELEGRAM_TEST_SESSION`.
- Get `TELEGRAM_TEST_API_ID` and `TELEGRAM_TEST_API_HASH` from `https://my.telegram.org/apps`.
- First-time login: `vp run live:telegram -- --login` and save the printed session string into `.env` as `TELEGRAM_TEST_SESSION`.
- Keep these values local only; do not sync them as Worker secrets.

## Persistence model

- Conversation history and bot state live in Chat SDK thread state backed by D1.
- Long-term memory facts/episodes live in D1 + Vectorize (`VECTORIZE_MEMORY`) with Workers AI embeddings (`env.AI`).
- Memory writes are salience-gated and consolidated through reflection.
- `codemode` runs JavaScript in a sandboxed dynamic Worker powered by `@cloudflare/codemode`.
- Filesystem and workspace state are provided by `@cloudflare/shell` via `state.*`.
- `codemode` exposes `state.*`, `web.fetch`, `memory.find/save/remove`, `google.execute`, `reminders.query/update`, and `skills.list/load`.
- Built-in skills live under `/skills/system/*`; user skills live under `/skills/user/*`.
- Workspace writes are durable and traced through the state backend.

### Google OAuth setup

- Configure Google OAuth app as **Web application** in Google Cloud Console.
- Add redirect URI: `https://<worker-host>/google/oauth/callback`.
- Set `GOOGLE_OAUTH_*` values in `.env` and sync secrets.
- Recommended full-access scope set for this project: Gmail (`https://mail.google.com/`), Sheets (`https://www.googleapis.com/auth/spreadsheets`), Docs (`https://www.googleapis.com/auth/documents`), Calendar (`https://www.googleapis.com/auth/calendar`), Drive (`https://www.googleapis.com/auth/drive`).
- In Telegram, run `/google connect`, open link, approve scopes.

### Google codemode examples

```js
const messages = await google.execute({
  service: "gmail",
  version: "v1",
  method: "users.messages.list",
  params: { userId: "me", maxResults: 5, q: "is:unread" },
});
messages;
```

```js
await google.execute({
  service: "sheets",
  version: "v4",
  method: "spreadsheets.values.update",
  params: {
    spreadsheetId: input.sheetId,
    range: "Sheet1!A1:B2",
    valueInputOption: "RAW",
  },
  body: {
    values: [
      ["name", "value"],
      ["demo", "1"],
    ],
  },
});
```

## Auth model

- `OPENCODE_API_KEY` is stored as Worker secret.
- `/status` reports readiness only (no secrets).

## Security

See `docs/security.md`.

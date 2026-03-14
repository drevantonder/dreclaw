# Security

v0 security model is intentionally simple and single-user.

- Accept only Telegram webhook requests with a valid webhook secret.
- Accept only private chat messages.
- Accept only one user: `TELEGRAM_ALLOWED_USER_ID`.
- Ignore all other events/users.
- Keep a single public endpoint for Telegram ingress.

## Cloudflare edge controls

- WAF custom rule: block any non-`POST` request to `/telegram/webhook`.
- Rate limiting rule: apply limits only to `POST /telegram/webhook` to reduce abuse/retry storms with minimal UX impact.
- Rules are intentionally scoped to webhook ingress only; no broad site-wide challenge/captcha policy.

## Secret boundaries

- Provider auth credentials are stored as Worker secrets.
- Auth data must never be persisted to memory facts/episodes.
- `/status` and logs must not expose secrets or tokens.

## Runtime boundaries

- No Sandbox/container dependency in v0.
- Tool execution is constrained to `execute` and `bash`; memory persistence is runtime-managed.
- `execute` runs in a sandboxed dynamic Worker with parent-mediated host APIs.
- `execute` filesystem (`fs.read/write/list/remove`) is path-normalized, traversal-blocked, and bounded by VFS limits.
- Child execute Workers have outbound network disabled and reach the network only through the parent `fetch` proxy.
- Google API access in `execute` is gated by stored OAuth refresh token + configured allowed services.
- Refresh token is encrypted at rest in D1 with `GOOGLE_OAUTH_ENCRYPTION_KEY`.

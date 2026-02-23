# Security

v0 security model is intentionally simple and single-user.

- Accept only Telegram webhook requests with a valid webhook secret.
- Accept only private chat messages.
- Accept only one user: `TELEGRAM_ALLOWED_USER_ID`.
- Ignore all other events/users.
- Keep a single public endpoint for Telegram ingress.

## Secret boundaries

- Provider auth credentials are stored in KV as a provider auth map.
- Auth data is never stored in user memory/script filesystem paths.
- `/status` and logs must not expose secrets or tokens.

## Runtime boundaries

- No Sandbox/container dependency in v0.
- Tool execution is constrained to Worker-native tool surface.
- Files/memory/scripts persist in R2; auth persists separately in KV.

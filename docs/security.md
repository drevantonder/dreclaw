# Security

v0 security model is intentionally simple and single-user.

- Accept only Telegram webhook requests with a valid webhook secret.
- Accept only private chat messages.
- Accept only one user: `TELEGRAM_ALLOWED_USER_ID`.
- Ignore all other events/users.
- Keep a single public endpoint for Telegram ingress.

## Secret boundaries

- Provider auth credentials are stored as Worker secrets.
- Auth data must never be placed in `injected_messages`.
- `/status` and logs must not expose secrets or tokens.

## Runtime boundaries

- No Sandbox/container dependency in v0.
- Tool execution is constrained to `injected_messages.get`, `injected_messages.set`, and `injected_messages.delete`.
- Only messages between runtime markers are editable via injected message management tools.

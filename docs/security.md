# Security

v0 security model is intentionally simple.

- Accept only Telegram webhook requests with a valid webhook secret.
- Accept only private chat messages.
- Accept only one user: `TELEGRAM_ALLOWED_USER_ID`.
- Ignore all other events/users.
- Keep a single public endpoint for Telegram ingress.

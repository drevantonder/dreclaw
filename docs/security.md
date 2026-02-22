# Security

v0 security model is intentionally simple.

- Accept only Discord webhook requests with valid Discord signature verification.
- Accept only DMs.
- Accept only one user: `DISCORD_ALLOWED_USER_ID`.
- Ignore all other events/users.
- Keep a single public endpoint for Discord ingress.

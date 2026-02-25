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
- Auth data must never be placed in `custom_context`.
- `/status` and logs must not expose secrets or tokens.

## Runtime boundaries

- No Sandbox/container dependency in v0.
- Tool execution is constrained to `custom_context_get`, `custom_context_set`, and `custom_context_delete`.
- Only stored custom context entries are editable via custom context management tools.

## Dependency posture

- `pnpm.overrides.minimatch` is pinned to `^10.2.1` in `package.json` to remediate `GHSA-3ppc-4f35-3m26` (ReDoS in older minimatch versions).
- This override exists because minimatch is brought transitively by runtime/tooling dependencies, and we want audit-clean deploys while dependency trees converge.

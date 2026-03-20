# Tool Requirements

These tests define the promoted direct tool contract for dréclaw.

Current promoted coverage:

- direct `codemode` availability
- core `state.*` integration through `codemode`
- `web.fetch`
- `google.execute`
- `reminders.query` and `reminders.update`
- `skills.list` and `skills.load`

Explicitly not promoted yet:

- `memory.*`
- broad `@cloudflare/shell` parity
- transport or executor implementation details
- low-level provider wiring details

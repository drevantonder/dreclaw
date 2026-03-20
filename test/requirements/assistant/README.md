# Assistant Requirements

These tests define the promoted product contract for plain assistant chat usage.

Current promoted coverage:

- single-turn text chat only
- semantic final reply behavior
- incremental visible output before completion
- visible reasoning on/off behavior
- multi-turn continuity across plain text chat
- visible continuity boundaries after `/new`, `/reset`, and `/factory-reset`

Explicitly not promoted yet:

- codemode and other tool use
- memory behavior
- proactive reminder wakes
- image input
- transport-method details
- model/provider wiring details

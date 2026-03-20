# Assistant Requirements

These tests define the promoted product contract for plain assistant chat usage.

Current promoted coverage:

- semantic final reply behavior for plain chat
- incremental visible output before completion
- visible reasoning on/off behavior
- multi-turn continuity across plain text chat
- visible continuity boundaries after `/new`, `/reset`, and `/factory-reset`
- tool use during normal assistant chat
- light verbose trace visibility during tool-backed runs
- image-thread continuity and image-thread tool use

Explicitly not promoted yet:

- memory behavior
- proactive reminder wakes
- transport-method details
- low-level provider wiring details

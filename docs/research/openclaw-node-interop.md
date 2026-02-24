## 1) Executive conclusion (≤10 bullets)

* **OpenClaw node interop is feasible** if dréclaw implements **Gateway Protocol v3** (WebSocket frames + `connect.challenge` + signed device identity) and the **node transport trio**: `node.invoke.request` (server→node), `node.invoke.result` + `node.event` (node→server). ([OpenClaw][1])
* **Headless node host (CLI “node run”) is the best v0 target**: its command surface is small (`system.run`, `system.which`, exec approvals, optional browser proxy) and uses only the node-role methods allowed by the gateway. ([GitHub][2])
* **Mobile-node compatibility is the main risk**, not the handshake: OpenClaw nodes return **base64 media** for `canvas.snapshot`/camera/screen. Cloudflare Workers WebSocket messages have a **1 MiB receive limit**, making “big base64 over WS” a likely breakage point. ([OpenClaw][3])
* **Cloudflare Durable Objects should own the WS server state** (node registry, pairing state, in-flight invocations) to avoid stateless Worker constraints and to handle WebSocket hibernation patterns correctly. ([Cloudflare Docs][4])
* **Cloudflare Sandbox SDK maps cleanly** to “gateway-side execution” (filesystem/shell/CLIs), but node-executed commands remain “remote peripherals”; treat Sandbox as the default exec host, nodes as optional. ([Cloudflare Docs][5])
* **Compatibility shim is fastest** to a usable v0 (node host + minimal operator control), but **custom apps win** once you need reliable media streaming, background execution, and Cloudflare-native upload flows.
* **Protocol stability is decent at the schema level** (TypeBox source-of-truth + explicit PROTOCOL_VERSION negotiation), but **security-driven changes have recently tightened handshake/roles**, so you must track version bumps. ([OpenClaw][1])
* **Go/no-go hinges on two experiments**: (1) node host can pair/connect/reconnect to a Cloudflare DO gateway using v3 device identity; (2) node media commands can stay <1 MiB or be shifted to URL-based transfer without modifying OpenClaw apps.

---

## 2) Compatibility matrix

| Feature                                                                                |                  Needed for v0? | Implement via | Complexity | Risk                                     |
| -------------------------------------------------------------------------------------- | ------------------------------: | ------------- | ---------- | ---------------------------------------- |
| WS framing (`req/res/event`) + `hello-ok` snapshot/policy                              |                               Y | Shim          | Med        | Low                                      |
| `connect.challenge` + signed device identity fields                                    |                               Y | Shim          | High       | Med (crypto + clock skew)                |
| Gateway auth (`connect.params.auth.token/password`)                                    |                               Y | Shim          | Low        | Low                                      |
| Role enforcement: node can call only `node.invoke.result`, `node.event`, `skills.bins` |                               Y | Shim          | Med        | Med (strict compatibility) ([GitHub][6]) |
| Node registry + `node.list`/`node.describe`                                            |                               Y | Shim          | Med        | Low                                      |
| `node.invoke` (operator→gateway) → `event: node.invoke.request` (gateway→node)         |                               Y | Shim          | Med        | Low                                      |
| `node.invoke.result` handling (node→gateway)                                           |                               Y | Shim          | Med        | Low                                      |
| `skills.bins` (node helper)                                                            |                     Y (stub ok) | Shim          | Low        | Low                                      |
| Device pairing approval flows (`device.pair.*`, events)                                | N (if auto-approve single user) | Shim          | High       | Med                                      |
| Gateway-owned node pairing (`node.pair.*`)                                             |                          N (v0) | Shim          | Med        | Low                                      |
| Node-host commands: `system.run` output shape                                          |                               Y | Shim          | Low        | Low ([GitHub][7])                        |
| Node-host commands: `system.which` output shape                                        |                               Y | Shim          | Low        | Low ([GitHub][7])                        |
| Exec approvals management (`system.execApprovals.*`)                                   |                          N (v0) | Shim          | Med        | Low                                      |
| Canvas host + node-scoped capability URLs                                              |                          N (v0) | Custom later  | High       | Med                                      |
| Mobile media (camera/screen/canvas snapshot base64)                                    |                          N (v0) | Custom        | High       | **High** (WS 1 MiB) ([OpenClaw][3])      |
| Durable Object WebSocket hibernation + state restore                                   |                               Y | Shim          | Med        | Med ([Cloudflare Docs][4])               |
| Sandbox execution (filesystem/shell/CLIs)                                              |                     Optional v0 | Shim          | Med        | Low ([Cloudflare Docs][5])               |

---

## 3) Minimum Protocol Contract (v0 interop)

### 3.1 Frames (wire format)

* Request: `{ "type":"req", "id":string, "method":string, "params"?:any }`
* Response: `{ "type":"res", "id":string, "ok":boolean, "payload"?:any, "error"?:{code,message,...} }`
* Event: `{ "type":"event", "event":string, "payload"?:any, "seq"?:number, "stateVersion"?:... }` ([GitHub][8])

### 3.2 Handshake

**Server → client (pre-connect):**

```json
{ "type":"event", "event":"connect.challenge", "payload": { "nonce":"...", "ts": 1737264000000 } }
```

**Client → server (first frame must be `connect`):** required fields for v0 node host interop:

```json
{
  "type":"req",
  "id":"...",
  "method":"connect",
  "params":{
    "minProtocol":3,
    "maxProtocol":3,
    "client":{ "id":"...", "version":"...", "platform":"...", "mode":"node", "displayName?":"...", "instanceId?":"..." },
    "role":"node",
    "scopes":[],
    "caps":["system", "..."],
    "commands":["system.run","system.which","..."],
    "permissions":{},
    "pathEnv?":"...",
    "auth":{ "token?":"...", "password?":"..." },
    "locale?":"en-US",
    "userAgent?":"...",
    "device":{
      "id":"device_fingerprint",
      "publicKey":"...",
      "signature":"...",
      "signedAt":1737264000000,
      "nonce":"<must match connect.challenge payload.nonce>"
    }
  }
}
```

* The schema-level field set above is the direct contract. ([OpenClaw][1])

**Server → client (handshake success):**

* Must respond with `payload.type = "hello-ok"` and `protocol=3`, plus `policy.tickIntervalMs` at minimum. ([OpenClaw][1])

### 3.3 Node invocation transport (the “node surface”)

**Gateway → node:**

* Emit an event **named exactly** `node.invoke.request` with payload:

```json
{
  "id":"<requestId>",
  "nodeId":"<target nodeId>",
  "command":"system.run|system.which|...",
  "paramsJSON":"{...}" ,
  "timeoutMs":30000,
  "idempotencyKey":"<optional>"
}
```

This is how OpenClaw’s node registry sends invocations. ([GitHub][9])

**Node → gateway (result):**

* Node sends a **request** with `method:"node.invoke.result"` and params:

```json
{
  "id":"<same requestId>",
  "nodeId":"<same nodeId>",
  "ok":true,
  "payloadJSON":"{...}",
  "error?":{ "code?":"...", "message?":"..." }
}
```

Exact param fields are in the protocol schema. ([GitHub][10])

**Node → gateway (events):**

* Node may send `method:"node.event"` with params:

```json
{ "event":"exec.finished|exec.denied|...", "payloadJSON":"{...}" }
```

(Used by the node host to surface exec lifecycle as best-effort.) ([GitHub][10])

**Node → gateway (helper):**

* Node host will call `skills.bins` periodically (can return `{ bins: [] }` in v0). ([GitHub][2])

### 3.4 Required `system.*` semantics (for headless node host)

From the OpenClaw node-host implementation:

* `system.which` expects params `{ "bins":[ "git", "node", ... ] }` and returns `{ "bins": { "git":"/usr/bin/git", ... } }`. ([GitHub][7])
* `system.run` returns JSON with: `exitCode`, `timedOut`, `success`, `stdout`, `stderr`, `error` (nullable). ([GitHub][7])
* Approvals/allowlist are enforced locally on the node host; denial returns an error like `"SYSTEM_RUN_DENIED: approval required"` and may emit `exec.denied`. ([GitHub][7])

---

## 4) Architecture recommendation diagram (text)

```
            (OpenClaw Node Host)                         (Operator UI / CLI)
                 role=node                                     role=operator
                      │                                              │
                      │  WS (protocol v3)                            │ WS (protocol v3)
                      ├──────────────┐                       ┌───────┤
                                     │                       │
                              Cloudflare Worker (WS upgrade + routing)
                                     │
                                     ▼
                         Durable Object: dréclaw-gateway
                    - validates connect.challenge + device signature
                    - stores pairing + device tokens (single-user)
                    - node registry (nodeId -> ws session)
                    - routes node.invoke -> event:node.invoke.request
                    - accepts node.invoke.result + node.event
                    - emits tick/presence as needed
                                     │
                 ┌───────────────────┴───────────────────┐
                 │                                       │
                 ▼                                       ▼
      Cloudflare Sandbox SDK (default exec)         R2/Blob store (optional)
   - exec/stream/terminal/files/processes      - only if you redesign media transfer
```

Key mapping:

* “Control plane” state lives in **Durable Object** (not stateless Workers). ([Cloudflare Docs][4])
* “Execution” lives in **Sandbox** when not delegated to a node. ([Cloudflare Docs][5])

---

## 5) Time estimate (compat shim vs custom apps)

### Compatibility shim (target: headless node host v0)

* **Optimistic:** 5–7 days
* **Realistic:** 2–3 weeks
* **Pessimistic:** 4–6 weeks
  Main drivers: device-identity signature verification, DO WebSocket lifecycle/hibernation, and getting reconnect/pairing right. ([OpenClaw][1])

### Custom macOS + iOS node apps (Cloudflare-native protocols, URL-based media)

* **Optimistic:** 4–6 weeks
* **Realistic:** 8–12 weeks
* **Pessimistic:** 16+ weeks
  Main drivers: app UX, background execution permissions, secure upload flows, distribution, and ongoing OS permission churn.

---

## 6) Key unknowns + validation plan (run these this week)

1. **Can an unmodified OpenClaw node host connect to a Cloudflare-hosted gateway?**

   * Build a minimal DO WS server that: emits `connect.challenge`, accepts `connect`, returns `hello-ok`.
   * Confirm the node host’s `role=node` connect includes commands `system.run/system.which/...` and that you can register it. ([GitHub][2])

2. **Roundtrip invocation correctness**

   * From an operator client, call `node.invoke` and verify your DO emits `event:"node.invoke.request"` and receives `node.invoke.result` for:

     * `system.which` with 3–5 bins
     * `system.run` with `["/usr/bin/uname","-a"]` (or platform equivalent)
   * Verify result shape matches the node-host implementation (`stdout/stderr/exitCode/...`). ([GitHub][9])

3. **Reconnect + hibernation**

   * Keep the node idle long enough to trigger DO hibernation patterns, then invoke again; ensure you restore/track sessions correctly (attachments or storage). ([Cloudflare Docs][4])

4. **Message size failure mode (critical for mobile later)**

   * Simulate a `node.invoke.result` payload with ~1.2 MiB JSON/base64 and confirm the Worker closes at 1009; this validates the constraint early. ([Cloudflare Docs][11])

5. **Pairing model decision**

   * Implement “single-user auto-approve” first; then add `device.pair.*` later if needed. OpenClaw’s protocol explicitly supports pairing-required vs auto-approval modes. ([OpenClaw][1])

---

## 7) Final recommendation: compat first vs custom first

**Recommendation: compat first (narrow target), then custom for mobile.**

Rationale:

* The **headless node host is already open-source and minimal** (`system.run`, `system.which`, approvals) and speaks the exact node-role surface you can realistically implement in a Cloudflare DO quickly. ([GitHub][2])
* **Mobile-node compatibility is likely to break on Cloudflare’s 1 MiB WS message limit** due to base64 media returns; solving that cleanly usually requires **protocol changes or custom apps** that upload to object storage and return URLs. ([OpenClaw][3])
* Therefore:

  * **v0:** OpenClaw headless node host compatibility + minimal operator tooling.
  * **v1:** Add Sandbox-first execution + tool routing; nodes become “optional peripherals.”
  * **v2:** Build custom iOS/macOS apps (or fork OpenClaw nodes) with Cloudflare-native media transfer and background constraints handled deliberately.

**Go/no-go criteria (end of week):**

* ✅ Node host connects, stays connected, and survives reconnect/hibernation. ([Cloudflare Docs][4])
* ✅ `node.invoke` roundtrips for `system.which` + `system.run` with correct result JSON. ([GitHub][9])
* ❌ If you cannot implement device-identity signing compatibly (or it’s too brittle across platforms), abandon OpenClaw-compat and go custom immediately. ([OpenClaw][1])

[1]: https://docs.openclaw.ai/gateway/protocol "Gateway Protocol - OpenClaw"
[2]: https://raw.githubusercontent.com/openclaw/openclaw/main/src/node-host/runner.ts "raw.githubusercontent.com"
[3]: https://docs.openclaw.ai/platforms/android?utm_source=chatgpt.com "Android App - OpenClaw Docs"
[4]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/?utm_source=chatgpt.com "Use WebSockets · Cloudflare Durable Objects docs"
[5]: https://developers.cloudflare.com/sandbox/ "Overview · Cloudflare Sandbox SDK docs"
[6]: https://raw.githubusercontent.com/openclaw/openclaw/main/src/gateway/method-scopes.ts "raw.githubusercontent.com"
[7]: https://raw.githubusercontent.com/openclaw/openclaw/main/src/node-host/invoke.ts "raw.githubusercontent.com"
[8]: https://raw.githubusercontent.com/openclaw/openclaw/main/src/gateway/protocol/schema/frames.ts "raw.githubusercontent.com"
[9]: https://raw.githubusercontent.com/openclaw/openclaw/main/src/gateway/node-registry.ts "raw.githubusercontent.com"
[10]: https://raw.githubusercontent.com/openclaw/openclaw/main/src/gateway/protocol/schema/nodes.ts "raw.githubusercontent.com"
[11]: https://developers.cloudflare.com/workers/runtime-apis/websockets/?utm_source=chatgpt.com "WebSockets · Cloudflare Workers docs"

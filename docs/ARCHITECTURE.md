# Architecture

`dsh-computer-use` is a DSH plugin that exposes real desktop input to an agent behind a deterministic observation-and-safety layer. This document describes the layers, the contracts between them, and the state machine that makes an action safe to dispatch.

- Tool layer: [`index.js`](../index.js)
- Backend selection: [`backends/index.mjs`](../backends/index.mjs)
- Linux backend: [`backends/linux-x11.mjs`](../backends/linux-x11.mjs) + [`backends/linux-adapter.mjs`](../backends/linux-adapter.mjs)
- Windows backend: [`backends/win32.mjs`](../backends/win32.mjs) + the PowerShell/C# scripts in [`index.js`](../index.js)
- Client: [`client.js`](../client.js) → generated [`client.web.js`](../client.web.js)
- Backend contract and invariants: [`backends/CONTRACT.md`](../backends/CONTRACT.md) (Chinese)

## Goals and non-goals

**Goals**

- Give a model two small, predictable tools: observe one monitor, then perform one input action under the observation.
- Make unsafe dispatch hard by construction: a single-use token, a pre-dispatch re-proof of the observed state, explicit intent/risk grading, host approval for graded-high-risk actions, an audit trail and a physical pause.
- Stay dependency-free: Node built-ins only, native OS primitives per platform, no OCR, no cloud vision, no npm runtime packages.
- Fail closed when the session cannot be driven safely (Wayland, missing `DISPLAY`, unsupported platform, unreadable foreground window, unknown target window).

**Non-goals**

- Screenshot understanding, element grounding, OCR or app-specific automation.
- A general workflow/agent framework; the model decides the plan.
- A sandbox. The plugin can drive anything the user can drive (minus the DSH window guard).

## Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│ DSH host                                                              │
│  tools seam · connection.fetch routes · approval seam · pluginManager │
│  slots/locale (client) · capability-toggles.json                      │
└───────────────▲───────────────────────────────────────────────▲───────┘
                │ ctx.tools.register(tool, { when })             │ client
┌───────────────┴───────────────────────────────┐   ┌───────────┴───────┐
│ Tool layer — index.js                         │   │ client.js         │
│  computer_screenshot · computer               │   │  Desktop view     │
│  observation tokens · intent/risk/approval    │   │  tool cards       │
│  audit · pause · capability gate · routes     │   │  per-session      │
│  provider-slot coexistence                    │   │  switch           │
└───────┬───────────────────────────────┬───────┘   └───────────────────┘
        │ Windows path                  │ Linux path (kind = linux-x11)
┌───────▼──────────────────┐   ┌────────▼──────────────────────────────┐
│ index.js Windows scripts │   │ backends/linux-adapter.mjs            │
│  actionScript / sequence │   │  capture · validate · prove · guard · │
│  brakeScript / inputCheck│   │  dispatch · inputCheck                │
│        +                 │   └────────┬──────────────────────────────┘
│ backends/win32.mjs       │            │
│  C# P/Invoke + PS staging│   ┌────────▼──────────────────────────────┐
│  monitors · capture      │   │ backends/linux-x11.mjs                │
└──────────────────────────┘   │  xdotool · scrot/import/xwd · xprop · │
                               │  xwininfo · xrandr · PNG codec        │
                               └───────────────────────────────────────┘
```

### Tool layer (`index.js`)

Owns everything platform-agnostic:

- Registers the two model-facing tools with an opt-in `when` predicate.
- `computer_screenshot`: resolves the monitor selection, calls the platform capture path, stores the observation token and returns the public result.
- `computer`: validates flow/action arguments, resolves and reserves the token, checks intent/risk/approval, applies the DSH-window guard, then dispatches one action (or a sequence) and appends the audit entry.
- Observation store: `Map<token, record>` plus `latestObservationBySession`, both process-local and bounded (200 records).
- Risk policy: built-in regexes plus optional `policy.json` overrides.
- Audit, pause, status/capability/shot routes, provider-slot coexistence.
- Windows dispatch scripts: the PowerShell action/sequence/brake/self-check scripts still live in `index.js`; [`backends/win32.mjs`](../backends/win32.mjs) owns the C# `SendInput` source, the PowerShell preamble/staging, monitor enumeration and capture. `CONTRACT.md` tracks the remaining extraction.

### Backend selection (`backends/index.mjs`)

Selection is performed once at import time from `process.platform` and Linux session environment variables:

| Condition | Backend | Supported |
|---|---|---|
| `process.platform === "win32"` | `windows-native` | yes |
| Linux, `DISPLAY` set, `XDG_SESSION_TYPE` not `wayland` | `linux-x11` | yes |
| Linux, `XDG_SESSION_TYPE === "wayland"` | `wayland-unsupported` / `x11-display-missing` | no — structured refusal, including the XWayland-only case |
| Everything else | `unsupported-<platform>` | no |

Failing closed here is deliberate: it prevents every tool call from surfacing an opaque `scrot`/`xrandr` error.

### Linux backend

- [`backends/linux-x11.mjs`](../backends/linux-x11.mjs) — dependency-free primitives: monitor parsing/enrichment (`xrandr --listmonitors` + `--query`), screen picking, one-monitor capture (including negative-origin layouts), PNG decode/encode/crop/scale (`node:zlib`), fingerprint sampling, foreground/target window facts, lock probing, pointer and input dispatch (`xdotool`), key-token resolution, and the environment self-check.
- [`backends/linux-adapter.mjs`](../backends/linux-adapter.mjs) — the glue to the tool layer:
  - `capture()` — one monitor → the observation shape the tool layer mints a token from.
  - `validate()` — pure argument validation (same rules as the Windows plan builder), including monitor-bounds rejection, keyboard aliases and sequence limits.
  - `prove()` — re-enumerate the layout, re-read the foreground window (handle + bounds) and re-sample the fingerprint immediately before dispatch; returns `stale_observation` / `foreground_unreadable` / `observation_unverifiable` on mismatch.
  - `guard()` — target-level DSH checks: keyboard actions are refused when DSH is focused; pointer actions are refused only when their own target lands on a DSH window. Anonymous target windows fail closed (`window_unidentified`, `window_probe_failed`).
  - `dispatch()` — re-check pause, check lock state, re-check monitor bounds, run guards, then inject exactly one action; release mouse buttons on failure paths.
  - `inputCheck()` — map the backend self-check onto the shared `computer` result shape.
- Optional helpers: [`backends/x11-hotkey.py`](../backends/x11-hotkey.py) (python3-Xlib global brake hotkey) and [`backends/clipboard.py`](../backends/clipboard.py) (GTK 3 clipboard owner used by `type`).

### Windows backend

- [`backends/win32.mjs`](../backends/win32.mjs): in-memory C# P/Invoke source (`SendInput`, foreground window, DPI awareness, `DesktopLocked`, integrity level, probe), the PowerShell preamble, helper staging under `%LOCALAPPDATA%\dsh-computer-use\helper`, PowerShell execution (`-File` on a staged `.ps1`), monitor enumeration via WinForms `Screen.AllScreens`, and single-monitor / `"all"` / `region` / `scale` capture.
- `index.js`: action/sequence script builders, dispatch guards, desktop-lock and pause checks, the emergency-hotkey watcher script and the Windows `inputcheck` script. The helper is one short-lived PowerShell process per dispatch, returning JSON.

### Client layer

[`client.js`](../client.js) is the ESM authoring source; the DSH Web module loader does not execute ESM, so [`scripts/build-client.mjs`](../scripts/build-client.mjs) mechanically wraps it into [`client.web.js`](../client.web.js) (a classic script that calls `window.__ModuleLoader__.load({ id, factory })`). The generated file is committed and regenerated by `npm run build:client` / `prepack`.

The client contributes:

- a `conversation.view` tab with id `computer-use`, order 20, localized label `Desktop` / `桌面`;
- the per-conversation switch at the top of that tab (reads/writes `/api/computer-use/capability`);
- `tool.call.toolview` cards for `computer_screenshot`, `computer`, and the legacy `computer_input` records;
- pause/emergency-brake/audit status from `/api/computer-use/status`;
- screenshot images fetched through `/api/computer-use/shot`;
- locale dictionaries under the `computerUse` namespace (English and Chinese), mirrored in `locale/en.json` and `locale/zh.json` for package metadata.

### DSH integration points

| Integration | Where | Behaviour |
|---|---|---|
| Plugin face | `index.js` | `export const name = "computer-use"`, `export const inject = ["tools"]`, `export function apply(ctx)`. |
| Tool registration | `apply()` | Both tools are registered inside `ctx.effect` with `when: ({ agent }) => computerUseEnabled(agent)`. Disabling the capability removes them for the next step. |
| Bundle patch | `package.json` → `dsh.bundle.patch` = `./cordis.patch.yml` | Inserts a `computer-use` entry named `dsh-computer-use` into the profile composition. |
| Web client | `package.json` → `dsh.client` | `platform: "web"`, `immediately: true`, injects `@deepseek-ai/dsh-client-locale`. |
| Provider slot | `ctx.inject(["computerUse"])` | Optional: registers the process's single `computerUse` provider. A conflict is reported by `inputcheck`/status; the tools do not depend on the slot. |
| HTTP routes | `ctx.inject(["connection"])` | `/api/computer-use/shot` (GET/HEAD), `/api/computer-use/status` (GET/POST), `/api/computer-use/capability` (GET/POST). None is a model tool. |
| Approval | `ctx.get("approval")` | Used only for actions graded high risk; fails closed when absent or when the policy rejects. |
| Plugin manager | `ctx.get("pluginManager")` | Read-only coexistence report: enabled plugins whose module name looks like another computer-use provider. |

## Observation token lifecycle

A token is the contract between "the model has seen this desktop" and "the model may act on it".

```
computer_screenshot
        │  capture one monitor
        ▼
   token created ──────────────► superseded by a newer screenshot (observation_superseded)
        │                        expires after TTL (observation_expired)
        │                        store evicts oldest (observation_expired)
        ▼
   reserved by one input call (atomic, no await between checks)
        │
        ├── refused before dispatch (bad args / intent / risk / denial)
        │        └── released → the same state_id may be retried
        │
        └── dispatch committed ──► consumed (observation_used)
                                   └── success → a fresh token is minted
```

The record (`rememberObservation`) contains:

| Field | Meaning |
|---|---|
| `id` | `obs_` + 12 hex chars from `crypto.randomBytes(6)`. |
| `sessionId` | DSH session that owns the token; a token cannot be used from another conversation. |
| `createdAt` | TTL base. |
| `used`, `consumedBy`, `consumedAt` | Atomic reservation/consumption state. |
| `path`, `width`, `height`, `originX`, `originY` | Screenshot and geometry. |
| `foreground` | `handle`, `title`, `process`, `rect`. |
| `fingerprint` | 8×8 samples × 6 hex chars per sample (`FINGERPRINT_CELLS = 8`). |
| `fingerprintTarget` | `window`, `screen` or `none` (which pixels the token binds). |
| `screen`, `screens` | Linux monitor facts used by the coordinate contract. |

Defaults and limits (constants in `index.js`):

| Constant | Value |
|---|---|
| `OBSERVATION_TTL_MS` | 120 000 ms fallback; effective default 180 000 ms via `observationTtlMs()` (range 5 s–30 min). |
| `MAX_OBSERVATIONS` | 200 tokens per process. |
| `KEEP_SCREENSHOTS` | 60 PNG files in `$DSH_HOME/computer-use/shots/`. |
| `MAX_TYPE_LENGTH` | 4 000 characters. |
| `MAX_SEQUENCE_STEPS` | 20 steps. |
| `MAX_SEQUENCE_TEXT` | 8 000 characters across a sequence. |
| `intent` limit | 200 characters (audit keeps 120). |
| `ACTION_TIMEOUT_MS` | 45 000 ms, extended for long sequences/text. |

### Why "re-prove" exists

A screenshot can be stale in ways the model cannot see: the window moved, another window took the foreground, a page loaded, the monitor layout changed. Before dispatching, the plugin re-reads:

1. the monitor layout (Linux) and requires the same monitor id and geometry;
2. the foreground window handle and rectangle;
3. the sampled fingerprint of the window clipped to the observed monitor (on Linux, or the whole monitor when the window is off-monitor).

On Linux a fingerprint cell counts as changed when any channel differs by more than 40; more than 8 changed cells (`FINGERPRINT_TOLERANCE = 8`) makes the observation stale. A window title is deliberately **not** part of the proof because applications animate titles. On Linux, when the foreground window does not overlap the observed monitor, or is too small to sample, the token falls back to a whole-monitor fingerprint; when even that is impossible it records `fingerprintTarget: "none"` and only handle/bounds/layout are checked (a documented weakening, see `CONTRACT.md` §4). On Windows an empty fingerprint likewise leaves the handle/bounds proof.

## Intent, risk and approval flow

1. **Intent requirement.** `click`, `double_click`, `right_click`, `drag`, `type`, `key` and `sequence` require a non-empty `intent` (≤ 200 chars). Missing or over-long intents are refused before the token is consumed.
2. **Risk grading** (`riskOf`), applied to activating actions and `sequence`:
   - intent matches the built-in risky-verb regex (`send`, `submit`, `delete`, `remove`, `purchase`, `buy`, `pay`, `payment`, `transfer`, `confirm`, `password`, `credential`, `format`, `wipe`, `shutdown`, `uninstall`, `install`, `overwrite`, `approve`, plus Chinese equivalents);
   - a sequence step's intent matches the same verbs;
   - `key` uses a system-level chord (`Alt+F4`, `Ctrl+Alt+Del`, `Win+R`);
   - the observed foreground surface (process + title) matches the risky-app regex (banking, payment, wallet, brokerage, mail clients, plus Chinese equivalents).
3. **Confirmation.** A high-risk action without `confirm_risk: true` is refused with `risk_approval_required`. Nothing has been dispatched and the token is released for a retry.
4. **Approval.** With `confirm_risk: true`, the action calls `ctx.get("approval")`. If the service is not mounted or the request throws, the action fails closed (`risk_unavailable`). Only the outcome `allowed-once` proceeds; `rejected`, `cancelled`, or no answerer fails with `risk_denied`. If the session's effective policy is `never`, the refusal explains that the policy must be changed or the user must act manually.
5. **Customisation.** `$DSH_HOME/computer-use/policy.json` can extend or replace the lists:

```json
{
  "observationTtlMs": 180000,
  "riskyIntent": ["deploy to production", "rotate keys"],
  "riskyIntentReplace": ["my-company-specific-verb"],
  "riskyApp": ["intranet-admin"],
  "riskyAppReplace": ["my-sensitive-app"]
}
```

A non-empty `*Replace` array replaces the built-in list; the non-`Replace` array appends to it. Invalid regex strings are ignored.

Risk grading is a heuristic, not a security boundary. The approval seam, the per-session switch and the audit trail are the controls that matter; see [SECURITY.md](SECURITY.md).

## DSH-window protection

The DSH window hosts install, capability and authorization controls, so automated input into it is blocked (`dsh_window_blocked`):

- **Windows**: every activating action and `sequence` is refused when DSH owns the foreground; click/drag/scroll additionally check the target point with `PointHitsDsh`/`DshWindowAtCursor` immediately before dispatch.
- **Linux**: target-level. `type`/`key` are refused when DSH is the foreground window (the input would go to it); `click`/`double_click`/`right_click`/`drag`/`scroll` warp to the target first and refuse only if the window under that point is DSH. A window whose identity cannot be read fails closed (`window_unidentified`). `move` is unrestricted.

The observed foreground is checked at the tool layer; the guards run again immediately before injection, because the foreground or the target can change in between.

## Audit, pause and capability

### Audit

`appendAudit()` writes one JSON line per attempt to `$DSH_HOME/computer-use/audit.jsonl`:

```json
{"at":"…","sessionId":"…","callId":"…","action":"click","intent":"…","risk":"low","ok":true,"code":null,"x":420,"y":260,"toX":null,"toY":null,"keys":null,"textLength":null,"steps":null}
```

- Every path that reaches `performComputer` appends an entry, including refusals and `inputcheck`/`pause`.
- Typed text is never recorded — only `textLength`. Key chords are truncated to 80 characters.
- Audit failures are swallowed: the trail must never fail a dispatch.
- `auditStats()` reads the tail (up to 4 MiB) for the status route's action/refusal counts; `lastActionRecord` is the latest in-process entry.

### Pause (physical brake)

- The **presence of the pause file** is the single source of truth (`$DSH_HOME/computer-use/pause.json`).
- The model can create it with `computer { action: "pause" }` (idempotent: an existing pause keeps its original reason/timestamp).
- The model cannot clear it. Only the user's UI action (`POST /api/computer-use/status` with `{"action":"resume"}`) removes the file.
- The pause is checked at the tool layer (before token resolution), at the backend injection point (covers an approval prompt or proof window while the user presses pause), and between `sequence` steps. `inputcheck` does not even warp the pointer while paused.
- Windows always runs a hidden PowerShell hotkey watcher; X11 starts `backends/x11-hotkey.py` when `python3` + `Xlib` are available. Both use `Ctrl+Alt+Shift+Q` with `Ctrl+Alt+Shift+F12` as fallback and write the pause file. If the X11 watcher cannot start, the plugin degrades to UI-only pause and reports the reason in `inputcheck`/status (`brake.json`).
- Hotkey candidates deliberately avoid `Ctrl+Alt+F1..F12`: those are X.org VT-switch bindings and would black the display if ungrabbed.

### Per-session capability

Two independent surfaces write the same store:

- the tools' `when` predicate (`computerUseEnabled(agent)`), and
- the Desktop view switch (`GET`/`POST /api/computer-use/capability`).

The store is `~/.dsh/capability-toggles.json`:

```json
{ "version": 1, "sessions": { "<sessionId>": { "computerUse": true } } }
```

The store is shared with the MCP/skill manager, so this plugin only ever touches `sessions.<id>.computerUse` and `sessions.<id>.computerUseAdvanced`, preserves every other key/session/flag, writes atomically (tmp + rename) and treats an unreadable or unknown record as **off**. Computer use is opt-in.

## Concurrency and ordering

- Token reservation and consumption are atomic in the JavaScript sense: there is no `await` between the final checks and setting `used = true`, so two parallel tool calls in one step cannot both hold the same token.
- On Linux, every pointer-injecting operation (`dispatch`, `inputcheck`) goes through a pointer queue so a probe and an action cannot fight over the cursor.
- `sequence` steps are ordered and pause-checked between steps; on Linux each step is also re-proven before it is injected. A blocked or stale step stops the batch and reports `steps` already executed plus `blockedStep`.
- `wait` needs no token; its follow-up screenshot keeps the conversation's newest monitor on Linux instead of silently switching to the primary monitor.

## Failure handling

- All model-facing refusals are structured: `{ ok: false, action, code, message, guidance }` with extra context (`foreground`, `risk`, `steps`, `blockedStep`, `paused`). Guidance always names the next step.
- The token is released only when nothing was dispatched; once dispatch is committed, a backend refusal (pause/lock/stale) consumes the token because the attempt itself happened.
- Linux failure paths release mouse buttons (`mouseup 1/2/3`); drags read back the final pointer position and report `drag_unstable` instead of claiming success; pointer warps read back the position and refuse `pointer_warp_unstable` after retries.
- The Windows `inputcheck` reports helper staging, integrity level, locked desktop, dispatch confirmation, pointer drift, pause state and brake status; Linux `inputcheck` reports session type, tool matrix/install hints, monitor layout/DPI, Python helpers, screenshot method, pointer warp, clipboard helper, lock state and the brake.

## Related documents

- [PLATFORMS.md](PLATFORMS.md) — platform-specific behaviour and requirements.
- [SECURITY.md](SECURITY.md) — threat model and boundaries.
- [TESTING.md](TESTING.md) — how each layer is tested, including the real-X11 integration suite.
- [DEVELOPMENT.md](DEVELOPMENT.md) — local development and release process.
- [`backends/CONTRACT.md`](../backends/CONTRACT.md) — the frozen coordinate/observation contract and backend invariants (Chinese).

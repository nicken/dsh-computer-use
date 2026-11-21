# Tool surface: two switches for one capability

Status: **proposal** (2026-11-21). The plugin currently registers both tools under the single
`computerUse` switch.

## The problem

The capability panel shows one switch per registered tool. For this plugin that means two
capabilities:

- `computer_screenshot` — observe the desktop (PNG + monitor list + one-shot `state_id`)
- `computer` — perform one real input action against that observation

A user starting a session sees two toggles and has to know that they are two halves of one flow.
There is no useful configuration that enables only one of them: screenshots without input are
observation-only, input without screenshots is impossible (the token comes from a screenshot).
The real decision is only "may the agent control this desktop in this session?".

## Options

### Option A — one `computer` tool by default, screenshot folded in (**recommended**)

- `computer({ action: "screenshot", screen?, region?, scale? })` returns exactly what
  `computer_screenshot` returns today (path, geometry, cursor, foreground window, `state_id`).
- Every other action (`move`, `click`, `type`, `key`, `wait`, `sequence`, `inputcheck`, `pause`)
  behaves as today.
- Panel shows **1** capability. The model sees one object and one observation token flow.
- An opt-in `computerUseAdvanced` switch re-registers the present split (`computer` +
  `computer_screenshot`) for scripts that depend on the old names.

Trade-offs:

- The `computer` schema grows by three optional fields. They are ignored unless
  `action: "screenshot"`, which the description states explicitly.
- The client tool card must render screenshots from the `computer` card; the card already renders
  from `presentationMeta`, so this is a small change.
- Old tool name `computer_screenshot` is only available with the advanced switch on (documented
  migration note). The first open-source release is the cheapest moment for that break.

### Option B — split by risk (observe vs control)

- `computerObserve` (screenshot only) + `computerControl` (input + screenshot for tokens).
- Pros: a read-only desktop mode, useful for demos.
- Cons: still two switches; `computerControl` needs screenshots anyway, so the split is awkward —
  the "safe" switch is not sufficient alone for any real task.

### Option C — keep two

Simplest for compatibility, but leaves the panel with a count that does not correspond to a real
decision. This is exactly the complaint we are addressing.

## Recommendation

Adopt **Option A**:

| Switch | Registered tools |
|---|---|
| `computerUse` (default) | `computer` with `action: "screenshot"` included |
| `computerUseAdvanced` (opt-in) | `computer` + `computer_screenshot` (today's surface) |

Implementation notes:

1. The facade dispatches internally to the existing `screenshot` and `action` handlers; the
   observation-token, intent/risk, approval, audit and pause code paths are reused unchanged.
2. The capability store gains one boolean (`computerUseAdvanced`); unknown fields are already
   preserved by the store, so the change is additive.
3. The client half gets one tool card and the second toggle in the capability panel / Desktop tab.
4. Tests: facade screenshot dispatch, advanced-flag registration, capability store round-trip; the
   existing X11 integration test switches to `computer({action:"screenshot"})`.
5. The global emergency hotkey and pause semantics are unaffected.

## Open questions

1. Keep the JSON argument names `screen` / `region` / `scale` at the top level for
   `action: "screenshot"`, or nest them under a `screenshot` object? Proposal: keep them top-level
   to match the current tool and the observation-token flow.
2. Does the DSH client need a dedicated "screenshot" card in advanced mode? Proposal: reuse the
   same card, with the tool name shown.

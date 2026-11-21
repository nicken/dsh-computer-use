# Security

`dsh-computer-use` gives an agent real mouse and keyboard control over a desktop. That is a powerful capability, and the plugin is built to make unsafe dispatch hard — but it is **not a sandbox** and not a security boundary between the model and the operating system. This document describes the threat model, the controls that exist, and how to deploy the plugin responsibly.


## Scope boundary: local desktop only

Computer use is **local to the DSH host**. Every action is injected into the interactive OS session
of the machine running the DSH process; a remote browser session does not extend the plugin to the
viewer's desktop. Consequently:

- Enabling this capability grants control of the host machine's desktop. Only enable it for sessions
  and users you trust with that machine.
- Do not deploy the DSH host on a machine whose desktop you would not hand to the agent; prefer a
  dedicated VM or a throwaway desktop session.
- A headless host (no X11/Windows interactive session) has no desktop to control; the plugin fails
  closed instead of guessing.

## Scope and non-goals

In scope for this document:

- what the plugin itself does to reduce accidental and injected actions;
- which assumptions it makes about the host, the DSH approval seam and the operating system;
- how to deploy it with an acceptable blast radius;
- how to report a vulnerability.

Out of scope (the plugin does not claim to solve these):

- a compromised host, root/admin attacker, or malicious DSH build;
- a malicious model that the user has decided to trust with approvals;
- OS-level security (X11's lack of per-client input isolation, Windows session security, kernel exploits);
- data protection of the model provider that receives screenshots through the normal conversation path;
- secrets that happen to be visible on screen or stored in the clipboard.

## Assets

| Asset | Why it matters |
|---|---|
| The user's desktop session | The plugin can click, type, drag and scroll as the user. |
| Screenshots | May contain credentials, messages, customer data, personal information, tokens or internal documents. |
| Clipboard | Linux `type` temporarily owns it, and a clipboard manager may persist the typed text. |
| Audit trail / pause state | Used to review what happened and to stop it; the user relies on them. |
| DSH window | Hosts install, capability and authorization controls that must remain user-driven. |
| Capability store | Controls whether the agent can drive the desktop at all. |

## Threat model

### 1. Accidental action (fat finger / wrong target)

The model can click the wrong coordinate, type into the wrong field, or act on a window that changed after the screenshot.

**Mitigations**

- Observe → one action → observe; a single-use token is required for every input action.
- The token binds the foreground window identity and a pixel fingerprint, plus the monitor geometry on Linux.
- Immediately before dispatch, the layout, foreground handle/rect and fingerprint are re-proven; changes are refused as `stale_observation`.
- On Linux, coordinates are validated against the observed monitor (`invalid_args` on out-of-bounds points).
- The DSH-window guard blocks input into the host UI.
- Destructive intents and system chords are graded high risk and need approval.

**Residual risk**: the model can still click a stale-but-unchanged UI (e.g. a button that appeared after the screenshot and did not alter the sampled fingerprint enough), or misinterpret a screenshot. Use approval and a dedicated desktop for consequential work.

### 2. Prompt injection / social engineering

Untrusted content (a web page, a document, an email) can tell the model to perform an action, potentially phrasing it as a benign intent. Risk grading matches text heuristically; it is not a semantic classifier.

**Mitigations**

- Computer use is off by default and scoped per conversation.
- Activating actions require intent; risky verbs/apps/chords are graded and routed to the DSH approval seam, which fails closed.
- The DSH window cannot be driven by the model, so it cannot approve its own requests.
- Every attempt is audited; the user can pause at any point.
- `policy.json` lets operators add organisation-specific risky verbs/apps.

**Residual risk**: an injected instruction phrased with neutral words can pass the heuristic. The approval prompt, the per-session switch and human review are the real defenses. Do not enable computer use for a conversation that processes untrusted content unless you are watching it.

### 3. Screen privacy / information disclosure

Screenshots may contain secrets. They are written to disk, served to the authenticated DSH Web UI, and — when the agent reads the returned path — become part of the conversation context sent to the model provider.

**Mitigations**

- Screenshots stay local (`$DSH_HOME/computer-use/shots/`), the newest 60 are kept, and no upload happens inside the plugin; the image reaches the model only through the normal DSH image-reading path.
- The `/api/computer-use/shot` route is registered on the host's authenticated connection, only serves `*.png` files from that directory (the plugin additionally rejects traversal) and is not exposed as a model tool.
- `inputcheck` exposes only geometry/facts, not image content.

**Residual risk**: screenshots are unencrypted at rest and readable by the same OS user; they are not redacted; DSH may retain conversation content per its own policy. Treat the shots directory as sensitive, keep the desktop clean, and delete old screenshots if needed.

### 4. Credential entry

The model may be asked to type a password, token or one-time code. On Linux, `type` goes through the clipboard; on Windows it is sent as Unicode `SendInput`. Both are observable by malware already running in the session, and the clipboard may be captured by a clipboard manager.

**Mitigation**: do not have the agent type secrets. Use the target application's authentication flow, a password manager, or have the user perform that step. Prefer approval-gated tasks that do not require credentials.

### 5. Malicious or runaway model

A model that has been compromised, is hallucinating, or is following a malicious instruction could attempt destructive actions.

**Mitigations**

- Per-conversation capability gate, off by default.
- Deterministic token/proof/bounds/pause checks on every dispatch.
- High-risk grading plus DSH approval; `never` policy fails closed.
- Global emergency hotkey and a UI pause; model-initiated pause is one-way.
- Audit trail for after-the-fact review.

**Residual risk**: within the graded-low-risk space the model can do anything the user's account can do. Use a dedicated VM/desktop and a non-admin account for high-risk automation.

### 6. Local / same-session attackers

On X11, any client connected to the display can inject input and capture the screen; X11 has no per-client isolation. On Windows, anything running in the same interactive session may observe input. The plugin cannot fix the platform's security model.

**Mitigation**: use a dedicated X11 session/VM for automation, run as a dedicated user, and do not share the desktop with untrusted software. Wayland's stronger isolation does not help here: the plugin cannot implement global injection there, so it refuses rather than pretending.

## Default safety boundaries

| Boundary | Default | Where |
|---|---|---|
| Tools exposed | Off; both tools are only registered while the conversation's switch is on | `when: ({ agent }) => computerUseEnabled(agent)` |
| Input without observation | Refused (`missing_observation`) | token resolution |
| Stale observation | Refused (`stale_observation`) before dispatch | re-proof in the adapter / Windows helper |
| Out-of-monitor coordinates (Linux) | Refused (`invalid_args`) | `validate()` and injection-point re-check |
| Activating action without intent | Refused (`intent_required`) | tool layer |
| High-risk action | Needs `confirm_risk: true` **and** DSH approval; otherwise fail closed | risk grading + approval seam |
| DSH window | Automated input refused (`dsh_window_blocked`); target-window identity unreadable fails closed | tool layer + backend guards |
| Locked session | Input refused (`desktop_locked`) | backend lock probes |
| Paused | Every input refused (`paused`); pause re-read at the injection point and between sequence steps | tool layer + adapter |
| Unsupported session | Backend unsupported; every action refused (`unsupported_platform`) | backend selection (Wayland, no `DISPLAY`, other OS) |
| Typed text in audit | Never stored; only `textLength` | `appendAudit()` |
| Network | No outbound requests to third parties; the Web client only calls same-origin DSH routes | no HTTP/cloud client in the server code |

## Approval and allowlisting

### The approval seam

High-risk actions call the DSH approval service (`ctx.get("approval")`):

- the request carries the agent/session, tool name, call id, a reason containing the intent and the risk reason, and the call's abort signal;
- only the outcome `allowed-once` lets the action proceed;
- a missing service, a thrown error, a rejection, a cancellation or no answerer all fail closed (`risk_unavailable` / `risk_denied`);
- if the session's effective approval policy is `never`, the action is auto-rejected with guidance to change the policy or let the user act manually.

### Risk policy, not an allowlist

There is **no app or command allowlist** in this plugin. The risk policy is a heuristic:

- risky verbs in the intent (EN/ZH), e.g. send, submit, delete, purchase, pay, confirm, password, install, overwrite, approve;
- risky foreground surfaces (banking, payment, wallet, brokerage, mail clients, plus organisation-specific patterns);
- system-level key chords (`Alt+F4`, `Ctrl+Alt+Del`, `Win+R`).

Operators can extend or replace both regex lists in `$DSH_HOME/computer-use/policy.json` (`riskyIntent`, `riskyIntentReplace`, `riskyApp`, `riskyAppReplace`) and tune the observation TTL (`observationTtlMs`). Invalid regexes are ignored. Test changes with `inputcheck` (it does not print the policy, but the actions you exercise will show the `risk` in results/audit).

If you need a true allowlist, enforce it outside the plugin: a dedicated account/VM whose applications and files are controlled, an approval policy that requires human confirmation, network/firewall restrictions, or a wrapper that only runs the agent against a known application. Do not treat this heuristic as an allowlist.

### The DSH window is user-only

The DSH window hosts capability switches, browser pause/resume and plugin-market install/confirm dialogs. Automated input into it is refused because otherwise the model could authorize itself. On Linux the rule is target-level (so automation can still drive another window while the user reads DSH); on Windows the original blanket activating-action rule is kept. This is a safety measure, not a complete sandbox: other privileged applications are not specially recognized.

## Pause and audit

### Pause

- The pause file (`$DSH_HOME/computer-use/pause.json`) is the single source of truth; its presence refuses all input.
- The model can pause (one-way) with `computer { "action": "pause" }`; only the user can resume, from the Desktop tab (status route).
- The pause is checked before token resolution, at the backend injection point, and between sequence steps — so it also stops an in-flight batch and covers the window while an approval prompt or pixel proof is pending.
- A global hotkey (`Ctrl+Alt+Shift+Q`, fallback `Ctrl+Alt+Shift+F12`) writes the pause file on Windows and on X11 when the python3-Xlib watcher is available. If the watcher cannot start, the UI pause remains and `inputcheck`/status explain why.
- `inputcheck` never injects pointer input while paused or locked.

Pause is an availability control, not a kill switch for already-running OS processes: it blocks plugin-initiated input; it does not stop other software, and the agent could still be instructed to run non-computer-use tools. Use the capability switch and OS controls for a stronger stop.

### Audit

`$DSH_HOME/computer-use/audit.jsonl` is append-only from the plugin's perspective: one JSON line per attempt, including refusals, with timestamp, session, call, action, intent (first 120 chars), risk level, result/code, coordinates, key chord and text length. Typed text is never written.

Limitations:

- the audit is a local plain-text file, writable by the same user and by anything that user runs; it is **not tamper-proof or signed**;
- an audit write failure is swallowed so it can never block a dispatch — a full disk can therefore produce actions without audit lines;
- it is a review aid, not compliance evidence. Forward/ship logs to a protected location if you need them for investigations.

## Deployment recommendations

1. **Use a dedicated VM or desktop session.** Snapshot it, keep it free of credentials, customer data and personal accounts, and roll it back between tasks.
2. **Use a dedicated non-admin OS user.** Do not run DSH as root/Administrator. On Windows, the helper is designed to run unelevated; elevation would widen the blast radius and can break input in unexpected ways.
3. **Keep the capability switch off by default** and turn it on only for the conversation that needs it. Turn it off when the task is done.
4. **Configure approval deliberately.** If you want human review of risky actions, use a policy other than `never`. Understand that `never` auto-rejects approval-required actions rather than silently allowing them.
5. **Keep sensitive content off the desktop**: close password managers, banking, mail and internal chat; use a clean browser profile; disable notification popups that could leak into screenshots.
6. **Treat the shots directory as sensitive.** Restrict permissions on `$DSH_HOME`, delete old screenshots, and avoid screen-sharing/recording the desktop while the agent works.
7. **Review the audit trail** after unattended sessions, especially coordinate-level actions on irreversible surfaces.
8. **Keep the pause hotkey in reach.** On X11 install `python3-xlib` so the global brake works; otherwise use the Desktop tab's pause button.
9. **Do not enable computer use for conversations that process untrusted content** unless the approval policy and the surrounding environment make that acceptable.
10. **Isolate the network** for the VM if the task does not need it; the plugin itself makes no network calls, but the model and the desktop applications do.
11. **Update deliberately**: review `CHANGELOG.md` and the diff when upgrading the plugin, just as you would for any tool with this level of access.

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

- Preferred: use a private GitHub Security Advisory for `github.com/nicken/dsh-computer-use` (Security → Advisories → "Report a vulnerability") so the report stays private until a fix is available.
- Placeholder: a dedicated security contact and response-time commitment will be documented here before the public release. Until then, contact the repository maintainers privately through the same GitHub repository.

Please include: affected version/commit, platform and session (X11/Windows, DSH approval policy), reproduction steps, the tool calls/refusal codes involved, and whether the issue is a bypass of the token/proof/guard/pause logic, an unintended input path, an information leak, or a route/access-control issue. Redact screenshots and typed secrets.

## Security-relevant files

| File | Role |
|---|---|
| [`index.js`](../index.js) | Tool gate, token store, risk grading, approval calls, DSH-window guard, audit, pause, routes, capability store. |
| [`backends/linux-adapter.mjs`](../backends/linux-adapter.mjs) | Capture/validate/prove/guard/dispatch; injection-point pause re-check; fail-closed target identity. |
| [`backends/linux-x11.mjs`](../backends/linux-x11.mjs) | Native primitives, lock probing, pointer readback. |
| [`backends/win32.mjs`](../backends/win32.mjs) | C# P/Invoke helper, DSH-window checks, desktop lock, DPI awareness, staging. |
| [`backends/x11-hotkey.py`](../backends/x11-hotkey.py) | Global brake hotkey watcher. |
| [`backends/clipboard.py`](../backends/clipboard.py) | Clipboard owner used for Linux `type`. |
| [`client.js`](../client.js) | UI switch/status; no security decisions of its own. |
| [`backends/CONTRACT.md`](../backends/CONTRACT.md) | Frozen safety invariants and known weakenings. |

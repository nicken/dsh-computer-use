# Testing

The test suite is deliberately dependency-free: every test is a plain Node ESM script, run with `node <file>`, and exits non-zero on failure. There is no test runner, no watcher and **no `npm install`** — this keeps CI fast and the dispatch path auditable.

The suite is split into three layers by what they need:

| Layer | Files | Needs | Purpose |
|---|---|---|---|
| 1. Pure logic | `tests/adapter-selftest.mjs`, `backends/selftest.mjs` | Only Node | Argument validation, monitor/screen parsing, DPI, PNG codec, crop/scale, fingerprints, key tokens |
| 2. Static platform | `tests/windows-mode-selftest.mjs` | Only Node | Windows-mode surface and pure Win32 helpers with a faked `process.platform` |
| 3. Capability surface | `tests/capability-unit.mjs` | Only Node | Default one-tool surface, `computerUseAdvanced` gating, capability route round-trip |
| 4. Real X11 integration | `tests/linux-integration.mjs`, `backends/smoke-linux.mjs` | X server, `xdotool`, screenshot tool, `xprop`/`xwininfo`/`xrandr` | End-to-end tool flow against a real XTest/screenshot path |

## Commands

### Offline (any OS, no X11, no DSH)

```bash
node tests/adapter-selftest.mjs
node backends/selftest.mjs
node tests/windows-mode-selftest.mjs
node tests/capability-unit.mjs
```

- `tests/adapter-selftest.mjs` — 39 checks. Exercises the Linux adapter's pure `validate()` layer: coordinate rounding, every action's required arguments, scroll defaults/anchors, type limits, keyboard chords/aliases, wait bounds, sequence limits (step count, text budget, nested sequence, per-step `state_id`), monitor-bounds rejection for each coordinate-bearing action.
- `backends/selftest.mjs` — 85 checks. Exercises the X11 primitives without X11: CRC32/PNG decode (all filters) and encode, `xrandr --listmonitors` parsing, screen selection (`auto`/`cursor`/id/index/unknown), `xrandr --query` physical-size/DPI/rotation enrichment, capture-tool fallback (`scrot` → `import` → `xwd`), XWD decoding, fingerprint sampling/comparison, key-token resolution, negative-origin crop/encode and nearest-neighbour scaling.
- `tests/windows-mode-selftest.mjs` — 22 checks. Fakes `process.platform = "win32"` before importing the plugin, then asserts: both tool definitions are registered (the fake context bypasses `when`; a real session defaults to one `computer` tool and only registers `computer_screenshot` with the advanced switch); the tool descriptions stay Windows-flavoured (no Linux/X11 wording, the hotkey sentence and SendInput diagnostics preserved); public schema stays intact; Win32 monitor parsing, screen selection (primary/`all`/id/index), capture-area region/scale math and `publicScreen()` shape. It runs on Linux, Windows and macOS alike.

- `tests/capability-unit.mjs` — 14 checks. Mounts the plugin on a fake Cordis context with a fake `connection.fetch` route table and asserts: the default surface registers `computer` and hides `computer_screenshot`; `GET/POST /api/computer-use/capability` round-trips `enabled` and `advanced`; turning `advanced` on makes `computer_screenshot` visible; turning the main switch off hides both.

`npm test` runs all four offline suites (39 + 85 + 22 + 14 checks).

### Real X11 integration

On an X11 desktop (the default safe mode only takes screenshots and moves the pointer):

```bash
node tests/linux-integration.mjs
```

The test mounts `index.js` on a fake Cordis context (the same `apply()` the DSH host calls), so it verifies the real wiring without a DSH restart. It redirects `DSH_HOME` into a throwaway `.e2e-dsh-home/` and deletes it afterwards.

Explicit opt-ins (these really click/type/press the hotkey):

```bash
node tests/linux-integration.mjs --click-at 40,40
node tests/linux-integration.mjs --type "hello from dsh"
node tests/linux-integration.mjs --test-hotkey
```

On a single-monitor X11 display with a readable foreground window, the suite typically prints around 79 checks and exits 0; the exact total depends on the environment (extra checks run with multiple monitors or a conclusive lock probe). It prints `SKIP` (not failure) for checks that need hardware or flags it does not have:

- secondary-monitor checks when only one monitor is present;
- the whole-screen fingerprint fallback when a second monitor/window arrangement is unavailable;
- emergency-hotkey injection unless `--test-hotkey` is passed;
- real click/type unless `--click-at`/`--type` are passed.

It also tries to cope with live interference: if the user or another client moves the pointer or changes the foreground during a check, it retries where it can and surfaces the real refusal code instead of masking it.

**A foreground window is required.** The plugin fails closed with `foreground_unreadable` when `_NET_ACTIVE_WINDOW` cannot be read, so a bare `Xvfb` (no window manager, no client windows) is not a valid test environment. See [Headless reproduction](#headless-reproduction) below.

### Real-hardware smoke test

`backends/smoke-linux.mjs` exercises the primitives directly (no tool layer/tokens), restoring the pointer when it can:

```bash
node backends/smoke-linux.mjs                      # monitors, screenshot, pointer move (restored)
node backends/smoke-linux.mjs --screen HDMI-1-0
node backends/smoke-linux.mjs --click-at 400,300   # really clicks
node backends/smoke-linux.mjs --type "hello from dsh"  # really types
```

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs two jobs on every push to `main` and every pull request. It uses `actions/checkout@v4` and `actions/setup-node@v4`, `permissions: contents: read`, and a concurrency group that cancels superseded runs. There is no install step.

### `linux` job

- Runner: `ubuntu-latest`.
- Matrix: Node **22** and **24**.
- Packages: `xvfb`, `xdotool`, `scrot`, `x11-utils` (`xprop`, `xwininfo`, `xmessage`), `x11-xserver-utils` (`xrandr`), `openbox` (window manager for the integration test), `python3-gi` + `gir1.2-gtk-3.0` (clipboard helper used by `type`) and `python3-xlib` (emergency-hotkey watcher).
- Commands (in order):
  ```bash
  node tests/adapter-selftest.mjs
  node backends/selftest.mjs
  node tests/windows-mode-selftest.mjs
  xvfb-run -a -s "-screen 0 1280x1024x24" bash -c '
    openbox >/dev/null 2>&1 &
    sleep 1
    xmessage -geometry 900x700+0+0 -title "dsh-computer-use CI target" "CI target" >/dev/null 2>&1 &
    sleep 1
    node tests/linux-integration.mjs
  '
  ```

The wrapper is required because the integration suite needs a foreground window: `openbox` publishes `_NET_ACTIVE_WINDOW` and `xmessage` provides a stable target window. Running `xvfb-run -a node tests/linux-integration.mjs` **without** a WM/client is expected to fail (often before the summary, because actions are refused with `foreground_unreadable`); that is the fail-closed behaviour, not a test bug.

### `windows` job

- Runner: `windows-latest`, Node **22**.
- Commands:
  ```bash
  node tests/adapter-selftest.mjs
  node backends/selftest.mjs
  node tests/windows-mode-selftest.mjs
  ```
- No Linux integration test, no PowerShell dispatch: the Windows job validates the static/pure surface only. Real Windows dispatch is still a manual validation step (see [PLATFORMS.md](PLATFORMS.md)).

## Headless reproduction

You can reproduce the CI integration step locally on any machine with the packages installed:

```bash
xvfb-run -a -s "-screen 0 1280x1024x24" bash -c '
  set -eu
  export XDG_SESSION_TYPE=x11
  openbox >/dev/null 2>&1 &
  sleep 1
  xmessage -geometry 900x700+0+0 -title "dsh-computer-use CI target" "CI target" >/dev/null 2>&1 &
  for attempt in $(seq 1 20); do
    xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | grep -qE "window id # 0x[1-9a-fA-F]" && break
    sleep 0.5
  done
  if ! xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | grep -qE "window id # 0x[1-9a-fA-F]"; then
    echo "Xvfb has no foreground window; the integration test would fail closed with foreground_unreadable."
    exit 1
  fi
  node tests/linux-integration.mjs
'
```

If you only want the offline suites:

```bash
node tests/adapter-selftest.mjs && node backends/selftest.mjs && node tests/windows-mode-selftest.mjs
```

Only the Windows-mode test creates its own throwaway `DSH_HOME` (`.winmode-dsh-home/`, deleted afterwards); the other two offline suites do not touch `DSH_HOME`, and the integration suite redirects it by itself.

## Interpreting failures

- Every test prints `PASS`/`FAIL`/`SKIP` per check and ends with `<n>/<n> checks passed` or `<m> of <n> checks FAILED`; exit code 0 means every executed check passed.
- `SKIP` is not a failure; it means the required hardware/flag was absent. CI on a single-monitor Xvfb expects several SKIPs.
- A crash (a `TypeError`, an unhandled rejection or an exit before the summary line) means the environment is missing a prerequisite the test assumes; read the stack trace and fix the environment rather than weakening the assertion.
- On a real desktop, close anything that moves the pointer or steals focus while the integration test runs. The test tolerates some interference by retrying, but a locked screen or a continuously moving window will make results unstable.
- If `inputcheck` in the integration test reports missing tools, install the packages from [PLATFORMS.md](PLATFORMS.md#dependencies) — the test asserts the input path is healthy.

## Adding tests

- Pure helpers belong in `backends/linux-x11.mjs` / `backends/linux-adapter.mjs` and are exported so the offline suites can call them; add assertions to `backends/selftest.mjs` or `tests/adapter-selftest.mjs`.
- Platform-facing schema/description checks belong in `tests/windows-mode-selftest.mjs` with a faked platform.
- End-to-end behaviour (tokens, pause, routes, DSH guard, schema validity) belongs in `tests/linux-integration.mjs`; it already includes a small JSON-Schema output validator so schema regressions surface outside the real host.
- Keep tests dependency-free and deterministic; never add a test that types into or clicks an arbitrary live window without an explicit flag.
- When changing a safety invariant, add or update the corresponding test and the invariant in [`backends/CONTRACT.md`](../backends/CONTRACT.md).

## Related documents

- [DEVELOPMENT.md](DEVELOPMENT.md) — local setup and release process.
- [PLATFORMS.md](PLATFORMS.md) — platform prerequisites and troubleshooting.
- [ARCHITECTURE.md](ARCHITECTURE.md) — what the tests are protecting.
- [`backends/CONTRACT.md`](../backends/CONTRACT.md) — invariants and the Linux test commands (Chinese).

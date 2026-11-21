# Platforms

`dsh-computer-use` ships two native desktop backends:

| Platform | Session | Backend | Status |
|---|---|---|---|
| Linux | X11 (`DISPLAY` set, not Wayland) | `linux-x11` | Supported; the primary development and test platform |
| Linux | Wayland or XWayland-only | — | **Refused** with a structured `unsupported_platform` reason |
| Windows | Windows 10/11, Windows PowerShell 5.1 | `windows-native` | Implemented; static/pure-function tests only — not yet validated end-to-end on real Windows hardware in this repository |
| macOS / others | — | — | **Refused** with `unsupported_platform` |

The backend is selected once per process by [`backends/index.mjs`](../backends/index.mjs) from `process.platform` and the Linux session environment. Refusing at selection time is intentional: a wrong session should produce a clear refusal, not a raw `scrot`/`xrandr`/PowerShell error.

---

## Linux / X11

### Session detection

The Linux backend is supported when **all** of the following hold:

- `process.platform === "linux"`;
- `XDG_SESSION_TYPE` is not `wayland` (unset is treated as X11; `x11` is accepted);
- `DISPLAY` is non-empty.

If `XDG_SESSION_TYPE=wayland` and `DISPLAY` is set, the refusal explains that the display is XWayland and injected X11 input would reach only XWayland clients. If `DISPLAY` is empty and `WAYLAND_DISPLAY` is set, the refusal reports the host as a Wayland session.

### Dependencies

Required binaries (probed by `inputcheck`; missing ones are hard problems with install hints):

| Binary | Used for | Debian/Ubuntu package |
|---|---|---|
| `xdotool` | XTest pointer/keyboard injection, cursor reads, window-under-pointer | `xdotool` |
| `xprop` | foreground window id/title/class/pid, target-window identity | `x11-utils` |
| `xwininfo` | absolute window geometry | `x11-utils` |
| `xrandr` | monitor enumeration (`--listmonitors`) and physical size/rotation (`--query`) | `x11-xserver-utils` |

A screenshot tool is also required; at least one of:

| Binary | Notes | Debian/Ubuntu package |
|---|---|---|
| `scrot` | Preferred; can grab a sub-rectangle directly and is the fastest path | `scrot` |
| `import` | ImageMagick fallback | `imagemagick` |
| `xwd` | X11 dump fallback, decoded by the plugin | `x11-apps` |

The capture tool is chosen in that order and cached for 10 seconds; `DSH_COMPUTER_USE_CAPTURE=scrot|import|xwd` forces one (useful when testing a fallback path).

Optional components:

| Component | Enables | Behaviour when missing |
|---|---|---|
| `python3` + `Xlib` | Global emergency hotkey (`backends/x11-hotkey.py`) | Pause still works from the Desktop tab; `inputcheck` reports why the hotkey is unavailable |
| `python3` + GTK 3 (`python3-gi`, `gir1.2-gtk-3.0`) | Clipboard-based `type` for all Unicode text (`backends/clipboard.py`) | ASCII typing falls back to raw key events with a warning; non-ASCII fails with `clipboard_unavailable` |
| `loginctl` and/or `dbus-send` | Better lock-screen detection | Falls back to lock-window probes; detection is best-effort |
| `xclip` | Diagnostic only | No effect on input; `type` uses the GTK helper |

`DSH_COMPUTER_USE_PYTHON` overrides the Python executable used by both helpers.

### Monitors and coordinates

- Monitors are re-read on **every** call from `xrandr --listmonitors` (pixel geometry) and `xrandr --query` (physical size and rotation). Hotplug, rotation and rearranged layouts are picked up immediately; the monitor layout is never cached.
- Screen selection for `computer_screenshot`:
  - omitted / `"auto"` → the primary monitor (the one marked `*`); if none is primary, the largest monitor. `auto` deliberately does not follow the pointer, so consecutive screenshots stay on the same monitor;
  - `"cursor"` → the monitor under the pointer, falling back to the primary/largest monitor when the pointer is outside every monitor;
  - a monitor id (e.g. `"HDMI-1-0"`) or an index (`"1"`).
- An unknown id is rejected with an error listing every detected monitor id, resolution and origin.
- Each screenshot returns the selected `screen` plus the full `screens` list, including `dpi` and `rotation` when the panel reports a physical size. DPI failures never affect geometry.
- **All action coordinates are local to the observed monitor**: global X = `screen.x + x`, global Y = `screen.y + y`. Points outside the monitor are refused as `invalid_args` before injection.
- Switching monitors requires a new screenshot: the action monitor must equal the token's monitor, otherwise the action is refused with `stale_observation`.
- Negative-origin layouts (a monitor left of or above the primary): `scrot -a` cannot express negative coordinates, so the backend captures the root window and crops/encodes the monitor in Node. If the root window does not cover the monitor, the capture fails with a clear error instead of silently grabbing the wrong area.

### Typing and the clipboard

`type` is implemented as a clipboard paste on Linux, so XIM/ibus cannot mangle text (raw key events can turn `a.b.c` into pinyin candidates and drop the dots):

1. read the current clipboard text via `backends/clipboard.py get`;
2. own `CLIPBOARD` with the requested text via `backends/clipboard.py set` and wait for `READY`;
3. press `Ctrl+V` with `xdotool`;
4. restore the previous clipboard with a short-lived background owner.

If the GTK helper is unavailable, ASCII text falls back to raw `xdotool type` (with a warning) and non-ASCII text fails with `clipboard_unavailable`. Very large/binary clipboards and clipboard managers can affect restoration; the helper is best-effort, not a clipboard manager.

### Input path safeguards

- Every pointer-moving operation goes through a pointer queue, so `inputcheck`'s probe and a dispatch cannot race each other.
- `warpTo` reads the pointer back; a mismatch is retried up to three times, then refused as `pointer_warp_unstable` — the plugin never clicks blindly. If the pointer is already at the target, it returns immediately (`xdotool mousemove --sync` produces no motion event on the same coordinate).
- Failed paths release mouse buttons (`mouseup 1/2/3`), leaving no button pressed.
- Drags read back the final pointer position; if it did not reach the target, the action fails with `drag_unstable`.
- Target-window identity is read with `xprop`/`xdotool getmouselocation`; if it cannot be read, the action fails closed (`window_unidentified` / `window_probe_failed`).
- The session lock is probed through logind `LockedHint`, GNOME ScreenSaver DBus, and common lock-window classes. A locked session refuses injection with `desktop_locked`; the probe is best-effort.

### Emergency brake

`backends/x11-hotkey.py` is a python3-Xlib watcher spawned as a child of the DSH host. It grabs the first available chord on the root window — `Ctrl+Alt+Shift+Q`, fallback `Ctrl+Alt+Shift+F12` — including Lock/NumLock modifier variants, and writes `pause.json` when pressed. It exits when the host process disappears or the UI stops it. If Python or Xlib is missing, the watcher is skipped; the Desktop tab's pause button remains the brake, and `inputcheck`/status report the reason.

Hotkey candidates deliberately exclude `Ctrl+Alt+F1..F12`: those are X.org VT-switch bindings and would black the display if not grabbed.

### Headless / Xvfb testing

The real-X11 integration test needs an X server **and a foreground window**. A bare `Xvfb` has no window manager and therefore no `_NET_ACTIVE_WINDOW`; the plugin will refuse actions with `foreground_unreadable` (correct fail-closed behaviour). To run the integration suite headlessly, start a window manager and a client window inside the same Xvfb session:

```bash
xvfb-run -a -s "-screen 0 1280x1024x24" bash -c '
  openbox >/dev/null 2>&1 &
  sleep 1
  xmessage -geometry 900x700+0+0 -title "dsh-computer-use CI target" "CI target" >/dev/null 2>&1 &
  sleep 1
  node tests/linux-integration.mjs
'
```

This is the core of what CI does (CI also waits for and asserts a non-zero `_NET_ACTIVE_WINDOW`; see [TESTING.md](TESTING.md)). On a real desktop, no wrapper is needed.

---

## Windows

### How it runs

- Every dispatch is one short-lived `powershell.exe` process (Windows PowerShell 5.1, the `System32\WindowsPowerShell\v1.0\powershell.exe` path when present) that loads an in-memory C# P/Invoke helper via `Add-Type` and returns a single JSON result.
- The helper calls `SetProcessDPIAware()` and uses Win32 `SendInput`, `GetForegroundWindow`, `GetWindowRect`, `OpenInputDesktop` and WinForms `Screen.AllScreens`.
- Scripts are staged as UTF-8 (BOM) `.ps1` files under `%LOCALAPPDATA%\dsh-computer-use\helper` and run with `-File`. Staging avoids the command-line length limit and, more importantly, avoids running from a Low-integrity workspace directory where `SendInput` is silently lost. `inputcheck` reports the staging directory, whether it is under `%LOCALAPPDATA%`, and the integrity level.
- The emergency hotkey is a hidden PowerShell watcher with a global `RegisterHotKey` (`Ctrl+Alt+Shift+Q`, fallback `Ctrl+Alt+Shift+F12`) that writes the pause file. It terminates itself when the host process exits.

### Monitors, DPI and coordinates

- Monitors are enumerated through WinForms `Screen.AllScreens`; negative origins are supported and preserve the virtual-desktop arrangement.
- `computer_screenshot { screen }`:
  - omitted / `"auto"` → the primary monitor;
  - `"all"` / `"virtual"` → the bounding box of the whole virtual desktop in one image;
  - a monitor id (e.g. `"DISPLAY1"`, with or without the `\\.\` prefix) or an index.
- `region` is **monitor-local**; `scale` shrinks the capture. The returned `originX`/`originY` are desktop-global.
- **Action coordinates remain desktop-global** (Win32 `SendInput` semantics). To click a point measured on a screenshot, compute `global = originX/originY + image position`. This differs from Linux on purpose; the tool descriptions state it.
- DPI: because the helper is system-DPI-aware, screen geometry and capture use physical pixels rather than a DPI-virtualized coordinate space. Per-monitor DPI scaling advice is not implemented; if a mixed-DPI layout behaves unexpectedly, run `inputcheck` and verify the monitor list/origins first.

### Diagnostics and known gaps

- `inputcheck` on Windows reports helper staging and `underLocalAppData`, integrity level/session id, `locked`, dispatch confirmation (`SendInput` probe), pointer drift, pause state and brake status in `check`; the provider-slot report is at the result top level.
- The Windows action/sequence/brake/self-check PowerShell script builders still live in [`index.js`](../index.js); [`backends/win32.mjs`](../backends/win32.mjs) owns the C# source, PowerShell staging, monitor enumeration and capture. Moving the remaining scripts is tracked in `CONTRACT.md` §4.
- **Windows UIPI applies.** `SendInput` cannot inject into windows whose integrity level is higher than the DSH process (for example, an app started with "Run as administrator"). Run DSH and the target applications at the same elevation; do not elevate DSH just to work around this.
- **This repository has not validated the Windows backend on real Windows hardware.** It is covered by static checks and pure-function tests (`tests/windows-mode-selftest.mjs`) that run on any OS. Treat the first real deployment as a validation run: execute `computer { "action": "inputcheck" }`, take a screenshot, and try a harmless `move` before any real task.

---

## Wayland

Wayland is **not supported**, and the plugin does not pretend otherwise:

- There is no portable, unprivileged global input injection API comparable to XTest.
- There is no global foreground-window concept the plugin can rely on.
- XWayland is not enough: an X11 client can see and drive only XWayland clients, so injected input would silently miss native Wayland applications.

If `XDG_SESSION_TYPE=wayland`, or `DISPLAY` is empty, backend selection returns `supported: false` and every action is refused with `unsupported_platform` and a reason. The only workaround is to log into an X11 session (or use a dedicated X11 VM/desktop), not to force `DISPLAY`.

---

## Troubleshooting

| Symptom / code | Likely cause and fix |
|---|---|
| Tools do not appear | The per-conversation switch is off. Open the Desktop tab and enable computer use; check the conversation has a session id. |
| `unsupported_platform` | Wayland session, empty `DISPLAY`, or an unsupported OS. Log into X11 (or use Windows); on Wayland, do not force `DISPLAY`. |
| `inputcheck_failed` with missing tools | Install the packages listed by `inputcheck` (`xdotool`, `x11-utils`, `x11-xserver-utils`, one of `scrot`/ImageMagick/`x11-apps`). |
| `foreground_unreadable` | No active window: headless Xvfb without a WM, a locked session, or a desktop where `_NET_ACTIVE_WINDOW` is not maintained. Focus a real application (or add a WM in headless tests). |
| `stale_observation` (`window`, `bounds`, `layout`, `pixels`) | The desktop changed after the screenshot: window moved, another window took focus, page loaded, monitor rearranged. Take a new screenshot and act promptly; avoid animations or waiting for content before acting. |
| `observation_expired` | Token older than the TTL (default 180 s), unknown after a host restart, or from another conversation. Take a new screenshot. Increase `policy.json#observationTtlMs` or `DSH_COMPUTER_USE_OBSERVATION_TTL_MS` if your loop is slow. |
| `observation_used` | The token was already consumed. Use the `state_id` in the last result, or take a new screenshot. |
| `observation_superseded` | A newer screenshot replaced the token. Use the newest `state_id`. |
| `dsh_window_blocked` | The target is the DSH window (or keyboard focus is DSH on Linux). Ask the user to perform that UI step; automate another application. |
| `window_unidentified` / `window_probe_failed` | The target window has no readable identity (class/title). Fail-closed by design; focus the application window and retry, or click a point inside an identified window. |
| `pointer_warp_unstable` | Another client/user is moving the pointer, or the pointer is grabbed. Retry; run `inputcheck` to see whether the warp probe succeeds. |
| `drag_unstable` | The drag end point was not reached. Retry; check pointer grabs and window drag behavior. |
| `desktop_locked` | The workstation/session is locked. Ask the user to unlock it, then take a new screenshot. |
| `paused` | The user's emergency pause is active. Only the user can release it from the Desktop tab; do not retry until then. |
| `clipboard_unavailable` | Linux non-ASCII typing needs GTK 3 (`python3-gi`, `gir1.2-gtk-3.0`). Install it or restrict to ASCII. |
| `risk_approval_required` / `risk_denied` | High-risk grade. Retry with `confirm_risk: true` and the user's approval, or do the action manually; check the session approval policy (not `never`). |
| Emergency hotkey unavailable on Linux | Install `python3-xlib`; otherwise pause from the Desktop tab and rely on `inputcheck`'s brake report. |
| Multi-monitor actions land on the wrong screen | Take a screenshot of the target monitor and use that token; action coordinates are monitor-local on Linux. On Windows remember action coordinates are global. |
| Negative-origin monitor capture fails | `scrot` cannot express negative offsets; the backend falls back to root capture + Node crop. If the root window does not cover the monitor, rearrange the layout or use an X server that exports the full combined screen. |

For security boundaries and deployment advice, read [SECURITY.md](SECURITY.md). For the backend invariants, read [`backends/CONTRACT.md`](../backends/CONTRACT.md).

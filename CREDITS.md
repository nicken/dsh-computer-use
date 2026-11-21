# Credits

`dsh-computer-use` is built on the DeepSeek Harness plugin system and on the native desktop tooling of each platform. This page lists what is actually used or referenced. If something is not listed here, the plugin does not depend on it.

## Host and plugin framework

- **DeepSeek Harness (DSH)** — the host application. The plugin uses the DSH tool registration seam, `ctx.inject`/`ctx.effect` lifecycle, the `connection.fetch` route registry, the `approval` service, the plugin-manager listing, and the Web client's `conversation.view` / `tool.call.toolview` slot and locale APIs.
- **Cordis** — the plugin composition/context framework underneath DSH. This repository is written against the plugin context API that Cordis provides; Cordis itself is not vendored here.
- **DSH Web client packages** — the client bundle follows the `@deepseek-ai/dsh-client-modules` loader contract and uses `@deepseek-ai/dsh-client-locale` for dictionaries (injected through `package.json` `dsh.client.inject`).

## Linux / X11 tooling

- **xdotool** — XTest-based pointer/keyboard injection, cursor and window-under-pointer queries (`xdotool getmouselocation`, `mousemove`, `click`, `mousedown`/`mouseup`, `key`, `type`).
- **scrot** — the preferred single-monitor screenshot tool (`scrot -a` for non-negative origins).
- **ImageMagick (`import`)** — optional fallback screenshot tool.
- **X11 / `xwd` (`x11-apps`)** — optional fallback screenshot path, decoded by the plugin's own PNG/XWD code.
- **`xprop`, `xwininfo`, `xrandr` (`x11-utils`, `x11-xserver-utils`)** — foreground window identity/bounds and monitor layout/physical-size/rotation facts.
- **X.Org / XTest** — the extension that makes synthetic input possible in X11.
- **Xvfb** — headless X server used by the integration test and CI.
- **openbox** — window manager used in CI to publish `_NET_ACTIVE_WINDOW` for the integration test's foreground-window checks.
- **xmessage (`x11-utils`)** — the stable target window used by the CI integration test.
- **python-xlib** — powers the optional X11 emergency-brake hotkey watcher (`backends/x11-hotkey.py`).
- **PyGObject / GTK 3** — powers the optional X11 clipboard helper (`backends/clipboard.py`) used by `type` so XIM/ibus cannot mangle text.
- **xclip** — an optional diagnostic/legacy X11 clipboard tool; it appears in the environment self-check, but the current `type` path uses the GTK helper instead.
- **systemd `loginctl`** and **D-Bus (`dbus-send`)** — optional lock-screen detection sources on X11.

## Windows platform

- **Windows PowerShell 5.1** — execution host for the dispatch helper (`powershell.exe`, `-File`, staged `.ps1`).
- **`Add-Type` / .NET C#** — compiles the in-memory P/Invoke helper.
- **Win32 `user32` / `SendInput` / `GetForegroundWindow` / `GetWindowRect` / `OpenInputDesktop` / `RegisterHotKey`** and **WinForms `Screen.AllScreens`** — input injection, window/monitor facts, lock detection and the emergency hotkey. These are Microsoft platform APIs, used through the documented P/Invoke mechanism.

## Design inspiration

- **Anthropic's computer-use demo** — the general shape of a "screenshot in, one mouse/keyboard action out" tool loop and the idea of putting approval in front of risky actions inspired this tool's design. **No code was copied from it**; this plugin's token model, stale-state proof, audit/pause implementation and backend wiring are its own. Since the demo is a reference rather than a dependency, it is not in `package.json`.
- The observation-token and re-proof approach, the intent/risk grading and the emergency brake are this project's design, shaped by the review comments and hardening work recorded in `CHANGELOG.md` and `backends/CONTRACT.md`.

## Not used

For clarity, the following are **not** used or bundled, despite being common in this space:

- pyautogui
- Playwright, Selenium or Puppeteer
- Tesseract or any OCR/vision library
- any cloud vision or automation API

## Third-party licensing

This project is MIT-licensed (see [LICENSE](LICENSE)). The external binaries and libraries listed above keep their own licenses and are not distributed with this repository; install them through your package manager. The C# and Python helpers in this repository are original code within this project.

## Maintainers and contributors

See the repository's commit history and the contributor list on GitHub. Bug reports, test results from real hardware (especially Windows) and documentation fixes are all welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

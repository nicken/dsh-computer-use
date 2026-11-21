# Development

This is the development guide for `dsh-computer-use`. It replaces the old repository-root `README-DEV.md`; that file now only points here.

- Runtime requirement: **Node.js ≥ 22**.
- The plugin has **no runtime or dev dependencies**. Do not add `node_modules` to the flow; tests and builds run with plain `node`.
- The server code is ESM (`.mjs` and `"type": "module"`); the Web client is ESM source wrapped into a classic script by a build step.

## Repository layout

```
index.js                       Tool layer: computer_screenshot / computer, observation
                               tokens, intent/risk/approval, audit, pause, capability
                               gate, DSH routes, provider slot; Windows PowerShell
                               dispatch scripts (being extracted)
client.js                      ESM source of the Web client (Desktop view, tool cards,
                               per-conversation switch, locale dictionaries)
client.web.js                  Generated browser bundle consumed by the DSH Web loader
                               (do not edit; regenerate from client.js)
scripts/build-client.mjs       client.js -> client.web.js; runs on build:client/prepack
backends/index.mjs             Platform selection (win32 -> windows-native,
                               linux -> linux-x11, other/Wayland -> unsupported)
backends/linux-x11.mjs         X11 primitives: monitors/DPI, capture, PNG codec,
                               fingerprints, foreground windows, input, self-check
backends/linux-adapter.mjs     capture / validate / prove / guard / dispatch / inputCheck
backends/win32.mjs             Windows backend: C# P/Invoke helper, PowerShell staging,
                               monitor enumeration, single/all/region/scale capture
backends/x11-hotkey.py         X11 global emergency-brake hotkey watcher
backends/clipboard.py          X11 GTK clipboard helper used by `type`
backends/CONTRACT.md           Backend contract, coordinates and safety invariants
backends/selftest.mjs          Offline self-test of the X11 primitives
backends/smoke-linux.mjs       Real-hardware smoke test (safe defaults)
tests/adapter-selftest.mjs     Offline argument-validation test for the Linux adapter
tests/windows-mode-selftest.mjs Static Windows-mode regression (fakes process.platform)
tests/linux-integration.mjs    Real-X11 end-to-end test (fake Cordis context)
locale/en.json, locale/zh.json Package metadata + UI string mirrors
cordis.patch.yml               Inserts the `computer-use` entry into the profile
icon.svg                       Plugin icon
docs/                          This documentation, including the real-machine demo
.github/workflows/ci.yml       CI: Linux Xvfb matrix + Windows static checks
README.md / README.zh-CN.md    User documentation
CHANGELOG.md                   Version history
LICENSE                        MIT
```

### Package identity

The package was renamed for open source: `package.json` `name`, the DSH client bundle id
(`client.web.js`), `SELF_MODULE_NAME` in `index.js` and the `data-plugin` style attributes all use
`dsh-computer-use`. If you change the package name again, regenerate the bundle with
`npm run build:client` (or `node scripts/build-client.mjs`) so the host, which registers client
factories by package id, can find it; then verify the Desktop tab loads in a real DSH profile.

## Local development install

### Option A: link the checkout into a DSH profile

From the repository root:

```bash
dsh plugin --profile web add link:"$PWD"
```

`dsh plugin` forwards its arguments to pnpm inside the profile directory (`~/.dsh/profiles/web`), so `link:` creates a development mount instead of copying the package. Restart the DSH Web app after the first install if the plugin row does not appear.

For a custom profile, replace `web`:

```bash
dsh plugin --profile my-dev-profile add link:"$PWD"
```

Notes:

- Editing an existing file is usually picked up by the profile's HMR/recomposition; if it is not, trigger a recomposition (for example by touching the profile patch) or restart. **New files** (for example a new `backends/*.mjs`) are not guaranteed to be wired by HMR; restart `dsh web` after adding one or when the plugin row is marked failed.
- Remove the mount with `dsh plugin --profile web remove dsh-computer-use` when you are done.
- Do not develop inside a `file:` copy of the tarball: that is a snapshot, and changes there do not flow back to this repository.

### Option B: install from GitHub

```bash
dsh plugin --profile web add github:nicken/dsh-computer-use
```

Use this to test the packaging path (the `files` whitelist, the generated client bundle and the bundle patch). For a specific release, append the tag: `github:nicken/dsh-computer-use#vX.Y.Z` (replace `X.Y.Z`).

### Temporary DSH_HOME for experiments

The plugin stores screenshots, audit, pause and policy under `$DSH_HOME/computer-use/` by default (with `$DSH_HOME` defaulting to `~/.dsh`). When running tests or one-off scripts, point `DSH_HOME` at a throwaway directory so a real profile is never touched:

```bash
export DSH_HOME="$(mktemp -d)"
node tests/linux-integration.mjs   # note: this test also redirects DSH_HOME itself
```

The integration tests already redirect `DSH_HOME` into `.e2e-dsh-home/` / `.winmode-dsh-home/` under the working directory and delete it afterwards. They never read or write your real `~/.dsh`.

Useful environment variables:

| Variable | Effect |
|---|---|
| `DSH_HOME` | Root for plugin state (`computer-use/`). |
| `DSH_COMPUTER_USE_OBSERVATION_TTL_MS` | Observation TTL override (clamped to 5 s–30 min). |
| `DSH_COMPUTER_USE_CAPTURE` | Force the Linux screenshot tool: `scrot`, `import` or `xwd`. |
| `DSH_COMPUTER_USE_PYTHON` | Python executable for the X11 helpers (default `python3`). |

## Building the client

`client.js` is the source of truth. The DSH Web module loader does not execute ESM, so `scripts/build-client.mjs` mechanically wraps the file into a classic script that registers a lazy factory:

```bash
node scripts/build-client.mjs      # or: npm run build:client
```

The build asserts:

1. exactly one top-level export statement, and it is `export default face`;
2. no `import` statements (the bundle inlines the source);
3. the generated bundle parses as a classic script.

The authoring rules that the build does **not** enforce: never touch `window`/`document` at module scope (only inside `apply()`), and keep the file import-free so the transform stays mechanical. Both are stated at the top of `client.js`; keep them when editing.

`prepack` runs the same build, so `npm pack` always produces a fresh `client.web.js`. Commit both `client.js` and the regenerated `client.web.js` together; never hand-edit the generated file.

## Code style

- ESM only; Node built-ins only. **No new runtime dependencies** without a strong justification — the dependency-free property is part of the safety story (small, auditable, no supply chain in the dispatch path).
- Match the surrounding style: 2-space indentation, single quotes, no semicolons, JSDoc-style comments on exported/non-obvious functions.
- Put platform-agnostic logic in `index.js`; platform primitives in `backends/*`; keep the Linux adapter's `validate()` pure so it can be tested without X11/DSH.
- Export pure helpers (parsers, geometry, fingerprint, PNG codec, screen selection) so `backends/selftest.mjs` can exercise them on any OS.
- When changing a safety invariant, update [`backends/CONTRACT.md`](../backends/CONTRACT.md), the relevant test, and explain the trade-off in the PR. Do not silently weaken checks (stale proof, pause re-read, mount bounds, fail-closed target identity).
- Error messages and tool refusals are model-facing: keep `{ code, message, guidance }`, keep guidance actionable, and do not include secrets or absolute personal paths.
- Comments that explain *why* a safety check exists are welcome; comments that restate the code are not.

## Testing before a PR

Run the offline tests on any OS:

```bash
node tests/adapter-selftest.mjs
node backends/selftest.mjs
node tests/windows-mode-selftest.mjs
```

If you touch the Linux backend, also run the real-X11 integration test on an X11 session:

```bash
node tests/linux-integration.mjs
```

If you touch the Windows dispatch scripts, state clearly in the PR that the Windows path was only statically tested (unless you have a Windows host); update `tests/windows-mode-selftest.mjs` accordingly. Details and the CI matrix are in [TESTING.md](TESTING.md).

## Release process

1. **Update the version** in `package.json` (semver; breaking tool/coordinate changes are major) and add a `CHANGELOG.md` entry. The changelog is the user-facing record; include limitations, not only features.
2. **Rebuild the client** and commit both files:
   ```bash
   node scripts/build-client.mjs
   ```
3. **Run the tests** (at minimum the three offline suites; Linux changes also need the integration suite).
4. **Inspect the package** (no dependencies, so this is quick):
   ```bash
   npm pack --dry-run
   ```
   Confirm the whitelist includes `index.js`, `client.js`, `client.web.js`, `scripts/build-client.mjs`, `backends/`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README-DEV.md`, `tests/`, `CHANGELOG.md` and `docs/`. `README.md` is included automatically by npm. If you add a distribution-relevant file outside those paths, update `package.json` `files` in the same PR.
5. **Commit and tag** (annotated tag), then push:
   ```bash
   git tag -a vX.Y.Z -m "dsh-computer-use vX.Y.Z"
   git push origin main --follow-tags
   ```
6. **Create a GitHub release** from the tag with the changelog section as the body.
7. **Upgrade path for users**:
   ```bash
   dsh plugin --profile web add github:nicken/dsh-computer-use#vX.Y.Z
   ```
   (or update the pinned ref already in the profile). Restart the DSH Web app after upgrading.

There is no npm registry publication step configured in this repository; the supported distribution path is the GitHub tag/install command above.

### Rollback

Pin the profile back to the previous tag, or remove and re-add the plugin at the known-good ref, then restart. Keep the old `CHANGELOG.md` entry so the rollback is auditable.

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — layers and design.
- [TESTING.md](TESTING.md) — test layers, commands and CI.
- [PLATFORMS.md](PLATFORMS.md) — platform-specific implementation details.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — PR expectations.
- [`backends/CONTRACT.md`](../backends/CONTRACT.md) — contract and invariants.

# Contributing

Thanks for helping improve `dsh-computer-use`. This project drives real desktops, so contributions are reviewed with an eye on **safety invariants** as well as correctness and style. Please read this page before opening an issue or a pull request.

## Code of conduct

Be respectful and constructive. Harassment, discrimination, personal attacks and publishing other people's private information are not acceptable. Maintainers may edit, lock or remove contributions and comments that violate this. Report conduct problems privately to the maintainers through the repository's private channels (see [SECURITY.md](docs/SECURITY.md) for the private reporting path).

## Reporting bugs

Before filing, check:

- [README.md](README.md) and [docs/TESTING.md](docs/TESTING.md);
- [docs/PLATFORMS.md](docs/PLATFORMS.md) troubleshooting and the refusal codes;
- existing issues.

A useful bug report contains:

1. **Environment**: OS and version, Linux session type (`echo "$XDG_SESSION_TYPE $DISPLAY"`), desktop environment, DSH version, plugin version/commit, Node version, and whether the plugin is a `link:` dev mount or a GitHub install.
2. **What you did**: the exact tool calls (`computer_screenshot` / `computer` with action and intent), and whether the capability switch was on.
3. **What happened**: the refusal `code`, `message`, `guidance`, and the output of `computer { "action": "inputcheck" }`.
4. **What you expected**.
5. **Evidence**: the relevant tail of `~/.dsh/computer-use/audit.jsonl`. Redact session ids, window titles, paths and anything private.
6. **Screenshots** only if they help: crop/redact them first. Never post screenshots containing credentials, customer data or personal information.

For a **security** issue (token/proof/guard/pause bypass, unintended input, information leak, access-control problem), **do not open a public issue** — follow [SECURITY.md](docs/SECURITY.md).

For a **packaging** issue, include the install command, the profile, and whether `client.web.js` was present in the installed package.

## Feature requests

Describe the use case and the safety impact. "Make the agent click faster" is not a feature request we can evaluate; "support a different screenshot fallback on X11" or "add an audit field for the monitor id" is. Explicitly say whether the change would weaken any invariant (token, stale proof, approval, pause, DSH-window guard, capability gate).

## Development environment

- Node.js ≥ 22.
- No dependencies: do not run `npm install` and do not add `node_modules`; everything runs with plain `node`.
- Linux backend work needs an X11 session (or Xvfb with a window manager) and the packages listed in [docs/PLATFORMS.md](docs/PLATFORMS.md).
- Windows work can be statically tested anywhere; real Windows validation is a bonus and should be described honestly in the PR.
- Local profile setup, build and release details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Test requirements

Every pull request must pass the offline suites:

```bash
node tests/adapter-selftest.mjs
node backends/selftest.mjs
node tests/windows-mode-selftest.mjs
```

If you change the Linux backend, the adapter, tool wiring or the observation/guard flow, also run the real-X11 integration suite on an X11 session:

```bash
node tests/linux-integration.mjs
```

and say in the PR whether it passed, was partially skipped, or could not be run (and why). If you change Windows dispatch code, update `tests/windows-mode-selftest.mjs`; if you cannot run it on real Windows, say so explicitly.

Please add tests with behaviour changes:

- pure helpers → `backends/selftest.mjs` / `tests/adapter-selftest.mjs`;
- platform-facing schema/descriptions → `tests/windows-mode-selftest.mjs`;
- end-to-end flow, tokens, routes, guards → `tests/linux-integration.mjs`.

Do not make tests type/click arbitrary live windows without an explicit flag; the default suite must stay non-destructive.

## Pull requests

1. Fork the repository and create a focused branch (`fix/stale-proof`, `docs/platform-notes`, …).
2. Keep commits small and intentional; do not mix refactors with behaviour changes.
3. If you change `client.js`, regenerate and commit `client.web.js`:
   ```bash
   node scripts/build-client.mjs
   ```
   Never hand-edit the generated bundle.
4. If you change a safety invariant, update [`backends/CONTRACT.md`](backends/CONTRACT.md) and explain the trade-off. Do not weaken stale-proofing, pause re-checks, monitor-bounds validation, approval routing, the DSH-window guard or the fail-closed backend selection without a discussion first.
5. Update the user documentation when behaviour, arguments, defaults or platform support change (`README.md`, `docs/*`, `CHANGELOG.md`).
6. Verify the package still contains what users need: `npm pack --dry-run` (no dependencies, so this is quick). If you add a distribution file outside the `files` whitelist, update `package.json` in the same PR.
7. Do not commit secrets, personal paths, `.e2e-dsh-home/`, `.winmode-dsh-home/`, screenshots, audit logs, `node_modules/`, tarballs or editor state.

Maintainers may ask for a narrower change, additional tests, or a benchmark if the change touches the per-step re-proof cost.

## Suggested commit messages

Conventional-ish, imperative, scoped:

```
feat(linux): support a forced capture tool via DSH_COMPUTER_USE_CAPTURE
fix(win32): keep the staged helper path stable across captures
docs: add the platform support matrix
test: cover sequence text-budget rejection
ci: run the X11 integration suite under openbox
chore(release): v1.6.0
```

- Keep the subject line ≤ 72 characters; use the body to explain **why**, not what the diff already says.
- Reference issues (`Fixes #12`) when applicable.
- For a release, include the version bump and the `CHANGELOG.md` entry in the same commit/tag.

## Licensing

By contributing, you agree that your contribution is licensed under the repository's MIT license (see [LICENSE](LICENSE)).

## Related documents

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, build, release.
- [docs/TESTING.md](docs/TESTING.md) — test layers and CI.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design and invariants.
- [docs/SECURITY.md](docs/SECURITY.md) — private vulnerability reporting.

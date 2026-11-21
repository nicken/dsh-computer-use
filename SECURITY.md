# Security Policy

This plugin controls a real desktop: screenshots, mouse and keyboard input. The threat model,
approval flow and safe-deployment guidance live in [docs/SECURITY.md](docs/SECURITY.md). Read it
before running the plugin on a machine that holds data you care about; a dedicated VM or desktop
session is strongly recommended.

If you believe you have found a vulnerability, please **do not open a public issue**. Contact the
maintainer privately (open a GitHub security advisory on this repository, or email the address in
the repository profile) with:

- affected version/commit and platform (Linux/X11 or Windows),
- a minimal reproduction (tool calls, `policy.json`, relevant audit lines without secrets),
- the impact you believe it has.

Please allow a reasonable disclosure window before publishing details.

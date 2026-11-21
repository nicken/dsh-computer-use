/**
 * Backend selection for dsh-computer-use.
 *
 * `index.js` keeps the platform-agnostic tool layer (observation tokens, intent
 * validation, risk grading, audit, pause). This selector picks the desktop
 * implementation for the running host:
 *
 *   win32  -> `windows-native`  (PowerShell 5.1 + C# P/Invoke, lives in index.js)
 *   linux  -> `linux-x11`       (xdotool / scrot / xprop, in linux-x11.mjs + linux-adapter.mjs)
 *   other  -> `unsupported`     (tools refuse with a clear message)
 *
 * Linux only counts as supported when the process actually sees an X11 session:
 * Wayland has no global input injection and no global foreground window, and an
 * empty DISPLAY means DSH was not started from the desktop session. Failing
 * closed here is better than letting every tool call surface a raw scrot/xrandr
 * error. (XWayland is not enough: input would reach only XWayland clients.)
 *
 * The Windows implementation still lives inside index.js (CONTRACT.md step 4.1
 * tracks the move to backends/win32.mjs). Only the selection and the Linux
 * glue are new, so the Windows behavior stays byte-for-byte what it was.
 */

function linuxSupport() {
  const sessionType = String(process.env.XDG_SESSION_TYPE ?? '').trim().toLowerCase()
  const display = String(process.env.DISPLAY ?? '').trim()
  const waylandDisplay = String(process.env.WAYLAND_DISPLAY ?? '').trim()
  if (sessionType === 'wayland') {
    return {
      ok: false,
      name: 'wayland-unsupported',
      label: 'Wayland',
      reason: display === ''
        ? 'Wayland is not supported: there is no global X11 display and Wayland has no portable input injection'
        : 'Wayland session detected (XWayland display is set): injected X11 input would reach only XWayland clients, so desktop control is refused',
    }
  }
  if (display === '') {
    return {
      ok: false,
      name: 'x11-display-missing',
      label: 'X11 (no DISPLAY)',
      reason: waylandDisplay === ''
        ? 'DISPLAY is empty: DSH was not started from an X11 desktop session'
        : `DISPLAY is empty but WAYLAND_DISPLAY="${waylandDisplay}": this is a Wayland session, which this backend cannot drive`,
    }
  }
  return { ok: true }
}

export function selectBackend() {
  if (process.platform === 'win32') {
    return { kind: 'win32', name: 'windows-native', label: 'Windows', supported: true }
  }
  if (process.platform === 'linux') {
    const support = linuxSupport()
    if (support.ok) {
      return { kind: 'linux-x11', name: 'linux-x11', label: 'X11', supported: true }
    }
    return { kind: 'unsupported', name: support.name, label: support.label, supported: false, reason: support.reason }
  }
  return {
    kind: 'unsupported',
    name: `unsupported-${process.platform}`,
    label: process.platform,
    supported: false,
    reason: `the ${process.platform} platform is not supported yet`,
  }
}

#!/usr/bin/env python3
"""dsh-computer-use — X11 emergency-brake hotkey watcher.

Spawns as a hidden child of the DSH host, grabs the first available hotkey on
the root window (python3-Xlib's grab_key), and writes the pause file when the
key is pressed. It exits when the host process disappears or when a stop file
names this host's pid, mirroring the Windows PowerShell brake.

Usage (spawned by index.js, not by hand):
  python3 x11-hotkey.py <pausePath> <statusPath> <stopPath> <parentPid> <combosJson>

combosJson: [{"name": "Ctrl+Alt+Shift+Q", "keysym": "q", "modifiers": ["control", "shift", "alt"]}]
"""

import json
import os
import select
import signal
import sys

from Xlib import X, XK, display
from Xlib import error as xerror


MODIFIER_MASKS = {
    "control": X.ControlMask,
    "shift": X.ShiftMask,
    "alt": X.Mod1Mask,
    "super": X.Mod4Mask,
}

STOP = False


def _on_signal(_signum, _frame):
    global STOP
    STOP = True


def write_json(path, value):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(value) + "\n")
    os.replace(tmp, path)


def parent_alive(pid):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main():
    if len(sys.argv) < 6:
        print("usage: x11-hotkey.py <pause> <status> <stop> <parentPid> <combosJson>", file=sys.stderr)
        return 2
    pause_path, status_path, stop_path = sys.argv[1:4]
    parent_pid = int(sys.argv[4])
    combos = json.loads(sys.argv[5])

    d = display.Display()
    root = d.screen().root
    grabbed = []
    registered = None

    # python-xlib reports protocol errors (e.g. BadAccess from another client
    # already holding the chord) asynchronously; collect them so a failed combo
    # can be detected and the next candidate tried synchronously.
    protocol_errors = []

    def on_protocol_error(protocol_error, _request):
        protocol_errors.append(protocol_error)

    d.set_error_handler(on_protocol_error)

    for combo in combos:
        keycode = d.keysym_to_keycode(XK.string_to_keysym(combo["keysym"]))
        if keycode == 0:
            continue
        mask = 0
        for name in combo.get("modifiers", []):
            mask |= MODIFIER_MASKS.get(name, 0)
        # A real keypress also carries the Lock/NumLock modifier bits, so the
        # same chord must be grabbed once per lock-state variant; otherwise the
        # grab silently never matches while NumLock is on.
        variants = [
            mask,
            mask | X.LockMask,
            mask | X.Mod2Mask,
            mask | X.LockMask | X.Mod2Mask,
        ]
        protocol_errors.clear()
        attempted = []
        ok = False
        try:
            for variant in variants:
                root.grab_key(keycode, variant, True, X.GrabModeAsync, X.GrabModeAsync)
                attempted.append(variant)
            d.sync()
            ok = len(protocol_errors) == 0
        except Exception:
            ok = False
        if ok:
            grabbed.extend((keycode, variant) for variant in attempted)
            registered = combo
            break
        # Someone else owns this chord (BadAccess): release what this client may
        # have obtained and try the next candidate.
        protocol_errors.clear()
        try:
            for variant in attempted:
                root.ungrab_key(keycode, variant)
            d.sync()
        except Exception:
            pass
        protocol_errors.clear()
        continue

    write_json(
        status_path,
        {
            "processId": os.getpid(),
            "registered": registered is not None,
            "combination": registered["name"] if registered else "",
            "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        },
    )

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, _on_signal)

    try:
        while not STOP:
            if not parent_alive(parent_pid):
                break
            if os.path.exists(stop_path):
                try:
                    with open(stop_path, "r", encoding="utf-8") as handle:
                        owner = handle.read().strip()
                except OSError:
                    owner = ""
                if owner in ("", str(parent_pid)):
                    try:
                        os.remove(stop_path)
                    except OSError:
                        pass
                    break
            ready, _, _ = select.select([d.fileno()], [], [], 0.2)
            if not ready:
                continue
            while d.pending_events():
                event = d.next_event()
                if event.type == X.KeyPress:
                    write_json(
                        pause_path,
                        {
                            "paused": True,
                            "reason": "hotkey",
                            "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
                            "by": "emergency-hotkey",
                        },
                    )
    finally:
        for keycode, mask in grabbed:
            try:
                root.ungrab_key(keycode, mask)
            except Exception:
                pass
        try:
            d.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

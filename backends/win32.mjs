/**
 * dsh-computer-use — Windows / Win32 backend.
 *
 * Everything that needs a Windows host lives here: the in-memory C# P/Invoke
 * helper (SendInput, foreground window, DPI awareness), the PowerShell staging
 * that runs it, monitor enumeration and screenshot capture. The platform-
 * agnostic tool layer in index.js keeps observation tokens, intent/risk policy,
 * audit, pause and the provider slot.
 *
 * Capture follows the same contract as Linux/X11: one monitor (or the whole
 * virtual desktop with `screen: "all"`), an optional monitor-local `region`
 * crop and an optional `scale`. Action coordinates stay desktop-global on
 * Windows, so the screenshot reports `originX`/`originY` for conversion.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ACTION_TIMEOUT_MS = 45_000

export const name = 'windows-native'

function messageOf(error) {
  return error && typeof error.message === 'string' && error.message ? error.message : String(error)
}

function dshHomeDirectory() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function dataDirectory() {
  return join(dshHomeDirectory(), 'computer-use')
}

function helperDirectory() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'dsh-computer-use', 'helper')
}

export const CSHARP_HELPER = String.raw`using System;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CuNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return input;
  }

  static INPUT MouseInput(uint flags, int dx, int dy, int data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dx = dx;
    input.u.mi.dy = dy;
    input.u.mi.dwFlags = flags;
    input.u.mi.mouseData = unchecked((uint)data);
    return input;
  }

  static void ScreenPoint(int x, int y, out int ax, out int ay) {
    int vx = GetSystemMetrics(76);
    int vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78);
    int vh = GetSystemMetrics(79);
    ax = (int)Math.Round((double)(x - vx) * 65535.0 / Math.Max(1, vw - 1));
    ay = (int)Math.Round((double)(y - vy) * 65535.0 / Math.Max(1, vh - 1));
  }

  static void Send(params INPUT[] inputs) {
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void KeyDown(ushort vk) { keybd_event((byte)vk, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(ushort vk) { keybd_event((byte)vk, 0, 0x0002, UIntPtr.Zero); }

  public static void TypeText(string text) {
    foreach (char ch in text) {
      Send(
        KeyInput(0, (ushort)ch, KEYEVENTF_UNICODE),
        KeyInput(0, (ushort)ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
      );
      Thread.Sleep(4);
    }
  }

  /** Absolute moves/click batches: a click never depends on the cursor surviving a move. */
  public static void MoveTo(int x, int y) {
    int ax, ay;
    ScreenPoint(x, y, out ax, out ay);
    Send(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0));
  }

  public static void ClickAt(int x, int y, int button, int count) {
    int ax, ay;
    ScreenPoint(x, y, out ax, out ay);
    uint down = button == 1 ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
    uint up = button == 1 ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
    for (int i = 0; i < count; i++) {
      Send(
        MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0),
        MouseInput(down, 0, 0, 0),
        MouseInput(up, 0, 0, 0)
      );
      Thread.Sleep(90);
    }
  }

  public static void ScrollAt(int x, int y, int delta) {
    int ax, ay;
    ScreenPoint(x, y, out ax, out ay);
    Send(
      MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0),
      MouseInput(MOUSEEVENTF_WHEEL, 0, 0, delta)
    );
  }

  public static void DragAt(int x1, int y1, int x2, int y2) {
    int ax1, ay1, ax2, ay2;
    ScreenPoint(x1, y1, out ax1, out ay1);
    ScreenPoint(x2, y2, out ax2, out ay2);
    Send(
      MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax1, ay1, 0),
      MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)
    );
    for (int step = 1; step <= 14; step++) {
      int ax = ax1 + (ax2 - ax1) * step / 14;
      int ay = ay1 + (ay2 - ay1) * step / 14;
      Send(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0));
      Thread.Sleep(18);
    }
    Send(MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0));
  }

  /** Foreground-window identity used by observation tokens. */
  public static long ForegroundHandle() { return GetForegroundWindow().ToInt64(); }

  public static string ForegroundTitle() {
    StringBuilder title = new StringBuilder(512);
    GetWindowTextW(GetForegroundWindow(), title, 512);
    return title.ToString();
  }

  public static string ForegroundProcess() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
    catch { return ""; }
  }

  public static string ForegroundRect() {
    RECT rect;
    if (!GetWindowRect(GetForegroundWindow(), out rect)) return "";
    return rect.Left + "," + rect.Top + "," + (rect.Right - rect.Left) + "," + (rect.Bottom - rect.Top);
  }

  const uint GA_ROOT = 2;

  /**
   * True when the window handle, its root window, its title or its process
   * belongs to DSH itself. DSH hosts install/authorization controls that a model
   * must never operate, so helpers check this immediately before dispatching.
   */
  public static bool IsDshWindow(IntPtr handle) {
    if (handle == IntPtr.Zero) return false;
    IntPtr root = GetAncestor(handle, GA_ROOT);
    if (root != IntPtr.Zero) handle = root;
    // The process name is the strong signal; the title only counts when the
    // product name is the whole title or its trailing "— DeepSeek Harness"
    // suffix, so a file or page that merely mentions the product stays usable.
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    try {
      string process = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
      if (process.Equals("DeepSeek Harness", StringComparison.OrdinalIgnoreCase)) return true;
    } catch { }
    StringBuilder title = new StringBuilder(512);
    GetWindowTextW(handle, title, 512);
    return Regex.IsMatch(title.ToString(), @"^\s*DeepSeek Harness\s*$|(?:—|–|-)\s*DeepSeek Harness\s*$");
  }

  /** The window that currently receives keyboard input is DSH itself. */
  public static bool DshWindowActive() { return IsDshWindow(GetForegroundWindow()); }

  /** The window that would receive a click at this screen point is DSH itself. */
  public static bool PointHitsDsh(int x, int y) {
    POINT point = new POINT();
    point.X = x;
    point.Y = y;
    return IsDshWindow(WindowFromPoint(point));
  }

  /** The window under the cursor is DSH itself (scroll anchors on the cursor). */
  public static bool DshWindowAtCursor() {
    POINT point = new POINT();
    GetCursorPos(out point);
    return IsDshWindow(WindowFromPoint(point));
  }

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength, out int returnLength);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, int index);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  /** Token integrity level RID: 0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system. */
  public static int IntegrityRid() {
    IntPtr token = IntPtr.Zero;
    IntPtr buffer = IntPtr.Zero;
    int length = 0;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) return -1;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
      if (length <= 0) return -1;
      buffer = Marshal.AllocHGlobal(length);
      int written;
      if (!GetTokenInformation(token, 25, buffer, length, out written)) return -1;
      IntPtr sid = Marshal.ReadIntPtr(buffer);
      if (sid == IntPtr.Zero) return -1;
      IntPtr countPointer = GetSidSubAuthorityCount(sid);
      if (countPointer == IntPtr.Zero) return -1;
      byte count = Marshal.ReadByte(countPointer);
      if (count == 0) return -1;
      IntPtr subAuthority = GetSidSubAuthority(sid, count - 1);
      if (subAuthority == IntPtr.Zero) return -1;
      return Marshal.ReadInt32(subAuthority);
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
    }
  }

  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);

  /** False when the workstation is locked or a secure desktop owns the input. */
  public static bool InputDesktopAvailable() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
    if (desktop == IntPtr.Zero) return false;
    CloseDesktop(desktop);
    return true;
  }

  /**
   * A locked workstation keeps the session's window station, so OpenInputDesktop
   * can still succeed while every injected event is discarded. The lock screen
   * itself is the reliable signal: its window belongs to LockApp or LogonUI.
   */
  public static bool DesktopLocked() {
    if (!InputDesktopAvailable()) return true;
    string process = ForegroundProcess();
    return process == "LockApp" || process == "LogonUI";
  }

  /** Dispatch one no-op absolute move to the current cursor position and report how many events landed. */
  public static int ProbeSend() {
    POINT cursor;
    if (!GetCursorPos(out cursor)) return -1;
    int ax, ay;
    ScreenPoint(cursor.X, cursor.Y, out ax, out ay);
    INPUT[] inputs = new INPUT[1];
    inputs[0] = MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0);
    return (int)SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
`

export const PS_PREAMBLE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$cs = @'
${CSHARP_HELPER}
'@
Add-Type -TypeDefinition $cs -Language CSharp
[CuNative]::SetProcessDPIAware() | Out-Null

function Get-Fingerprint([int]$left, [int]$top, [int]$width, [int]$height) {
  if ($width -lt 9 -or $height -lt 9) { return '' }
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
    $builder = New-Object System.Text.StringBuilder
    for ($row = 0; $row -lt 8; $row++) {
      for ($col = 0; $col -lt 8; $col++) {
        $px = [int]((($col + 0.5) * $width) / 8)
        $py = [int]((($row + 0.5) * $height) / 8)
        if ($px -ge $width) { $px = $width - 1 }
        if ($py -ge $height) { $py = $height - 1 }
        $pixel = $bitmap.GetPixel($px, $py)
        [void]$builder.Append($pixel.R.ToString('x2')).Append($pixel.G.ToString('x2')).Append($pixel.B.ToString('x2'))
      }
    }
    return $builder.ToString()
  } finally {
    $bitmap.Dispose()
  }
}

function Compare-Fingerprint([string]$expected, [string]$actual) {
  if ($expected.Length -ne $actual.Length -or $expected.Length -lt 6) { return 999 }
  $changed = 0
  for ($index = 0; $index -lt $expected.Length; $index += 6) {
    $dr = [Math]::Abs([Convert]::ToInt32($expected.Substring($index, 2), 16) - [Convert]::ToInt32($actual.Substring($index, 2), 16))
    $dg = [Math]::Abs([Convert]::ToInt32($expected.Substring($index + 2, 2), 16) - [Convert]::ToInt32($actual.Substring($index + 2, 2), 16))
    $db = [Math]::Abs([Convert]::ToInt32($expected.Substring($index + 4, 2), 16) - [Convert]::ToInt32($actual.Substring($index + 4, 2), 16))
    if ($dr -gt 40 -or $dg -gt 40 -or $db -gt 40) { $changed += 1 }
  }
  return $changed
}

function Get-Monitors {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $result = @()
  $index = 0
  foreach ($screen in $screens) {
    $result += @{
      index = $index
      id = [string]$screen.DeviceName
      primary = [bool]$screen.Primary
      x = [int]$screen.Bounds.X
      y = [int]$screen.Bounds.Y
      width = [int]$screen.Bounds.Width
      height = [int]$screen.Bounds.Height
    }
    $index++
  }
  return $result
}

function Capture-Observation([string]$path, $left = $null, $top = $null, $width = $null, $height = $null, [double]$scale = 1) {
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($null -eq $left) { $left = $virtual.Left }
  if ($null -eq $top) { $top = $virtual.Top }
  if ($null -eq $width -or [int]$width -le 0) { $width = $virtual.Width }
  if ($null -eq $height -or [int]$height -le 0) { $height = $virtual.Height }
  $captureLeft = [int]$left
  $captureTop = [int]$top
  $captureWidth = [int]$width
  $captureHeight = [int]$height
  if ($scale -le 0) { $scale = 1 }
  $bitmap = New-Object System.Drawing.Bitmap $captureWidth, $captureHeight
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($captureLeft, $captureTop, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
    $handle = [string][CuNative]::ForegroundHandle()
    $title = [CuNative]::ForegroundTitle()
    $process = [CuNative]::ForegroundProcess()
    $rect = [CuNative]::ForegroundRect()
    $fingerprint = ''
    $parts = $rect.Split(',')
    if ($parts.Length -eq 4) {
      $winLeft = [int]$parts[0]
      $winTop = [int]$parts[1]
      $winWidth = [int]$parts[2]
      $winHeight = [int]$parts[3]
      $inside = $winWidth -gt 8 -and $winHeight -gt 8 -and $winLeft -ge $captureLeft -and $winTop -ge $captureTop -and ($winLeft + $winWidth) -le ($captureLeft + $captureWidth) -and ($winTop + $winHeight) -le ($captureTop + $captureHeight)
      if ($inside) {
        $builder = New-Object System.Text.StringBuilder
        for ($row = 0; $row -lt 8; $row++) {
          for ($col = 0; $col -lt 8; $col++) {
            $gx = $winLeft - $captureLeft + [int]((($col + 0.5) * $winWidth) / 8)
            $gy = $winTop - $captureTop + [int]((($row + 0.5) * $winHeight) / 8)
            if ($gx -ge $captureWidth) { $gx = $captureWidth - 1 }
            if ($gy -ge $captureHeight) { $gy = $captureHeight - 1 }
            $pixel = $bitmap.GetPixel($gx, $gy)
            [void]$builder.Append($pixel.R.ToString('x2')).Append($pixel.G.ToString('x2')).Append($pixel.B.ToString('x2'))
          }
        }
        $fingerprint = $builder.ToString()
      }
    }
    if ($scale -ne 1) {
      $scaledWidth = [Math]::Max(1, [int][Math]::Round($captureWidth * $scale))
      $scaledHeight = [Math]::Max(1, [int][Math]::Round($captureHeight * $scale))
      $scaled = New-Object System.Drawing.Bitmap $scaledWidth, $scaledHeight
      $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
      try {
        $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $scaledGraphics.DrawImage($bitmap, 0, 0, $scaledWidth, $scaledHeight)
      } finally { $scaledGraphics.Dispose() }
      $bitmap.Dispose()
      $bitmap = $scaled
    }
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $cursor = New-Object CuNative+POINT
    [CuNative]::GetCursorPos([ref]$cursor) | Out-Null
    return @{
      path = $path
      width = [int]$bitmap.Width
      height = [int]$bitmap.Height
      originX = $captureLeft
      originY = $captureTop
      scale = $scale
      cursor = @{ x = [int]$cursor.X; y = [int]$cursor.Y }
      foreground = @{ title = $title; process = $process; handle = $handle; rect = $rect }
      handle = $handle
      rect = $rect
      fingerprint = $fingerprint
    }
  } finally {
    $bitmap.Dispose()
  }
}
`

export function powershellExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const absolute = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(absolute) ? absolute : 'powershell.exe'
}

export function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

let resolvedHelperDirectory = null

/**
 * Resolve the staged helper directory once. A failed creation is NOT cached as
 * success: it falls back to the data directory, and `inputcheck` reports the
 * directory that is actually in use (so a staging problem stays visible).
 */
export function ensureHelperDirectory() {
  if (resolvedHelperDirectory !== null) return resolvedHelperDirectory
  const preferred = helperDirectory()
  try {
    mkdirSync(preferred, { recursive: true })
    resolvedHelperDirectory = preferred
  } catch {
    const fallback = join(dataDirectory(), 'helper')
    try {
      mkdirSync(fallback, { recursive: true })
    } catch {
      // Last resort: the caller's spawn will surface the real failure.
    }
    resolvedHelperDirectory = fallback
  }
  return resolvedHelperDirectory
}

let scriptCounter = 0

/**
 * Run one helper script. The script (preamble + C# source included) is longer
 * than the Windows command-line limit allows inside `-EncodedCommand`, so it is
 * staged as a UTF-8 (BOM) `.ps1` in `%LOCALAPPDATA%` and executed with `-File`:
 * that both stays under the limit and guarantees a correct encoding for window
 * titles that are not ASCII.
 */
export async function runPowerShell(body, options = {}) {
  const script = `\uFEFF${PS_PREAMBLE}\n${body}\n`
  scriptCounter += 1
  const path = join(ensureHelperDirectory(), `run-${process.pid}-${scriptCounter}.ps1`)
  writeFileSync(path, script, 'utf8')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path]
  try {
    const { stdout } = await execFileAsync(powershellExecutable(), args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || ACTION_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
      cwd: ensureHelperDirectory(),
    })
    return decodeResult(stdout)
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const message = stderr || messageOf(error)
    throw new Error(`Windows input helper failed: ${message.slice(0, 2_000)}`)
  } finally {
    try {
      unlinkSync(path)
    } catch {
      // A leftover staged script is harmless; the directory is private.
    }
  }
}

export function decodeResult(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) throw new Error('Windows input helper returned no output')
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // Keep scanning: Add-Type can leave diagnostics on stdout in unusual hosts.
    }
  }
  throw new Error(`Windows input helper returned an unreadable result: ${text.slice(0, 500)}`)
}


/* ------------------------------------------------------------------ */
/* monitors (WinForms Screen.AllScreens via the PowerShell preamble)   */
/* ------------------------------------------------------------------ */

/** Normalize the helper's monitor payload; pure so it runs without Windows. */
export function parseMonitorJson(value) {
  const payload = typeof value === 'string' ? JSON.parse(value) : value
  // PowerShell 5.1 can unwrap a one-element array into a bare object, so accept
  // both shapes instead of declaring a single-monitor desktop "no monitors".
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.monitors)
      ? payload.monitors
      : payload?.monitors && typeof payload.monitors === 'object'
        ? [payload.monitors]
        : payload && typeof payload === 'object' && payload.width !== undefined
          ? [payload]
          : []
  return list.map((entry, index) => ({
    index: Number.isInteger(entry?.index) ? entry.index : index,
    id: String(entry?.id ?? `DISPLAY${index + 1}`),
    primary: entry?.primary === true,
    x: Number(entry?.x) || 0,
    y: Number(entry?.y) || 0,
    width: Math.max(1, Number(entry?.width) || 0),
    height: Math.max(1, Number(entry?.height) || 0),
  }))
}

function normalizeDeviceName(value) {
  // `\\.\DISPLAY1` and `DISPLAY1` are the same monitor.
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Bounding box of every monitor, for `screen: "all"` (the legacy capture). */
export function virtualScreen(screens = []) {
  const list = Array.isArray(screens) && screens.length > 0 ? screens : [{ x: 0, y: 0, width: 1, height: 1 }]
  const left = Math.min(...list.map((screen) => screen.x))
  const top = Math.min(...list.map((screen) => screen.y))
  const right = Math.max(...list.map((screen) => screen.x + screen.width))
  const bottom = Math.max(...list.map((screen) => screen.y + screen.height))
  return { index: -1, id: 'virtual', primary: false, x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Resolve the Windows `screen` selector. Omitted/`auto` -> primary monitor;
 * `all` -> the whole virtual desktop (pre-1.5 default); otherwise a monitor id
 * (with or without the `\\.\` prefix) or its index.
 */
export function selectScreen(screens, screenId) {
  const list = Array.isArray(screens) ? screens : []
  if (list.length === 0) throw new Error('Windows reported no monitors')
  const wanted = screenId === undefined || screenId === null ? '' : String(screenId).trim()
  const keyword = wanted.toLowerCase()
  if (keyword === 'all' || keyword === 'virtual') return virtualScreen(list)
  if (wanted === '' || keyword === 'auto') return list.find((screen) => screen.primary) ?? list[0]
  const byId = list.find((screen) => normalizeDeviceName(screen.id) === normalizeDeviceName(wanted))
  if (byId !== undefined) return byId
  const index = Number(wanted)
  if (Number.isInteger(index)) {
    const byIndex = list.find((screen) => screen.index === index)
    if (byIndex !== undefined) return byIndex
  }
  const detected = list.map((screen) => `${screen.id} (${screen.width}x${screen.height} at ${screen.x},${screen.y})`)
  throw new Error(`unknown screen "${wanted}"; detected monitors: ${detected.join(', ')}`)
}

export function publicScreen(screen) {
  return {
    id: screen.id,
    index: screen.index,
    primary: screen.primary === true,
    x: screen.x,
    y: screen.y,
    width: screen.width,
    height: screen.height,
  }
}

/**
 * Turn the optional monitor-local region/scale into the rectangle to capture.
 * Output coordinates are desktop-global (what Win32 capture and input use).
 */
export function captureArea(screen, region, scale) {
  const ratio = scale === undefined || scale === null ? 1 : Number(scale)
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('"scale" must be a positive number')
  if (region === undefined || region === null) {
    return {
      left: screen.x,
      top: screen.y,
      width: screen.width,
      height: screen.height,
      scale: ratio,
      originX: screen.x,
      originY: screen.y,
      region: null,
    }
  }
  if (typeof region !== 'object' || Array.isArray(region)) throw new Error('"region" must be an object')
  const x = Math.round(Number(region.x))
  const y = Math.round(Number(region.y))
  const width = Math.round(Number(region.width))
  const height = Math.round(Number(region.height))
  if ([x, y, width, height].some((value) => !Number.isFinite(value))) {
    throw new Error('"region" needs finite x, y, width and height')
  }
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > screen.width || y + height > screen.height) {
    throw new Error(`"region" is outside the ${screen.width}x${screen.height} monitor`)
  }
  return {
    left: screen.x + x,
    top: screen.y + y,
    width,
    height,
    scale: ratio,
    originX: screen.x + x,
    originY: screen.y + y,
    region: { x, y, width, height, ...(ratio !== 1 ? { scale: ratio } : {}) },
  }
}

export async function listScreens() {
  const output = await runPowerShell('$monitors = @(Get-Monitors); @{ monitors = $monitors } | ConvertTo-Json -Compress -Depth 6')
  const screens = parseMonitorJson(output)
  if (screens.length === 0) throw new Error('Windows reported no monitors')
  if (!screens.some((screen) => screen.primary)) screens[0].primary = true
  return screens
}

/**
 * Capture one monitor (or the virtual desktop / a region of it) to `path` and
 * return the same observation shape the Linux backend returns. Windows action
 * coordinates stay desktop-global, so `cursor` is global and `originX/originY`
 * let a caller convert an on-image position.
 */
export async function capture({ path, screenId, region, scale }) {
  const screens = await listScreens()
  const screen = selectScreen(screens, screenId)
  const area = captureArea(screen, region, scale)
  const body = [
    `$capture = Capture-Observation '${psQuote(path)}' ${area.left} ${area.top} ${area.width} ${area.height} ${area.scale}`,
    '$capture | ConvertTo-Json -Compress -Depth 8',
  ].join('\n')
  const output = await runPowerShell(body)
  const fingerprint = String(output.fingerprint ?? '')
  return {
    path: String(output.path ?? path),
    width: Number(output.width) || 0,
    height: Number(output.height) || 0,
    originX: Number(output.originX) || area.originX,
    originY: Number(output.originY) || area.originY,
    cursor: { x: Number(output.cursor?.x) || 0, y: Number(output.cursor?.y) || 0 },
    foreground: {
      title: String(output.foreground?.title ?? ''),
      process: String(output.foreground?.process ?? ''),
      handle: String(output.foreground?.handle ?? output.handle ?? ''),
      rect: String(output.foreground?.rect ?? output.rect ?? ''),
    },
    fingerprint,
    fingerprintTarget: fingerprint === '' ? 'none' : 'window',
    screen: publicScreen(screen),
    screens: screens.map(publicScreen),
    ...(area.region === null ? {} : { region: area.region }),
  }
}

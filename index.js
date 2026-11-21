/**
 * Windows-native computer-use provider, plus a Linux/X11 backend.
 *
 * Registers the process's sole `computerUse` provider slot and contributes two
 * model-facing tools:
 *  - `computer_screenshot` captures the desktop (the whole Windows desktop, or
 *    one X11 monitor) to a PNG and returns its path, screen geometry, cursor,
 *    foreground window and a single-use observation token (`state_id`).
 *  - `computer` performs real input on the user's desktop behind that token:
 *    move / click / double_click / right_click / drag / scroll / type / key,
 *    plus the flow actions wait, sequence, inputcheck and pause.
 *
 * Platform split (see backends/index.mjs): the tool layer, observation tokens,
 * intent/risk policy, audit and pause are platform-agnostic; the desktop
 * primitives are `windows-native` (PowerShell + C# P/Invoke, implemented below)
 * or `linux-x11` (`backends/linux-x11.mjs` + `backends/linux-adapter.mjs`).
 *
 * Design rules (phase 1 hardening):
 *  - Observe -> one action -> observe. An observation token binds the foreground
 *    window identity (handle, title, bounds) and a sampled pixel fingerprint of
 *    that window; the token is consumed by the first input action and the
 *    dispatch path re-proves the state immediately before dispatching, so a
 *    changed screen yields a guiding `stale_observation` refusal instead of a
 *    blind click.
 *  - Every input action requires a declared `intent`; risky intents are graded
 *    and must pass `ctx.approval` (which fails closed when the session policy is
 *    `never`), and every attempt is appended to an audit JSONL.
 *  - A physical brake: on Windows a hidden PowerShell process registers a global
 *    hotkey and writes a pause file that every dispatch consults. Only the user
 *    can release the pause (the status route the UI uses); the model cannot
 *    resume itself. On Linux the pause file is written by the UI/`pause` action
 *    and by the DSH status route (no global hotkey: X11 has no portable
 *    application-level hotkey without depending on a window manager hook).
 *  - The Windows helper runs from a staged `%LOCALAPPDATA%` directory because
 *    helpers started from the Low-integrity workspace directory silently lose
 *    `SendInput`; `inputcheck` reports the staging path, integrity, locked
 *    desktop, dispatch confirmation and pointer drift.
 *
 * Everything Windows-specific runs through Windows PowerShell 5.1 with an
 * in-memory C# P/Invoke helper (`SendInput`, DPI awareness, foreground-window
 * facts, token integrity); each call is one short-lived PowerShell process and
 * results are JSON.
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { selectBackend } from './backends/index.mjs'
import * as linuxAdapter from './backends/linux-adapter.mjs'
import * as win32 from './backends/win32.mjs'
import { ensureHelperDirectory, powershellExecutable, psQuote, runPowerShell } from './backends/win32.mjs'

export const name = 'computer-use'

/** Tools are the capability; the computer-use seam is reserved when this profile mounts it. */
export const inject = ['tools']

const backend = selectBackend()
const LINUX = backend.kind === 'linux-x11'
const UNSUPPORTED = !backend.supported
/** How the tool descriptions name the desktop, so Windows wording is unchanged. */
const DESKTOP_LABEL = backend.label

const PROVIDER_NAME = LINUX ? 'x11-native' : backend.kind === 'win32' ? 'windows-native' : backend.name
const ACTION_TIMEOUT_MS = 45_000

const MAX_TYPE_LENGTH = 4_000
const MAX_SEQUENCE_STEPS = 20
const MAX_SEQUENCE_TEXT = 8_000
const KEEP_SCREENSHOTS = 60
const OBSERVATION_TTL_MS = 120_000
const MAX_OBSERVATIONS = 200
const FINGERPRINT_CELLS = 8
const FINGERPRINT_TOLERANCE = 8
/** Limits handed to the Linux adapter so both platforms enforce the same rules. */
const LINUX_LIMITS = {
  maxTypeLength: MAX_TYPE_LENGTH,
  maxSequenceSteps: MAX_SEQUENCE_STEPS,
  maxSequenceText: MAX_SEQUENCE_TEXT,
}
const SHOT_ROUTE = '/api/computer-use/shot'
const STATUS_ROUTE = '/api/computer-use/status'
const CAPABILITY_ROUTE = '/api/computer-use/capability'
const SHOT_FILE_PATTERN = /^[A-Za-z0-9._-]+\.png$/
// Hotkey candidates. Never use Ctrl+Alt+F1..F12: those are X.org's built-in
// VT-switch bindings, so an un-grabbed press would black the display by
// switching virtual consoles. Everything here keeps Shift (or another
// non-VT modifier combination) pinned.
const HOTKEY_CANDIDATES = [
  { combination: 'Ctrl+Alt+Shift+Q', modifiers: 7, key: 0x51, keysym: 'q', x11Modifiers: ['control', 'shift', 'alt'] },
  {
    combination: 'Ctrl+Alt+Shift+F12',
    modifiers: 7 | 0x0400,
    key: 0x7b,
    keysym: 'F12',
    x11Modifiers: ['control', 'shift', 'alt'],
  },
]

// Provider-slot coexistence: `ctx.computerUse` is a single slot, so at most one
// computer-use plugin per process can own it. Our tools do not depend on it, so a
// conflict is reported instead of failing the plugin.
const PROVIDER_SLOT = 'computerUse'
const SELF_MODULE_NAME = '@local/dsh-computer-use'
const COMPETING_PROVIDER_RE = /computer[-_. ]?use|computer[-_. ]?control|windows[-_. ]?mcp|desktop[-_. ]?control/i
/** 'waiting' until the seam resolves, then 'registered' or 'conflict'. */
let providerSlotState = { status: 'waiting', error: '' }
/** The status route polls every 10s; the plugin list does not change that fast. */
const PROVIDER_ROW_CACHE_MS = 15_000
let competingProviderCache = { at: 0, context: null, rows: [] }

const INPUT_ACTIONS = ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key']
const ACTIVATING_ACTIONS = ['click', 'double_click', 'right_click', 'drag', 'type', 'key']
const ALL_ACTIONS = [...INPUT_ACTIONS, 'wait', 'sequence', 'inputcheck', 'pause']

const DEFAULT_RISK_INTENT =
  /\b(send|submit|delete|remove|purchase|buy|pay|payment|transfer|confirm|password|credential|format|wipe|shutdown|uninstall|install|overwrite|approve)\b|发送|提交|删除|移除|购买|支付|付款|转账|确认|密码|卸载|安装|格式化|关机|注销/i
const DEFAULT_RISK_APPS =
  /bank|banking|paypal|alipay|wechat\s*pay|wallet|broker|trading|outlook|thunderbird|foxmail|windows\s*mail|银行|证券|支付|转账|钱包|税务/i
const SYSTEM_KEY_COMBINATIONS = new Set(['alt+f4', 'ctrl+alt+del', 'ctrl+alt+delete', 'win+r'])

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Paths and small file helpers
// ---------------------------------------------------------------------------

function dshHomeDirectory() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function dataDirectory() {
  return join(dshHomeDirectory(), 'computer-use')
}

function screenshotsDirectory() {
  return join(dataDirectory(), 'shots')
}

/**
 * Helpers must not inherit the Low Mandatory Level of the workspace directory:
 * a child started from there can lose `SendInput` silently. Stage every helper
 * process in `%LOCALAPPDATA%`.
 */
function helperDirectory() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'dsh-computer-use', 'helper')
}

function pauseFilePath() {
  return join(dataDirectory(), 'pause.json')
}

function auditFilePath() {
  return join(dataDirectory(), 'audit.jsonl')
}

function policyFilePath() {
  return join(dataDirectory(), 'policy.json')
}

function brakeStatusFilePath() {
  return join(dataDirectory(), 'brake.json')
}

function brakeStopFilePath() {
  return join(dataDirectory(), 'brake.stop')
}

function readJsonFile(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}

function messageOf(error) {
  return error && typeof error.message === 'string' && error.message ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Per-conversation capability flag (shared with the MCP & skill manager)
// ---------------------------------------------------------------------------

/**
 * The per-conversation capability store is shared with the MCP & skill manager,
 * which owns the same file behind the in-conversation 能力 control:
 *
 *   { "version": 1, "sessions": { "<sessionId>": { "computerUse": true } } }
 *
 * That schema is a contract with the other owner, so this plugin only ever
 * touches `sessions.<id>.computerUse` and preserves every other top-level field,
 * session and flag. An unknown session or an unreadable store means "off":
 * computer use is opt-in.
 */
const CAPABILITY_STORE_NAME = 'capability-toggles.json'
/** Session ids are opaque DSH ids; reject anything that could escape the store. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function capabilityStorePath() {
  return join(dshHomeDirectory(), CAPABILITY_STORE_NAME)
}

/** Store skeleton, preserving unknown top-level keys and every session record. */
function readCapabilityStore() {
  const parsed = readJsonFile(capabilityStorePath())
  const store = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {}
  if (!Number.isFinite(store.version)) store.version = 1
  store.sessions =
    store.sessions && typeof store.sessions === 'object' && !Array.isArray(store.sessions) ? { ...store.sessions } : {}
  return store
}

/**
 * tmp + rename: the capability store is shared with another plugin, so a crash
 * or a second writer must never observe a half-written file (a truncated store
 * would silently switch every session's capabilities off).
 */
function writeCapabilityStoreAtomic(store) {
  const path = capabilityStorePath()
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist; the original error is what matters.
    }
    throw error
  }
}

function computerUseEnabledForSession(sessionId) {
  if (!sessionId) return false
  const store = readCapabilityStore()
  const record = store.sessions[sessionId]
  return record !== undefined && typeof record === 'object' && record.computerUse === true
}

function setComputerUseForSession(sessionId, enabled) {
  const store = readCapabilityStore()
  const existing = store.sessions[sessionId]
  const record = existing !== undefined && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
  record.computerUse = enabled === true
  store.sessions[sessionId] = record
  writeCapabilityStoreAtomic(store)
  return record.computerUse
}

function computerUseEnabled(agent) {
  try {
    return computerUseEnabledForSession(sessionIdOf(agent))
  } catch {
    return false
  }
}

function sessionIdOf(agent) {
  try {
    return agent && agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Pause (physical brake) state: a file's presence is the single source of truth
// ---------------------------------------------------------------------------

function readPause() {
  const path = pauseFilePath()
  if (!existsSync(path)) return { paused: false, detail: null }
  const detail = readJsonFile(path)
  return {
    paused: true,
    detail:
      detail && typeof detail === 'object'
        ? {
            reason: typeof detail.reason === 'string' ? detail.reason : 'user',
            at: typeof detail.at === 'string' ? detail.at : '',
            by: typeof detail.by === 'string' ? detail.by : '',
          }
        : { reason: 'user', at: '', by: '' },
  }
}

function writePause(reason, by) {
  mkdirSync(dataDirectory(), { recursive: true })
  writeJsonFile(pauseFilePath(), {
    paused: true,
    reason: typeof reason === 'string' && reason ? reason.slice(0, 120) : 'user',
    at: new Date().toISOString(),
    by: typeof by === 'string' && by ? by.slice(0, 120) : 'user',
  })
}

function clearPause() {
  try {
    unlinkSync(pauseFilePath())
  } catch {
    // Already released.
  }
}

// ---------------------------------------------------------------------------
// Audit trail (one JSON line per dispatch attempt; never stores typed text)
// ---------------------------------------------------------------------------

let lastActionRecord = null

function auditStats() {
  const path = auditFilePath()
  const stats = { actions: 0, refusals: 0, file: path }
  try {
    const size = statSync(path).size
    const length = Math.min(size, 4 * 1024 * 1024)
    const buffer = Buffer.alloc(length)
    const handle = openSync(path, 'r')
    try {
      readSync(handle, buffer, 0, length, size - length)
    } finally {
      closeSync(handle)
    }
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      stats.actions += 1
      if (entry && entry.ok === false) stats.refusals += 1
    }
  } catch {
    // No audit file yet.
  }
  return stats
}

function appendAudit(exec, action, args, result, risk) {
  const entry = {
    at: new Date().toISOString(),
    sessionId: sessionIdOf(exec && exec.agent) || null,
    callId: exec && typeof exec.callId === 'string' ? exec.callId : null,
    action,
    intent: typeof args?.intent === 'string' ? args.intent.slice(0, 120) : null,
    risk: risk && risk.level ? risk.level : null,
    ok: result?.ok !== false,
    code: typeof result?.code === 'string' ? result.code : null,
    x: Number.isFinite(args?.x) ? Math.round(args.x) : null,
    y: Number.isFinite(args?.y) ? Math.round(args.y) : null,
    toX: Number.isFinite(args?.toX) ? Math.round(args.toX) : null,
    toY: Number.isFinite(args?.toY) ? Math.round(args.toY) : null,
    keys: typeof args?.keys === 'string' ? args.keys.slice(0, 80) : null,
    textLength: typeof args?.text === 'string' ? args.text.length : null,
    steps: Array.isArray(args?.steps) ? args.steps.length : null,
  }
  try {
    mkdirSync(dataDirectory(), { recursive: true })
    appendFileSync(auditFilePath(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // The audit trail must never fail a dispatch.
  }
  lastActionRecord = entry
}

// ---------------------------------------------------------------------------
// Risk policy (defaults, optionally extended by policy.json)
// ---------------------------------------------------------------------------

function compileList(values) {
  if (!Array.isArray(values)) return null
  const patterns = []
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      patterns.push(new RegExp(value, 'i'))
    } catch {
      // Ignore an unparsable operator pattern.
    }
  }
  return patterns
}

function compilePatterns(values, fallback, replaceValues) {
  // `*Replace` lets an operator replace the built-in list instead of extending
  // it; `riskyIntent` / `riskyApp` append to the built-ins.
  const replacement = compileList(replaceValues)
  if (replacement !== null && replacement.length > 0) return replacement
  return [fallback, ...(compileList(values) ?? [])]
}

/**
 * Observation lifetime. 120s was too tight for a careful model loop over a slow
 * link, so it is configurable through policy.json (`observationTtlMs`) or the
 * DSH_COMPUTER_USE_OBSERVATION_TTL_MS env var; clamped to a sane range.
 */
function observationTtlMs() {
  const custom = readJsonFile(policyFilePath())
  const fromPolicy = Number(custom?.observationTtlMs)
  const fromEnv = Number(process.env.DSH_COMPUTER_USE_OBSERVATION_TTL_MS)
  const configured = Number.isFinite(fromPolicy) ? fromPolicy : fromEnv
  const value = Number.isFinite(configured) && configured > 0 ? configured : 180_000
  return Math.min(30 * 60_000, Math.max(5_000, Math.round(value)))
}

function readRiskPolicy() {
  const custom = readJsonFile(policyFilePath())
  return {
    intentPatterns: compilePatterns(custom?.riskyIntent, DEFAULT_RISK_INTENT, custom?.riskyIntentReplace),
    appPatterns: compilePatterns(custom?.riskyApp, DEFAULT_RISK_APPS, custom?.riskyAppReplace),
  }
}

/** The DSH window hosts install/authorization controls that must stay user-driven. */
const DSH_WINDOW_PATTERN = /deepseek harness/i

function targetsDshWindow(observation) {
  const title = typeof observation?.foreground?.title === 'string' ? observation.foreground.title : ''
  const process = typeof observation?.foreground?.process === 'string' ? observation.foreground.process : ''
  return DSH_WINDOW_PATTERN.test(title) || DSH_WINDOW_PATTERN.test(process)
}

function riskOf(action, args, observation) {
  if (!ACTIVATING_ACTIONS.includes(action) && action !== 'sequence') return { level: 'low', reason: '' }
  const policy = readRiskPolicy()
  const intent = typeof args?.intent === 'string' ? args.intent : ''
  if (intent && policy.intentPatterns.some((pattern) => pattern.test(intent))) {
    return { level: 'high', reason: 'intent matches a risky verb' }
  }
  if (action === 'sequence' && Array.isArray(args?.steps)) {
    const joined = args.steps.map((step) => String(step?.intent ?? '')).join(' ')
    if (joined && policy.intentPatterns.some((pattern) => pattern.test(joined))) {
      return { level: 'high', reason: 'a step intent matches a risky verb' }
    }
    for (const step of args.steps) {
      if (!step || step.action !== 'key') continue
      const combo = String(step.keys ?? '')
        .toLowerCase()
        .replace(/\s+/g, '')
      if (SYSTEM_KEY_COMBINATIONS.has(combo)) {
        return { level: 'high', reason: `a step uses the system-level key combination ${combo}` }
      }
    }
  }
  if (action === 'key') {
    const keys = String(args?.keys ?? '').toLowerCase().replace(/\s+/g, '')
    if (SYSTEM_KEY_COMBINATIONS.has(keys)) {
      return { level: 'high', reason: `key combination ${keys} is system level` }
    }
  }
  const surface =
    observation && observation.foreground
      ? `${observation.foreground.process || ''} ${observation.foreground.title || ''}`
      : ''
  if (surface && policy.appPatterns.some((pattern) => pattern.test(surface))) {
    return { level: 'high', reason: 'the active window looks like a financial, account or mail surface' }
  }
  return { level: 'low', reason: '' }
}

// ---------------------------------------------------------------------------
// Windows helper: C# P/Invoke compiled in-process by Add-Type, then one JSON result.
// ---------------------------------------------------------------------------

// Windows-native primitives (C# P/Invoke source, PowerShell staging, monitors and
// screenshots) live in backends/win32.mjs so the tool layer stays platform-agnostic.

const CSHARP_BRAKE = String.raw`using System;
using System.Runtime.InteropServices;

public static class CuBrake {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")]
  public static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  /**
   * Hold a synchronize handle on the host process: it outlives pid reuse, so the
   * watcher cannot be kept alive by a recycled process id.
   */
  public static IntPtr OpenHost(int pid) { return OpenProcess(0x00100000, false, pid); }

  public static bool HostExited(IntPtr handle) { return WaitForSingleObject(handle, 0) == 0; }
}
`

// ---------------------------------------------------------------------------
// Screenshots and observation tokens
// ---------------------------------------------------------------------------

function pruneScreenshots(directory) {
  try {
    const entries = readdirSync(directory)
      .filter((entry) => entry.toLowerCase().endsWith('.png'))
      .map((entry) => {
        const path = join(directory, entry)
        try {
          return { path, mtime: statSync(path).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.mtime - left.mtime)
    for (const stale of entries.slice(KEEP_SCREENSHOTS)) {
      try {
        unlinkSync(stale.path)
      } catch {
        // A screenshot that cannot be pruned is harmless.
      }
    }
  } catch {
    // Pruning must never fail a capture.
  }
}

function screenshotFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `shot-${stamp}-${randomBytes(2).toString('hex')}.png`
}

function screenshotPath() {
  mkdirSync(screenshotsDirectory(), { recursive: true })
  return join(screenshotsDirectory(), screenshotFileName())
}

/** One-shot observations keyed by token, plus the newest token per session. */
const observations = new Map()
const latestObservationBySession = new Map()

function rememberObservation(sessionId, capture) {
  const id = `obs_${randomBytes(6).toString('hex')}`
  const record = {
    id,
    sessionId,
    createdAt: Date.now(),
    used: false,
    path: String(capture.path ?? ''),
    width: Number(capture.width) || 0,
    height: Number(capture.height) || 0,
    originX: Number(capture.originX) || 0,
    originY: Number(capture.originY) || 0,
    foreground: {
      handle: String(capture.foreground?.handle ?? capture.handle ?? ''),
      title: String(capture.foreground?.title ?? ''),
      process: String(capture.foreground?.process ?? ''),
      rect: String(capture.foreground?.rect ?? capture.rect ?? ''),
    },
    fingerprint: String(capture.fingerprint ?? ''),
    // Linux/X11 observations are per-monitor; the action coordinates are local
    // to `screen`, and the adapter needs the monitor to clip the proof sample.
    ...(capture.screen ? { screen: capture.screen } : {}),
    ...(Array.isArray(capture.screens) ? { screens: capture.screens } : {}),
    // Linux/X11: 'window' | 'screen' | 'none' — which pixels the token binds.
    ...(capture.fingerprintTarget ? { fingerprintTarget: capture.fingerprintTarget } : {}),
  }
  observations.set(id, record)
  latestObservationBySession.set(sessionId, id)
  if (observations.size > MAX_OBSERVATIONS) {
    for (const [key, stale] of observations) {
      if (observations.size <= MAX_OBSERVATIONS) break
      observations.delete(key)
      // Keep the per-session pointer honest: a pruned newest token must not keep
      // older tokens of that session looking "superseded by" nothing.
      if (latestObservationBySession.get(stale.sessionId) === key) latestObservationBySession.delete(stale.sessionId)
    }
  }
  return record
}

function observationFragment(record) {
  return {
    state_id: record.id,
    path: record.path,
    width: record.width,
    height: record.height,
    originX: record.originX,
    originY: record.originY,
    // Linux/X11: which monitor these local coordinates belong to; `wait`
    // results and post-action observations otherwise look screen-less.
    ...(record.screen ? { screen: record.screen } : {}),
  }
}

async function captureScreenshot(screenId, region, scale) {
  if (LINUX) {
    const path = screenshotPath()
    try {
      const capture = await linuxAdapter.capture({ path, screenId, region, scale })
      pruneScreenshots(screenshotsDirectory())
      return capture
    } catch (error) {
      try {
        unlinkSync(path)
      } catch {
        // The failed capture may not have produced a file.
      }
      throw error
    }
  }
  if (UNSUPPORTED) throw new Error(`desktop screenshots are not available: ${backend.reason ?? `the ${process.platform} platform is not supported yet`}`)
  const path = screenshotPath()
  try {
    const capture = await win32.capture({ path, screenId, region, scale })
    pruneScreenshots(screenshotsDirectory())
    return capture
  } catch (error) {
    try {
      unlinkSync(path)
    } catch {
      // The failed capture may not have produced a file.
    }
    throw error
  }
}

/** Serve one captured PNG to the authenticated browser page (chat cards use it). */
async function serveScreenshot(request) {
  let file = ''
  try {
    file = new URL(request.url).searchParams.get('file') ?? ''
  } catch {
    return new Response('Bad Request', { status: 400 })
  }
  if (!SHOT_FILE_PATTERN.test(file)) return new Response('Not Found', { status: 404 })
  try {
    const bytes = await readFile(join(screenshotsDirectory(), file))
    const headers = { 'content-type': 'image/png', 'cache-control': 'no-store' }
    return request.method === 'HEAD' ? new Response(null, { status: 200, headers }) : new Response(bytes, { status: 200, headers })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

// ---------------------------------------------------------------------------
// Key handling and action scripts
// ---------------------------------------------------------------------------

const MODIFIER_KEYS = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
}

const NAMED_KEYS = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  arrowup: 0x26,
  arrowdown: 0x28,
  arrowleft: 0x25,
  arrowright: 0x27,
  capslock: 0x14,
  printscreen: 0x2c,
  win: 0x5b,
}

function resolveKey(token) {
  const lower = String(token).trim().toLowerCase()
  if (!lower) throw new Error('empty key in "keys"')
  if (MODIFIER_KEYS[lower] !== undefined) return MODIFIER_KEYS[lower]
  if (NAMED_KEYS[lower] !== undefined) return NAMED_KEYS[lower]
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(lower)) return lower.charCodeAt(0)
  const functionKey = /^f([1-9]|1[0-2])$/.exec(lower)
  if (functionKey) return 0x70 + Number(functionKey[1]) - 1
  throw new Error(`unknown key "${token}"`)
}

function requiredNumber(args, key) {
  const value = Number(args?.[key])
  if (!Number.isFinite(value)) throw new Error(`"${key}" is required and must be a number`)
  return Math.round(value)
}

function optionalNumber(args, key) {
  if (args?.[key] === undefined || args?.[key] === null || args?.[key] === '') return undefined
  const value = Number(args[key])
  if (!Number.isFinite(value)) throw new Error(`"${key}" must be a number`)
  return Math.round(value)
}

function keyComboScript(keys) {
  const parts = String(keys ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error('"keys" must name at least one key, for example "Ctrl+Shift+I"')
  const key = resolveKey(parts[parts.length - 1])
  const modifiers = parts.slice(0, -1).map((part) => {
    const vk = MODIFIER_KEYS[part.toLowerCase()]
    if (vk === undefined) throw new Error(`"${part}" is not a modifier; use Ctrl, Shift, Alt or Win`)
    return vk
  })
  const lines = []
  for (const modifier of modifiers) lines.push(`[CuNative]::KeyDown(${modifier})`)
  lines.push(`[CuNative]::KeyDown(${key})`, 'Start-Sleep -Milliseconds 40', `[CuNative]::KeyUp(${key})`)
  for (const modifier of [...modifiers].reverse()) lines.push(`[CuNative]::KeyUp(${modifier})`)
  return lines
}

/**
 * Translate one action (plus its arguments) into PowerShell statements that
 * perform it and a human description for the tool result.
 */
function actionScript(action, args) {
  switch (action) {
    case 'move': {
      const x = requiredNumber(args, 'x')
      const y = requiredNumber(args, 'y')
      return { lines: [`[CuNative]::MoveTo(${x}, ${y})`, 'Start-Sleep -Milliseconds 60'], detail: `moved the cursor to (${x}, ${y})` }
    }
    case 'click':
    case 'double_click':
    case 'right_click': {
      const x = requiredNumber(args, 'x')
      const y = requiredNumber(args, 'y')
      const button = action === 'right_click' ? 1 : 0
      const count = action === 'double_click' ? 2 : 1
      return {
        lines: [`[CuNative]::ClickAt(${x}, ${y}, ${button}, ${count})`],
        detail: `clicked ${count > 1 ? 'twice ' : ''}${button === 1 ? 'right' : 'left'} at (${x}, ${y})`,
      }
    }
    case 'drag': {
      const x = requiredNumber(args, 'x')
      const y = requiredNumber(args, 'y')
      const toX = requiredNumber(args, 'toX')
      const toY = requiredNumber(args, 'toY')
      return {
        lines: [`[CuNative]::DragAt(${x}, ${y}, ${toX}, ${toY})`],
        detail: `dragged from (${x}, ${y}) to (${toX}, ${toY})`,
      }
    }
    case 'scroll': {
      const delta = optionalNumber(args, 'delta') ?? -120
      const x = optionalNumber(args, 'x')
      const y = optionalNumber(args, 'y')
      const anchor =
        x !== undefined && y !== undefined
          ? `[CuNative]::ScrollAt(${x}, ${y}, ${delta})`
          : `$anchor = New-Object CuNative+POINT\n[CuNative]::GetCursorPos([ref]$anchor) | Out-Null\n[CuNative]::ScrollAt($anchor.X, $anchor.Y, ${delta})`
      return {
        lines: anchor.split('\n'),
        detail: `scrolled ${delta < 0 ? 'down' : 'up'} by ${Math.abs(delta)}${x !== undefined ? ` at (${x}, ${y})` : ''}`,
      }
    }
    case 'type': {
      const text = String(args?.text ?? '')
      if (!text) throw new Error('"text" is required for the type action')
      if (text.length > MAX_TYPE_LENGTH) throw new Error(`"text" is limited to ${MAX_TYPE_LENGTH} characters per call`)
      const encoded = Buffer.from(text, 'utf8').toString('base64')
      return {
        lines: [
          `$typed = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
          '[CuNative]::TypeText($typed)',
        ],
        detail: `typed ${text.length} character(s)`,
      }
    }
    case 'key': {
      const keys = String(args?.keys ?? '')
      return { lines: keyComboScript(keys), detail: `pressed ${keys}` }
    }
    default:
      throw new Error(`unsupported action "${action}"`)
  }
}

/**
 * PowerShell conditions that must all be false before one step may dispatch.
 * The Node side already refuses when the *observed* foreground is DSH, but the
 * helper repeats the proof immediately before dispatch: the foreground could
 * have changed, and a click could target a visible DSH window while another app
 * owns the foreground.
 */
function dispatchGuards(action, args) {
  const checks = []
  if (ACTIVATING_ACTIONS.includes(action)) checks.push('[CuNative]::DshWindowActive()')
  if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'drag') {
    const x = requiredNumber(args, 'x')
    const y = requiredNumber(args, 'y')
    checks.push(`[CuNative]::PointHitsDsh(${x}, ${y})`)
    if (action === 'drag') {
      const toX = requiredNumber(args, 'toX')
      const toY = requiredNumber(args, 'toY')
      checks.push(`[CuNative]::PointHitsDsh(${toX}, ${toY})`)
    }
  }
  if (action === 'scroll') {
    const x = optionalNumber(args, 'x')
    const y = optionalNumber(args, 'y')
    checks.push(
      x !== undefined && y !== undefined ? `[CuNative]::PointHitsDsh(${x}, ${y})` : '[CuNative]::DshWindowAtCursor()',
    )
  }
  return checks
}

function sequenceScript(steps, pausePath) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('"steps" must contain at least one step')
  if (steps.length > MAX_SEQUENCE_STEPS) throw new Error(`"steps" is limited to ${MAX_SEQUENCE_STEPS} steps per call`)
  let textBudget = 0
  const lines = ['$steps = @()', '$skipped = 0', '$blocked = $false', '$blockedStep = -1']
  const details = []
  for (const [index, step] of steps.entries()) {
    const stepAction = typeof step?.action === 'string' ? step.action.trim() : ''
    if (!INPUT_ACTIONS.includes(stepAction)) {
      throw new Error(`step ${index + 1}: action must be one of ${INPUT_ACTIONS.join(', ')}`)
    }
    if (step && (step.state_id !== undefined || step.steps !== undefined || step.action === 'sequence')) {
      throw new Error(`step ${index + 1}: a step cannot carry state_id, steps or nest sequence`)
    }
    if (typeof step?.text === 'string') textBudget += step.text.length
    const plan = actionScript(stepAction, step)
    const guards = dispatchGuards(stepAction, step)
    // Check the brake file between steps so an emergency stop also lands in the
    // middle of a batch instead of after it. A blocked step stops the batch: a
    // later step could otherwise activate the DSH window and click into it.
    lines.push(`if ($blocked) { } elseif (Test-Path -LiteralPath '${psQuote(pausePath)}') { $skipped += 1 } else {`)
    if (guards.length > 0) lines.push(`  if (${guards.join(' -or ')}) { $blocked = $true; $blockedStep = ${index + 1} } else {`)
    const pad = guards.length > 0 ? '    ' : '  '
    for (const line of plan.lines) lines.push(`${pad}${line}`)
    lines.push(`${pad}$steps += @{ action = '${psQuote(stepAction)}'; detail = '${psQuote(plan.detail)}' }`)
    lines.push(`${pad}Start-Sleep -Milliseconds 110`)
    if (guards.length > 0) lines.push('  }')
    lines.push('}')
    details.push(`${stepAction}: ${plan.detail}`)
  }
  if (textBudget > MAX_SEQUENCE_TEXT) {
    throw new Error(`the sequence carries ${textBudget} characters of text; the limit is ${MAX_SEQUENCE_TEXT}`)
  }
  return { lines, detail: details.join('; '), details: details.map((detail, index) => ({ action: steps[index].action, detail })) }
}

// ---------------------------------------------------------------------------
// Physical brake: a hidden global-hotkey watcher writes the pause file
// ---------------------------------------------------------------------------

function readBrakeStatus() {
  const status = readJsonFile(brakeStatusFilePath())
  if (!status || typeof status !== 'object') return null
  const processId = Number(status.processId) || null
  const alive = processAlive(processId)
  // A stale brake.json from a previous host process must not claim the hotkey is
  // available: the status surface only reports what is true right now.
  const registered = status.registered === true && alive
  return {
    combination: typeof status.combination === 'string' ? status.combination : '',
    registered,
    processId,
    alive,
    error: registered
      ? null
      : alive
        ? 'the emergency hotkey could not be registered (it may be held by another application)'
        : 'the emergency-brake watcher is not running',
  }
}

function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Status shown before/without a running X11 brake watcher. */
function linuxBrakeStatus() {
  return {
    combination: '',
    registered: false,
    processId: null,
    alive: false,
    platform: 'linux-x11',
    error:
      'the X11 emergency-brake helper is not running yet (it needs python3 with the Xlib module); pause from the DSH desktop tab instead',
  }
}

function brakeScript() {
  const candidates = HOTKEY_CANDIDATES.map(
    (candidate) =>
      `@{ combination = '${candidate.combination}'; modifiers = ${candidate.modifiers}; key = ${candidate.key} }`,
  ).join(', ')
  return String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cs = @'
${CSHARP_BRAKE}
'@
Add-Type -TypeDefinition $cs -Language CSharp
$pausePath = '${psQuote(pauseFilePath())}'
$stopPath = '${psQuote(brakeStopFilePath())}'
$statusPath = '${psQuote(brakeStatusFilePath())}'
$parentPid = ${process.pid}
$message = [CuBrake+MSG]::new()
[void][CuBrake]::PeekMessage([ref]$message, [IntPtr]::Zero, 0, 0, 0)
$hostHandle = [CuBrake]::OpenHost($parentPid)
if ($hostHandle -eq [IntPtr]::Zero) { exit 0 }
$registered = $false
$combination = ''
foreach ($candidate in @(${candidates})) {
  if ([CuBrake]::RegisterHotKey([IntPtr]::Zero, 1, [uint32]($candidate.modifiers + 0x4000), [uint32]$candidate.key)) {
    $registered = $true
    $combination = $candidate.combination
    break
  }
}
@{ processId = $PID; registered = $registered; combination = $combination; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -Encoding ASCII
while ($true) {
  while ([CuBrake]::PeekMessage([ref]$message, [IntPtr]::Zero, 0, 0, 1)) {
    if ($message.message -eq 0x0312) {
      @{ paused = $true; reason = 'hotkey'; at = (Get-Date).ToUniversalTime().ToString('o'); by = 'emergency-hotkey' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pausePath -Encoding ASCII
    }
  }
  if ([CuBrake]::HostExited($hostHandle)) { break }
  if (Test-Path -LiteralPath $stopPath) {
    $owner = ''
    try { $owner = (Get-Content -LiteralPath $stopPath -Raw).Trim() } catch { $owner = '' }
    if ($owner -eq '' -or $owner -eq [string]$parentPid) {
      Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
      break
    }
  }
  Start-Sleep -Milliseconds 120
}
if ($registered) { [void][CuBrake]::UnregisterHotKey([IntPtr]::Zero, 1) }
[void][CuBrake]::CloseHandle($hostHandle)
`
}

let brakeStart = null

async function ensureBrake() {
  if (UNSUPPORTED) {
    return {
      combination: '',
      registered: false,
      processId: null,
      alive: false,
      error: `the emergency brake is not implemented on ${process.platform}`,
    }
  }
  const current = readBrakeStatus()
  if (current && processAlive(current.processId)) return current
  if (brakeStart) return await brakeStart
  brakeStart = (async () => {
    try {
      return await startBrake()
    } catch (error) {
      return { combination: '', registered: false, processId: null, error: messageOf(error).slice(0, 300) }
    } finally {
      brakeStart = null
    }
  })()
  return await brakeStart
}

async function startBrake() {
  if (LINUX) return await startLinuxBrake()
  ensureHelperDirectory()
  mkdirSync(dataDirectory(), { recursive: true })
  const previous = readBrakeStatus()
  if (previous && processAlive(previous.processId)) {
    // Ask a leftover watcher (for example from the previous plugin row) to exit,
    // then wait for the hotkey to be released before starting a new one. The
    // request carries this host's pid so another DSH instance cannot be stopped.
    try {
      writeFileSync(brakeStopFilePath(), String(process.pid), 'utf8')
    } catch {
      // The stop request is best effort.
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100)
      if (!processAlive(previous.processId)) break
    }
  }
  try {
    unlinkSync(brakeStatusFilePath())
  } catch {
    // No stale status.
  }
  try {
    unlinkSync(brakeStopFilePath())
  } catch {
    // No stale stop request.
  }
  const script = brakeScript()
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // Not `detached`: a detached powershell.exe cannot attach to a console and
  // exits before it registers anything. A hidden, unref'd child is enough — the
  // watcher outlives this process because nothing kills it, and it terminates
  // itself as soon as the host process disappears.
  const child = spawn(
    powershellExecutable(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { stdio: 'ignore', windowsHide: true, cwd: ensureHelperDirectory(), env: process.env },
  )
  // An async spawn failure (ENOENT/EACCES) would otherwise surface as an
  // uncaught 'error' event and could take the host process down with it.
  let spawnError = null
  child.on('error', (error) => {
    spawnError = messageOf(error).slice(0, 300)
  })
  child.unref()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(100)
    const status = readBrakeStatus()
    if (status) return status
    if (spawnError) break
  }
  return {
    combination: '',
    registered: false,
    processId: child.pid ?? null,
    error: spawnError || 'the emergency-brake helper did not report within 4 seconds',
  }
}

/**
 * X11 emergency brake: spawn the python3-Xlib watcher that grabs the first
 * available hotkey on the root window. If python3/Xlib is unavailable the
 * action path still works (the watcher is a brake, not a dependency); the
 * status route and inputcheck report the real reason.
 */
async function startLinuxBrake() {
  mkdirSync(dataDirectory(), { recursive: true })
  const previous = readBrakeStatus()
  if (previous && processAlive(previous.processId)) {
    try {
      writeFileSync(brakeStopFilePath(), String(process.pid), 'utf8')
    } catch {
      // best effort
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100)
      if (!processAlive(previous.processId)) break
    }
  }
  try {
    unlinkSync(brakeStatusFilePath())
  } catch {
    // no stale status
  }
  try {
    unlinkSync(brakeStopFilePath())
  } catch {
    // no stale stop request
  }
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'backends', 'x11-hotkey.py')
  if (!existsSync(helper)) {
    return {
      combination: '',
      registered: false,
      processId: null,
      alive: false,
      error: 'the X11 emergency-brake helper (backends/x11-hotkey.py) is missing from the plugin',
    }
  }
  const combinations = HOTKEY_CANDIDATES.map((candidate) => ({
    name: candidate.combination,
    keysym: candidate.keysym,
    modifiers: candidate.x11Modifiers,
  }))
  let child
  try {
    child = spawn(
      'python3',
      [helper, pauseFilePath(), brakeStatusFilePath(), brakeStopFilePath(), String(process.pid), JSON.stringify(combinations)],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: process.env },
    )
  } catch (error) {
    return { combination: '', registered: false, processId: null, alive: false, error: `could not start python3: ${messageOf(error).slice(0, 200)}` }
  }
  let spawnError = null
  let stderr = ''
  child.on('error', (error) => {
    spawnError = messageOf(error).slice(0, 300)
  })
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 2_000) stderr += String(chunk)
  })
  child.unref()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(100)
    const status = readBrakeStatus()
    if (status) return status
    if (spawnError) break
  }
  const detail = stderr.trim().slice(0, 300)
  return {
    combination: '',
    registered: false,
    processId: child.pid ?? null,
    alive: Boolean(child.pid),
    error: spawnError || detail || 'the X11 emergency-brake helper did not report within 4 seconds (does python3 have Xlib?)',
  }
}

function stopBrake() {
  try {
    // The owner pid in the request keeps two host instances from stopping each
    // other's watcher; this host's own watcher exits on its next poll.
    writeFileSync(brakeStopFilePath(), String(process.pid), 'utf8')
  } catch {
    // Best effort: the watcher also exits when the host process disappears.
  }
}

// ---------------------------------------------------------------------------
// Provider slot coexistence
// ---------------------------------------------------------------------------

/** One localized title as plain text. */
function providerTitle(value) {
  if (typeof value === 'string') return value.slice(0, 120)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = value.en ?? value.zh
    if (typeof text === 'string') return text.slice(0, 120)
  }
  return ''
}

/** Enabled plugin rows that look like another computer-use provider. */
async function competingProviderPlugins() {
  const manager = pluginContext && typeof pluginContext.get === 'function' ? pluginContext.get('pluginManager') : null
  if (!manager || typeof manager.listPlugins !== 'function') return []
  if (
    competingProviderCache.context === pluginContext &&
    Date.now() - competingProviderCache.at < PROVIDER_ROW_CACHE_MS
  ) {
    return competingProviderCache.rows
  }
  let rows
  try {
    rows = await manager.listPlugins()
  } catch {
    return []
  }
  const competing = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.enabled === true)
    .filter(
      (row) =>
        typeof row.moduleName === 'string' &&
        row.moduleName !== SELF_MODULE_NAME &&
        COMPETING_PROVIDER_RE.test(row.moduleName),
    )
    .slice(0, 8)
    .map((row) => ({
      moduleName: String(row.moduleName).slice(0, 160),
      id: String(row.patchId ?? row.entryId ?? '').slice(0, 80),
      title: providerTitle(row.meta?.title),
    }))
  competingProviderCache = { at: Date.now(), context: pluginContext, rows: competing }
  return competing
}

/**
 * Registration outcome plus the competing plugins installed beside this one.
 * A failed registration means another plugin took the process's single
 * `computerUse` slot; the tools above still work because they do not use it.
 */
async function providerSlotReport() {
  const serviceMounted = Boolean(
    pluginContext && typeof pluginContext.get === 'function' && pluginContext.get('computerUse'),
  )
  const status = providerSlotState.status
  const registered = serviceMounted && status === 'registered'
  const competing = await competingProviderPlugins()
  return {
    slot: PROVIDER_SLOT,
    provider: PROVIDER_NAME,
    serviceMounted,
    status,
    registered,
    owner: registered ? PROVIDER_NAME : '',
    conflict: status === 'conflict' ? String(providerSlotState.error ?? '').slice(0, 300) : '',
    competing,
  }
}

// ---------------------------------------------------------------------------
// Status route shared with the UI (pause / resume / counters)
// ---------------------------------------------------------------------------

async function statusValue() {
  const pause = readPause()
  return {
    paused: pause.paused,
    pause: pause.detail,
    ...(LINUX ? { backend: backend.name } : {}),
    brake: LINUX ? readBrakeStatus() ?? linuxBrakeStatus() : readBrakeStatus(),
    dataDir: dataDirectory(),
    audit: auditStats(),
    lastAction: lastActionRecord,
    // Read-only coexistence report: which provider owns the single seam and
    // which other computer-use plugins are installed beside this one.
    provider: await providerSlotReport(),
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify({ ok: true, value }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

async function serveStatus(request) {
  try {
    if (request.method === 'POST') {
      let body = null
      try {
        body = await request.json()
      } catch {
        body = null
      }
      const action = typeof body?.action === 'string' ? body.action.trim() : ''
      if (action === 'pause') {
        writePause(typeof body?.reason === 'string' ? body.reason : 'user', 'user')
      } else if (action === 'resume') {
        clearPause()
      } else {
        return errorResponse('action must be "pause" or "resume"')
      }
    }
    return jsonResponse(await statusValue())
  } catch (error) {
    return errorResponse(messageOf(error), 500)
  }
}

/**
 * Read the tool gate for one conversation.
 *
 * The 「桌面」Conversation view renders a switch that mirrors this route: the
 * tools' `when` predicate reads the same store, so the flip takes effect for the
 * agent's next step without restarting anything.
 */
function capabilityValue(sessionId) {
  return { sessionId, enabled: computerUseEnabledForSession(sessionId) }
}

function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : ''
}

async function serveCapability(request) {
  try {
    let sessionId = ''
    try {
      sessionId = validSessionId(new URL(request.url).searchParams.get('sessionId') ?? '')
    } catch {
      sessionId = ''
    }
    if (request.method === 'GET') {
      if (!sessionId) return errorResponse('sessionId is required')
      return capabilityResponse(capabilityValue(sessionId))
    }
    let body = null
    try {
      body = await request.json()
    } catch {
      body = null
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('a JSON body is required')
    if (!sessionId) sessionId = validSessionId(body.sessionId)
    if (!sessionId) return errorResponse('sessionId is required')
    if (typeof body.enabled !== 'boolean') return errorResponse('enabled must be a boolean')
    const enabled = setComputerUseForSession(sessionId, body.enabled)
    return capabilityResponse({ sessionId, enabled })
  } catch (error) {
    return errorResponse(messageOf(error), 500)
  }
}

/**
 * `{ok, value: {sessionId, enabled}}` is the envelope every route in this plugin
 * uses; `enabled` is also mirrored at the top level so a client (or a curl
 * operator) can read the flag without unwrapping `value`.
 */
function capabilityResponse(value) {
  return new Response(JSON.stringify({ ok: true, value, enabled: value.enabled }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// ---------------------------------------------------------------------------
// Model-facing tools
// ---------------------------------------------------------------------------

const screenshotTool = {
  name: 'computer_screenshot',
  description: (LINUX
    ? 'Capture one monitor of the X11 desktop to a PNG and return its path with its screen geometry, cursor position, foreground window and a single-use observation token (state_id). ' +
      'The monitor layout is detected on every call (hotplug, rotation and multi-monitor are read live, never cached): without `screen` the primary monitor is captured, pass `"cursor"` to capture the monitor under the pointer, or a monitor id (for example "HDMI-1-0") or index to pick one explicitly. The result lists every monitor in `screens`, including its `dpi` when the panel reports a physical size. ' +
      'Tool coordinates are LOCAL to the captured monitor: the screenshot origin is the monitor origin. ' +
      'Pass `region` (monitor-local x/y/width/height) to get only that part of the screen: the returned PNG is the crop and `region` says where it sits, while the observation token still binds the whole monitor. '
    : `Capture one monitor of the ${DESKTOP_LABEL} desktop (or the whole virtual desktop with screen: "all") to a PNG and return its path with screen geometry, cursor position, foreground window and a single-use observation token (state_id). ` +
      'Omit screen for the primary monitor, pass a monitor id (for example "DISPLAY1") or index, or "all" for every monitor in one image; the result lists every monitor in screens. ' +
      'Windows action coordinates stay desktop-global, so add originX/originY to a position measured on the image. ' +
      'Pass region (monitor-local x/y/width/height) to return only that part of the screen, and scale to downscale it. '
  ) +
    'The image is not attached automatically: call the image-read tool on the returned path to actually see it. ' +
    'Every computer action must present a fresh state_id, and a new screenshot invalidates the previous one, so observe first, act once, then inspect the new observation the action returns.',
  parameters: {
    type: 'object',
    properties: {
      screen: {
        type: 'string',
        description:
          (LINUX
            ? 'Linux/X11 only: monitor selector. Omit for the primary monitor (or the largest one when no monitor is marked primary); "cursor" follows the pointer; otherwise a monitor id (for example "HDMI-1-0") or index (for example "1").'
            : 'Windows: "all" captures the whole virtual desktop, omitting it captures the primary monitor, otherwise pass a monitor id (for example "DISPLAY1") or index (for example "1").'),
      },
      region: {
        type: 'object',
        additionalProperties: false,
        description:
          'Linux/X11 only: crop the screenshot to this monitor-local rectangle, so only the interesting part reaches the conversation. Good for dialogs, toolbars and small widgets; the whole monitor stays bound to the observation token.',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['x', 'y', 'width', 'height'],
      },
      scale: {
        type: 'number',
        description: 'Linux/X11 only: optional scale factor for a region crop (for example 0.5 to halve the image).',
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'width', 'height', 'originX', 'originY', 'cursor', 'foreground', 'state_id'],
      properties: {
        path: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        originX: { type: 'integer' },
        originY: { type: 'integer' },
        state_id: { type: 'string' },
        region: {
          type: 'object',
          additionalProperties: true,
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            scale: { type: 'number' },
          },
        },
        screen: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            index: { type: 'integer' },
            primary: { type: 'boolean' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
        },
        screens: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        cursor: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: { x: { type: 'integer' }, y: { type: 'integer' } },
        },
        foreground: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'process'],
          properties: {
            title: { type: 'string' },
            process: { type: 'string' },
            handle: { type: 'string' },
            rect: { type: 'string' },
          },
        },
      },
    },
    render: (_args, value) => [
      {
        type: 'text',
        text:
          `Desktop screenshot saved to ${value.path} (${value.width}x${value.height} at origin ` +
          `${value.originX},${value.originY}). Cursor: ${value.cursor.x},${value.cursor.y}. Foreground window: ` +
          `"${value.foreground.title}" (${value.foreground.process}). Observation token: ${value.state_id}. ` +
          'Read that path as an image to inspect it, then pass the token to computer.',
      },
    ],
    presentationMeta: (_args, value) => ({
      path: value.path,
      width: value.width,
      height: value.height,
      cursor: value.cursor,
      foreground: value.foreground,
      state_id: value.state_id,
    }),
  },
  execute: async (args, exec) => captureForAgent(exec, args),
}

async function captureForAgent(exec, args) {
  const sessionId = sessionIdOf(exec && exec.agent)
  const capture = await captureScreenshot(args?.screen, args?.region, args?.scale)
  const record = rememberObservation(sessionId, capture)
  const value = {
    path: capture.path,
    width: capture.width,
    height: capture.height,
    originX: capture.originX,
    originY: capture.originY,
    cursor: capture.cursor,
    foreground: capture.foreground,
    state_id: record.id,
  }
  // Linux/X11 only: which monitor this observation is local to, plus the list
  // the model needs to switch monitors with a new screenshot.
  if (capture.screen) value.screen = capture.screen
  if (Array.isArray(capture.screens)) value.screens = capture.screens
  if (capture.region) value.region = capture.region
  return value
}

const computerTool = {
  name: 'computer',
  description:
    `Drive the real ${DESKTOP_LABEL} desktop with one action per call. Actions: move, click, double_click, right_click, drag, scroll, type, key, wait, sequence, inputcheck, pause. ` +
    (LINUX
      ? 'All coordinates are LOCAL to the monitor of the state_id observation; a screenshot of another monitor must be taken before acting there. '
      : 'Windows action coordinates are desktop-global: a monitor screenshot reports originX/originY, so add them to a position measured on the image. ') +
    'Call computer_screenshot first and pass its state_id: the token is consumed by its first dispatched action, while a call refused before dispatch (missing intent, missing risk confirmation, denied approval) releases it so you can retry with the same state_id. ' +
    `${LINUX ? 'The dispatch path' : 'The helper'} re-proves the foreground window identity and sampled pixels immediately before dispatching, so a changed screen is refused as stale_observation instead of clicking blindly. ` +
    'A successful input action (and wait) returns a fresh screenshot path and state_id, so you can inspect and continue; taking a new screenshot supersedes the previous token. ' +
    'Activating actions (click, double_click, right_click, drag, type, key, sequence) require a short "intent" describing the goal; intents that look risky (send, delete, pay, password, install, confirm ...) require confirm_risk:true and are routed through user approval, which fails closed when the session disables approval prompts. Keep the intent descriptive rather than imperative, so a neutral action is not graded high risk by an approval-style verb. ' +
    'Use sequence to batch up to 20 input steps under one observation; it re-checks the brake between steps, so an emergency stop also interrupts a batch. ' +
    (LINUX
      ? 'inputcheck diagnoses the X11 input path (helper binaries, DISPLAY/session type, monitor enumeration, screenshot size, pointer warp, foreground window, pause/lock state, emergency hotkey); it never types or clicks, and while paused or locked it injects nothing at all. '
      : 'inputcheck diagnoses the input path (integrity, locked desktop, dispatch confirmation, pointer drift, brake status); it never types or clicks, and while paused or locked it injects nothing at all. ') +
    (LINUX
      ? 'pause is an emergency brake: it stops every desktop action until the user releases it from the DSH UI. The user can also press the global hotkey Ctrl+Alt+Shift+Q (Ctrl+Alt+Shift+F12 fallback) when the X11 brake helper is running; only the user releases the pause.'
      : 'pause is an emergency brake: it stops every desktop action until the user releases it from the DSH UI (the user can also press the global hotkey Ctrl+Alt+Shift+Q at any time).'),
  parameters: {
    type: 'object',
    required: ['action'],
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ALL_ACTIONS,
        description: 'What to do. Each call performs exactly one action unless action is sequence.',
      },
      state_id: {
        type: 'string',
        description: 'Observation token returned by computer_screenshot. Required for every input action (not for wait, inputcheck or pause).',
      },
      intent: {
        type: 'string',
        maxLength: 200,
        description: 'One short sentence stating what this action is meant to achieve (required for click, double_click, right_click, drag, type, key and sequence; at most 200 characters). It is graded for risk and written to the audit trail.',
      },
      confirm_risk: {
        type: 'boolean',
        description: 'Set to true to accept that a high-risk action goes through user approval; without it a high-risk action is refused before anything happens.',
      },
      x: { type: 'integer', description: 'Target X for move, click, double_click, right_click, drag start, or scroll anchor.' },
      y: { type: 'integer', description: 'Target Y for move, click, double_click, right_click, drag start, or scroll anchor.' },
      toX: { type: 'integer', description: 'Drag end X (drag only).' },
      toY: { type: 'integer', description: 'Drag end Y (drag only).' },
      delta: {
        type: 'integer',
        description: 'Wheel delta for scroll: negative scrolls down, positive up; one notch is 120 (default -120).',
      },
      text: { type: 'string', description: 'Text for the type action (up to 4000 characters, Unicode).' },
      keys: { type: 'string', description: 'Key combination for the key action, e.g. "Ctrl+Shift+I" or "Enter".' },
      ms: { type: 'integer', description: 'How long the wait action sleeps, 1-30000 milliseconds (default 500).' },
      steps: {
        type: 'array',
        description: 'Steps for the sequence action (up to 20): each is an action object without state_id.',
        items: {
          type: 'object',
          required: ['action'],
          additionalProperties: true,
          properties: {
            action: { type: 'string', enum: INPUT_ACTIONS },
            x: { type: 'integer' },
            y: { type: 'integer' },
            toX: { type: 'integer' },
            toY: { type: 'integer' },
            delta: { type: 'integer' },
            text: { type: 'string' },
            keys: { type: 'string' },
          },
        },
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'action'],
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        detail: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
        guidance: { type: 'string' },
        intent: { type: 'string' },
        risk: { type: 'string' },
        warning: { type: 'string' },
        paused: { type: 'boolean' },
        foreground: { type: 'string' },
        cursor: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: { x: { type: 'integer' }, y: { type: 'integer' } },
        },
        observation: {
          type: 'object',
          additionalProperties: true,
          required: ['state_id', 'path'],
          properties: {
            state_id: { type: 'string' },
            path: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            originX: { type: 'integer' },
            originY: { type: 'integer' },
          },
        },
        check: {
          type: 'object',
          additionalProperties: true,
          properties: {
            staging: { type: 'object', additionalProperties: true },
            integrity: { type: 'object', additionalProperties: true },
            locked: { type: 'boolean' },
            landed: { type: 'object', additionalProperties: true },
            pointerDrifting: { type: 'boolean' },
            paused: { type: 'boolean' },
            brake: { type: 'object', additionalProperties: true },
          },
        },
        provider: {
          type: 'object',
          additionalProperties: true,
          properties: {
            slot: { type: 'string' },
            provider: { type: 'string' },
            serviceMounted: { type: 'boolean' },
            status: { type: 'string' },
            registered: { type: 'boolean' },
            owner: { type: 'string' },
            conflict: { type: 'string' },
            competing: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'detail'],
            properties: { action: { type: 'string' }, detail: { type: 'string' } },
          },
        },
        blockedStep: { type: 'integer' },
      },
    },
    render: (_args, value) => {
      if (value.ok === false) {
        const lines = [`REFUSED [${value.code}]: ${value.message}`]
        if (value.guidance) lines.push(`Next: ${value.guidance}`)
        if (value.foreground) lines.push(`Current foreground window: "${value.foreground}".`)
        if (Array.isArray(value.steps) && value.steps.length > 0) {
          lines.push(
            `Steps already executed before the block${value.blockedStep ? ` (blocked at step ${value.blockedStep})` : ''}: ${value.steps.map((step) => step.detail).join('; ')}.`,
          )
        }
        if (value.provider && value.provider.conflict) {
          lines.push(`Provider slot "${value.provider.slot}" is owned by another plugin (${value.provider.conflict}).`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }
      const lines = []
      if (value.action === 'pause') {
        lines.push('Desktop control is now paused until the user releases it from the DSH UI.')
        return [{ type: 'text', text: lines.join('\n') }]
      }
      if (value.action === 'inputcheck') {
        lines.push(`Input self-check: ${value.detail}.`)
        const environment = value.check && value.check.environment
        if (environment) {
          const screens = Array.isArray(environment.layout && environment.layout.screens) ? environment.layout.screens : []
          const monitors = screens.length === 0
            ? 'no monitor detected'
            : screens
                .map((screen) => `${screen.id} ${screen.width}x${screen.height}${Number.isFinite(screen.dpi) ? ` @${screen.dpi}dpi` : ''}${screen.primary ? ' (primary)' : ''}`)
                .join(', ')
          lines.push(
            `Detected desktop: ${environment.sessionType || 'unknown session type'}${environment.desktop ? ` / ${environment.desktop}` : ''}; ${monitors}.`,
          )
        }
        if (value.provider && value.provider.conflict) {
          lines.push(
            `Provider slot "${value.provider.slot}" is owned by another plugin (${value.provider.conflict}); these desktop tools still work, but do not assume this plugin is the active computer-use provider.`,
          )
        } else if (value.provider && value.provider.serviceMounted === false) {
          lines.push('The computer-use provider seam is not mounted in this profile; the desktop tools above do not depend on it.')
        }
      } else if (Array.isArray(value.steps) && value.steps.length > 0) {
        lines.push(`Ran ${value.steps.length} steps: ${value.steps.map((step) => step.detail).join('; ')}.`)
      } else {
        lines.push(`Done: ${value.detail}.`)
      }
      if (value.paused === true) lines.push('Desktop control is now paused until the user releases it.')
      const cursor = value.cursor ? `${value.cursor.x},${value.cursor.y}` : 'unknown'
      lines.push(`Foreground window: "${value.foreground ?? ''}". Cursor: ${cursor}.`)
      if (value.observation && value.observation.path) {
        lines.push(
          `New observation token ${value.observation.state_id}; screenshot at ${value.observation.path}. Read it as an image to inspect the result.`,
        )
      }
      if (value.warning) lines.push(`Warning: ${value.warning}.`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentationMeta: (args, value) => ({
      action: value.action,
      ok: value.ok !== false,
      detail: value.detail ?? '',
      code: value.code ?? null,
      message: value.message ?? null,
      guidance: value.guidance ?? null,
      intent: typeof args?.intent === 'string' ? args.intent : null,
      risk: value.risk ?? null,
      foreground: value.foreground ?? null,
      cursor: value.cursor ?? null,
      stateId: value.observation && value.observation.state_id ? value.observation.state_id : null,
      paused: value.paused === true,
      x: typeof args?.x === 'number' ? args.x : null,
      y: typeof args?.y === 'number' ? args.y : null,
      toX: typeof args?.toX === 'number' ? args.toX : null,
      toY: typeof args?.toY === 'number' ? args.toY : null,
      keys: typeof args?.keys === 'string' ? args.keys : null,
      text: typeof args?.text === 'string' ? args.text.slice(0, 120) : null,
      steps: Array.isArray(value.steps) ? value.steps : null,
      check: value.check ?? null,
    }),
  },
  execute: async (args, exec) => performComputer(pluginContext, exec, args),
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function refusal(action, code, message, guidance, extra = {}) {
  return { ok: false, action, code, message, guidance, ...extra }
}

function resolveObservation(sessionId, stateId, action, callId) {
  if (typeof stateId !== 'string' || !stateId.trim()) {
    return refusal(
      action,
      'missing_observation',
      'This action needs a state_id from computer_screenshot.',
      'Call computer_screenshot, inspect the image, then retry with the state_id it returned.',
    )
  }
  const record = observations.get(stateId.trim())
  if (!record) {
    return refusal(
      action,
      'observation_expired',
      `The observation token ${stateId} is unknown: the desktop-use helper may have restarted since it was issued.`,
      'Take a new screenshot and use its state_id.',
    )
  }
  if (record.sessionId !== sessionId) {
    return refusal(
      action,
      'observation_expired',
      'The observation token belongs to a different conversation.',
      'Take a screenshot in this conversation and use that state_id.',
    )
  }
  if (record.used) {
    return refusal(
      action,
      'observation_used',
      'The observation token was already consumed by a previous action.',
      'Take a new screenshot (or use the observation returned by the previous action) before acting again.',
    )
  }
  // Superseded before expired: "a newer screenshot exists, use it" is the more
  // actionable diagnosis when a token is both old and replaced.
  if (latestObservationBySession.get(sessionId) !== record.id) {
    return refusal(
      action,
      'observation_superseded',
      'A newer screenshot was taken after this observation, so the token is superseded.',
      'Use the newest state_id from the latest computer_screenshot result.',
    )
  }
  const ttlMs = observationTtlMs()
  if (Date.now() - record.createdAt > ttlMs) {
    return refusal(
      action,
      'observation_expired',
      `The observation token is older than ${Math.round(ttlMs / 1000)} seconds.`,
      'Take a new screenshot and use its state_id.',
    )
  }
  // Atomic reservation: DSH may dispatch several tool calls of one step in
  // parallel, and there is no await between the checks above and these lines, so
  // exactly one caller can hold the token. It stays reserved while this call
  // negotiates intent/risk, and is released again if the call is refused before
  // anything is dispatched (so `risk_approval_required` -> `confirm_risk:true`
  // retries work); the first real dispatch consumes it for good.
  record.used = true
  record.consumedBy = callId
  record.consumedAt = Date.now()
  return { ok: true, observation: record }
}

/** Release a token reserved by this call when no dispatch happened after all. */
function releaseObservation(record, callId) {
  if (!record || record.used !== true) return
  if (record.consumedBy !== callId) return
  record.used = false
  record.consumedBy = null
  record.consumedAt = 0
}

async function requestRiskApproval(ctx, exec, args, risk) {
  const approval = ctx.get('approval')
  if (!approval || typeof approval.request !== 'function') {
    return refusal(
      args?.action ?? 'sequence',
      'risk_unavailable',
      'This action is graded high risk but the approval service is not mounted.',
      'Ask the user to perform it manually, or run a composition that mounts approval.',
      { risk: risk.level },
    )
  }
  let outcome = 'unavailable'
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: 'computer',
      callId: exec.callId,
      reason:
        `computer ${String(args?.action ?? 'sequence')}: ${typeof args?.intent === 'string' ? args.intent : ''} ` +
        `(${risk.reason || 'high risk'})`,
      signal: exec.signal,
    })
  } catch (error) {
    return refusal(
      String(args?.action ?? 'sequence'),
      'risk_unavailable',
      `The approval request failed: ${messageOf(error).slice(0, 300)}`,
      'Ask the user to perform the action manually.',
      { risk: risk.level },
    )
  }
  if (outcome === 'allowed-once') return { ok: true }
  let policy = ''
  try {
    policy = typeof approval.effectivePolicy === 'function' ? approval.effectivePolicy(exec.agent.session) : ''
  } catch {
    policy = ''
  }
  const detail =
    outcome === 'rejected'
      ? policy === 'never'
        ? 'the session approval policy is "never", so approval-required actions are rejected automatically'
        : 'the user rejected this action'
      : outcome === 'cancelled'
        ? 'the approval request was cancelled'
        : 'no approval answerer is available, so the request failed closed'
  return refusal(
    String(args?.action ?? 'sequence'),
    'risk_denied',
    `The high-risk action was not approved: ${detail}.`,
    policy === 'never'
      ? 'Tell the user this action needs an approval policy other than "never"; they can switch it in the approval control and ask you to retry, or perform the action themselves.'
      : 'Ask the user to approve it explicitly, or perform the action themselves.',
    { risk: risk.level },
  )
}

function observationRequirement(action) {
  if (action === 'wait' || action === 'inputcheck' || action === 'pause') return false
  return true
}

function intentRequirement(action) {
  return ACTIVATING_ACTIONS.includes(action) || action === 'sequence'
}

/** The mounting plugin Context, captured by `apply()`; tools read services through it. */
let pluginContext = null

async function performComputer(ctx, exec, args) {
  const action = typeof args?.action === 'string' ? args.action.trim() : ''
  const sessionId = sessionIdOf(exec && exec.agent)
  if (!ALL_ACTIONS.includes(action)) {
    const result = refusal(
      action || 'unknown',
      'invalid_args',
      `action must be one of: ${ALL_ACTIONS.join(', ')}`,
      'Send a valid action.',
    )
    appendAudit(exec, action || 'unknown', args, result, null)
    return result
  }
  let risk = null
  let observation = null
  let observationCommitted = false
  try {
    if (UNSUPPORTED) {
      const result = refusal(
        action,
        'unsupported_platform',
        `Desktop control is not available: ${backend.reason ?? `the ${process.platform} platform is not supported yet`}.`,
        'Use this plugin on Windows or Linux/X11, or drive the desktop manually.',
      )
      appendAudit(exec, action, args, result, null)
      return result
    }
    if (action === 'inputcheck') {
      const result = await inputCheck()
      appendAudit(exec, action, args, result, null)
      return result
    }
    if (action === 'pause') {
      const existing = readPause()
      // Idempotent: a second pause (for example the model pausing after the user
      // already hit the emergency hotkey) must not overwrite the original reason
      // and timestamp, which the status surface and audit rely on.
      if (!existing.paused) writePause('model', 'agent')
      const result = {
        ok: true,
        action,
        detail: existing.paused
          ? 'desktop control was already paused; the existing pause record was kept'
          : 'desktop control is paused',
        paused: true,
        foreground: '',
        cursor: { x: 0, y: 0 },
      }
      appendAudit(exec, action, args, result, null)
      return result
    }
    const pause = readPause()
    if (pause.paused) {
      const result = refusal(
        action,
        'paused',
        `Desktop control is paused (reason: ${pause.detail?.reason ?? 'user'}).`,
        'Only the user can release the pause: ask them to press "恢复桌面操作" in the DSH 桌面操作 tab. Do not retry until then.',
        { paused: true },
      )
      appendAudit(exec, action, args, result, null)
      return result
    }
    await ensureBrake()
    if (observationRequirement(action)) {
      const resolved = resolveObservation(sessionId, args?.state_id, action, exec && exec.callId)
      if (!resolved.ok) {
        appendAudit(exec, action, args, resolved, null)
        return resolved
      }
      observation = resolved.observation
    }
    if (intentRequirement(action)) {
      const intent = typeof args?.intent === 'string' ? args.intent.trim() : ''
      if (!intent) {
        const result = refusal(
          action,
          'intent_required',
          `The ${action} action requires a short "intent" describing what it should achieve.`,
          'Retry with intent set to one short sentence, for example "click the Save button in Notepad".',
        )
        appendAudit(exec, action, args, result, null)
        return result
      }
      if (intent.length > 200) {
        const result = refusal(
          action,
          'invalid_args',
          `"intent" is limited to 200 characters (got ${intent.length}).`,
          'Shorten the intent to one sentence and retry.',
        )
        appendAudit(exec, action, args, result, null)
        return result
      }
    }
    risk = riskOf(action, args, observation)
    if (risk.level === 'high' && action !== 'wait') {
      if (args?.confirm_risk !== true) {
        const result = refusal(
          action,
          'risk_approval_required',
          `This action is graded high risk (${risk.reason}) and needs explicit confirmation.`,
          'If it is really intended, retry with confirm_risk:true; the user will then have to approve it (or it is auto-rejected under the "never" policy).',
          { risk: risk.level },
        )
        appendAudit(exec, action, args, result, risk)
        return result
      }
      const approval = await requestRiskApproval(ctx, exec, args, risk)
      if (!approval.ok) {
        appendAudit(exec, action, args, approval, risk)
        return approval
      }
    }
    // The DSH window hosts user-only authorization surfaces: capability
    // switches, browser pause/resume, and the plugin-market install/confirm
    // dialog. Input *into that window* must stay user-only:
    //  - Windows keeps the original blanket rule for every activating action;
    //  - Linux judges the target instead: keyboard actions (typing/keys go to
    //    the focused window) are refused while DSH is focused, while pointer
    //    actions are refused only when their own point lands on DSH. That lets
    //    automation work on another window or another monitor while the user
    //    watches the chat in DSH.
    const blanketDshBlock =
      LINUX ? action === 'type' || action === 'key' : ACTIVATING_ACTIONS.includes(action) || action === 'sequence'
    if (blanketDshBlock && targetsDshWindow(observation)) {
      const result = refusal(
        action,
        'dsh_window_blocked',
        'Automated input into the DSH window is blocked: it hosts install and authorization controls that must stay user-driven.',
        'Ask the user to perform this UI action themselves; desktop automation may only drive other applications. The screenshot token was consumed by this attempt, so take a new screenshot before acting again.',
      )
      appendAudit(exec, action, args, result, risk)
      return result
    }
    // Validate the arguments BEFORE committing the reservation: a rejected call
    // (invalid args, intent, risk, approval) must release the token so the model
    // can retry with the same state_id.
    const plan = LINUX ? linuxAdapter.validate(action, args, { ...LINUX_LIMITS, screen: observation?.screen }) : buildPlan(action, args)
    // Past this point the action is dispatched: the reservation becomes a
    // permanent consumption (also when the helper refuses a paused/locked/stale
    // state, because the attempt itself already happened).
    observationCommitted = true
    const result = await runAction(sessionId, action, args, observation, plan)
    result.risk = risk.level
    appendAudit(exec, action, args, result, risk)
    return result
  } catch (error) {
    const result = refusal(
      action,
      'invalid_args',
      messageOf(error).slice(0, 600),
      'Fix the arguments (or re-observe) and retry.',
      { ...(risk && risk.level ? { risk: risk.level } : {}) },
    )
    appendAudit(exec, action, args, result, risk)
    return result
  } finally {
    if (!observationCommitted) releaseObservation(observation, exec && exec.callId)
  }
}

/**
 * Validate one action's arguments and build its PowerShell statements. Pure:
 * no filesystem or process work, so a bad call can be rejected before the
 * observation reservation is committed (an invalid call must release the token).
 */
function buildPlan(action, args) {
  if (action === 'wait') {
    const ms = optionalNumber(args, 'ms') ?? 500
    if (ms < 1 || ms > 30_000) throw new Error('"ms" must be between 1 and 30000')
    return { lines: [`Start-Sleep -Milliseconds ${ms}`], detail: `waited ${ms} ms`, guards: [] }
  }
  if (action === 'sequence') {
    // The sequence script carries per-step guards; no batch-level guard applies.
    return { ...sequenceScript(args?.steps, pauseFilePath()), guards: [] }
  }
  const plan = actionScript(action, args)
  return { ...plan, guards: dispatchGuards(action, args) }
}

/** Build and run the helper script for one input action (or the sequence/wait flow actions). */
async function runAction(sessionId, action, args, observation, providedPlan) {
  if (LINUX) return await runLinuxAction(sessionId, action, args, observation, providedPlan)
  const plan = providedPlan ?? buildPlan(action, args)
  const shot = screenshotPath()
  const parts = ["$payload = $null", `if (Test-Path -LiteralPath '${psQuote(pauseFilePath())}') {`]
  parts.push(
    `  $payload = @{ ok = $false; action = '${psQuote(action)}'; code = 'paused'; message = 'Desktop control is paused by the user.'; guidance = 'Only the user can release the pause from the DSH UI.' }`,
  )
  // A locked workstation silently discards injected events, so refuse before
  // dispatching instead of reporting a success the user never sees.
  parts.push('} elseif ([CuNative]::DesktopLocked()) {')
  parts.push(
    `  $payload = @{ ok = $false; action = '${psQuote(action)}'; code = 'desktop_locked'; message = 'The workstation is locked, so injected input would be discarded.'; guidance = 'Ask the user to unlock the desktop, then take a new screenshot and retry.'; foreground = [CuNative]::ForegroundTitle() }`,
  )
  parts.push('} else {')

  if (observation) {
    const expected = Buffer.from(
      JSON.stringify({
        handle: observation.foreground.handle,
        title: observation.foreground.title,
        rect: observation.foreground.rect,
        fingerprint: observation.fingerprint,
        left: Number(String(observation.foreground.rect).split(',')[0]) || 0,
        top: Number(String(observation.foreground.rect).split(',')[1]) || 0,
        width: Number(String(observation.foreground.rect).split(',')[2]) || 0,
        height: Number(String(observation.foreground.rect).split(',')[3]) || 0,
      }),
      'utf8',
    ).toString('base64')
    parts.push(`  $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}')) | ConvertFrom-Json`)
    parts.push('  $handleNow = [string][CuNative]::ForegroundHandle()')
    parts.push('  $titleNow = [CuNative]::ForegroundTitle()')
    parts.push('  $processNow = [CuNative]::ForegroundProcess()')
    parts.push('  $rectNow = [CuNative]::ForegroundRect()')
    parts.push("  $stale = ''")
    parts.push("  if ($handleNow -ne [string]$expected.handle) { $stale = 'window' }")
    parts.push("  elseif ($rectNow -ne [string]$expected.rect) { $stale = 'bounds' }")
    // The window title is deliberately NOT part of the staleness proof: many
    // applications animate it (spinners, unsaved markers, page titles), and the
    // handle plus bounds plus sampled pixels are the stronger evidence.
    parts.push("  elseif ([string]$expected.fingerprint -ne '') {")
    parts.push(
      '    $fingerprintNow = Get-Fingerprint ([int]$expected.left) ([int]$expected.top) ([int]$expected.width) ([int]$expected.height)',
    )
    parts.push("    if ($fingerprintNow -ne '') {")
    parts.push("      $changed = Compare-Fingerprint ([string]$expected.fingerprint) $fingerprintNow")
    parts.push('      if ($changed -gt ' + FINGERPRINT_TOLERANCE + ") { $stale = 'pixels:$changed' }")
    parts.push('    }')
    parts.push('  }')
    parts.push("  if ($stale -ne '') {")
    parts.push(
      `    $payload = @{ ok = $false; action = '${psQuote(action)}'; code = 'stale_observation'; message = ('The observed state is stale (' + $stale + '): the foreground window or its visible pixels changed after the screenshot.'); guidance = 'Call computer_screenshot again and use the new state_id.'; foreground = $titleNow }`,
    )
    parts.push('  } else {')
  }

  // Dispatch guards run in the helper right before the input is sent: the
  // observed foreground can change, and a visible DSH window can be clicked
  // without ever becoming the observed foreground first.
  parts.push('    $blocked = $false')
  parts.push('    $blockedStep = -1')
  for (const guard of plan.guards ?? []) parts.push(`    if (${guard}) { $blocked = $true }`)
  parts.push('    if (-not $blocked) {')
  for (const line of plan.lines) parts.push(`      ${line}`)
  parts.push('    }')
  parts.push('    if ($blocked) {')
  parts.push(
    `      $payload = @{ ok = $false; action = '${psQuote(action)}'; code = 'dsh_window_blocked'; message = 'The dispatch target is the DSH window, which only the user may operate.'; guidance = 'Ask the user to perform this UI action themselves; desktop automation may only drive other applications. The screenshot token was consumed by this attempt, so take a new screenshot before acting again.'; foreground = [CuNative]::ForegroundTitle(); blockedStep = $blockedStep }`,
  )
  if (action === 'sequence') {
    parts.push('      if ($steps.Count -gt 0) { $payload.steps = $steps }')
    parts.push(
      "      if ($skipped -gt 0) { $payload.warning = 'desktop control was paused during the sequence, so later steps were skipped' }",
    )
  }
  parts.push('    } else {')
  parts.push('      Start-Sleep -Milliseconds 220')
  parts.push('      $shot = $null')
  parts.push(`      try { $shot = Capture-Observation '${psQuote(shot)}' } catch { $shot = $null }`)
  parts.push('      $cursorAfter = New-Object CuNative+POINT')
  parts.push('      [CuNative]::GetCursorPos([ref]$cursorAfter) | Out-Null')
  parts.push('      $foregroundAfter = [CuNative]::ForegroundTitle()')
  parts.push(`      $payload = @{ ok = $true; action = '${psQuote(action)}'; detail = '${psQuote(plan.detail)}'; cursor = @{ x = [int]$cursorAfter.X; y = [int]$cursorAfter.Y }; foreground = $foregroundAfter }`)
  if (action === 'sequence') {
    parts.push('      $payload.steps = $steps')
    parts.push(
      "      if ($skipped -gt 0) { $payload.warning = 'desktop control was paused during the sequence, so later steps were skipped' }",
    )
  }
  parts.push('      if ($null -eq $shot) {')
  parts.push("        $note = 'the action ran, but the follow-up screenshot failed'")
  parts.push("        if ($payload.ContainsKey('warning')) { $payload.warning = $payload.warning + '; ' + $note } else { $payload.warning = $note }")
  parts.push('      } else { $payload.observation = $shot }')
  parts.push('    }')
  if (observation) parts.push('  }')
  parts.push('}')
  parts.push('$payload | ConvertTo-Json -Compress -Depth 8')

  // The token was already reserved atomically by resolveObservation() and the
  // caller committed it before dispatching; here the action simply runs against
  // the proven state. Long text/step batches legitimately need more than the
  // default helper budget.
  const timeoutMs =
    ACTION_TIMEOUT_MS +
    (Array.isArray(args?.steps) ? args.steps.length * 2_000 : 0) +
    (typeof args?.text === 'string' ? Math.ceil(args.text.length / 100) * 400 : 0)
  const output = await runPowerShell(parts.join('\n'), { timeoutMs })
  if (output && output.ok === false) {
    return {
      ok: false,
      action,
      code: String(output.code ?? 'action_failed'),
      message: String(output.message ?? 'The action was refused.'),
      guidance: String(output.guidance ?? ''),
      foreground: String(output.foreground ?? ''),
      ...(Array.isArray(output.steps) ? { steps: output.steps } : {}),
      ...(Number.isInteger(output.blockedStep) && output.blockedStep > 0 ? { blockedStep: output.blockedStep } : {}),
    }
  }
  const result = {
    ok: true,
    action,
    detail: String(output.detail ?? plan.detail),
    cursor: { x: Number(output.cursor?.x) || 0, y: Number(output.cursor?.y) || 0 },
    foreground: String(output.foreground ?? ''),
  }
  if (Array.isArray(output.steps)) result.steps = output.steps.map((step) => ({ action: String(step.action ?? ''), detail: String(step.detail ?? '') }))
  if (output.warning) result.warning = String(output.warning)
  if (output.observation && typeof output.observation === 'object') {
    const capture = {
      path: String(output.observation.path ?? ''),
      width: Number(output.observation.width) || 0,
      height: Number(output.observation.height) || 0,
      originX: Number(output.observation.originX) || 0,
      originY: Number(output.observation.originY) || 0,
      cursor: output.observation.cursor,
      foreground: output.observation.foreground,
      fingerprint: String(output.observation.fingerprint ?? ''),
    }
    const record = rememberObservation(sessionId, capture)
    result.observation = observationFragment(record)
  }
  return result
}

// ---------------------------------------------------------------------------
// Linux/X11 dispatch (platform-agnostic flow lives above; primitives in backends/)
// ---------------------------------------------------------------------------

/** DSH-window predicate for the X11 guards (same rule as targetsDshWindow). */
function isDshWindowInfo(info) {
  if (!info) return false
  return DSH_WINDOW_PATTERN.test(String(info.title ?? '')) || DSH_WINDOW_PATTERN.test(String(info.process ?? ''))
}

function linuxRefusal(action, failure, extra = {}) {
  return {
    ok: false,
    action,
    code: String(failure.code ?? 'action_failed'),
    message: String(failure.message ?? 'The action was refused.'),
    guidance: String(failure.guidance ?? 'Take a new screenshot and retry.'),
    foreground: String(failure.foreground ?? ''),
    ...(Array.isArray(extra.steps) && extra.steps.length > 0 ? { steps: extra.steps } : {}),
    ...(Number.isInteger(extra.blockedStep) && extra.blockedStep > 0 ? { blockedStep: extra.blockedStep } : {}),
  }
}

/**
 * Capture the follow-up observation after an action. The Windows helper does
 * this inside the same PowerShell call; on X11 it is one more scrot capture. A
 * failed capture is only a warning: the action itself already happened.
 */
async function linuxObservationAfter(sessionId, action, detail, screenId) {
  const result = { ok: true, action, detail, cursor: { x: 0, y: 0 }, foreground: '' }
  let capture
  try {
    capture = await captureScreenshot(screenId)
  } catch {
    // The action already ran: report where the desktop actually is instead of
    // zeros, exactly like the Windows helper does.
    result.warning = 'the action ran, but the follow-up screenshot failed'
    const facts = await linuxAdapter.readCursorForeground()
    result.cursor = facts.cursor
    result.foreground = facts.foreground
    return result
  }
  const record = rememberObservation(sessionId, capture)
  result.cursor = { x: Number(capture.cursor?.x) || 0, y: Number(capture.cursor?.y) || 0 }
  result.foreground = String(capture.foreground?.title ?? '')
  result.observation = observationFragment(record)
  return result
}

/** Monitor of the session's newest observation, for screen-less actions like wait. */
function latestObservationScreenId(sessionId) {
  const id = latestObservationBySession.get(sessionId)
  const record = id ? observations.get(id) : undefined
  return record && record.screen ? record.screen.id : undefined
}

/**
 * Linux implementation of one dispatch. Mirrors the Windows helper's order:
 * pause -> re-prove -> guards -> inject -> fresh observation, with the sequence
 * flow re-checking pause and the proof between steps.
 */
async function runLinuxAction(sessionId, action, args, observation, plan) {
  const options = { fingerprintTolerance: FINGERPRINT_TOLERANCE, isDshWindow: isDshWindowInfo }
  const pausePath = pauseFilePath()
  if (action === 'wait') {
    await delay(Number(plan?.ms) || 500)
    // wait needs no token, so there is no observation to inherit the monitor
    // from: keep the session's newest monitor instead of silently switching to
    // the primary one.
    return await linuxObservationAfter(
      sessionId,
      action,
      String(plan?.detail ?? 'waited'),
      observation?.screen?.id ?? latestObservationScreenId(sessionId),
    )
  }
  const screenId = observation?.screen?.id
  if (action === 'sequence') {
    const executed = []
    let warning = ''
    for (const [index, step] of plan.steps.entries()) {
      // The brake can be hit in the middle of a batch; stop cleanly and say so.
      if (readPause().paused) {
        warning = 'desktop control was paused during the sequence, so later steps were skipped'
        break
      }
      const proof = await linuxAdapter.prove(observation, options)
      if (!proof.ok) return linuxRefusal(action, proof, { steps: executed, blockedStep: index + 1 })
      const dispatched = await linuxAdapter.dispatch({
        observation,
        action: step.action,
        args: step.args,
        isDshWindow: isDshWindowInfo,
        pausePath,
      })
      if (!dispatched.ok) return linuxRefusal(action, dispatched, { steps: executed, blockedStep: index + 1 })
      executed.push({ action: step.action, detail: dispatched.detail })
      await linuxAdapter.stepPause()
    }
    const result = await linuxObservationAfter(sessionId, action, String(plan.detail ?? 'sequence'), screenId)
    result.steps = executed
    if (warning) result.warning = warning
    return result
  }
  const proof = await linuxAdapter.prove(observation, options)
  if (!proof.ok) return linuxRefusal(action, proof)
  // Dispatch the validated/normalized plan, not the raw arguments: a string
  // delta or an unrounded coordinate would otherwise reach the backend and
  // change what the action does.
  const dispatched = await linuxAdapter.dispatch({
    observation,
    action: plan?.action ?? action,
    args: plan?.args ?? args,
    isDshWindow: isDshWindowInfo,
    pausePath,
  })
  if (!dispatched.ok) return linuxRefusal(action, dispatched)
  return await linuxObservationAfter(sessionId, action, dispatched.detail, screenId)
}

async function inputCheck() {
  if (LINUX) return await linuxInputCheck()
  if (UNSUPPORTED) {
    return {
      ok: false,
      action: 'inputcheck',
      code: 'unsupported_platform',
      message: `Desktop control is not available: ${backend.reason ?? `the ${process.platform} platform is not supported yet`}.`,
      guidance: 'Use this plugin on Windows or Linux/X11.',
      foreground: '',
      provider: await providerSlotReport(),
    }
  }
  const brake = await ensureBrake()
  const staging = ensureHelperDirectory()
  const localAppData = process.env.LOCALAPPDATA || ''
  const underLocalAppData = Boolean(localAppData) && staging.toLowerCase().startsWith(localAppData.toLowerCase())
  const body = [
    '$rid = [CuNative]::IntegrityRid()',
    "$level = 'unknown'",
    "if ($rid -ge 0x4000) { $level = 'system' } elseif ($rid -ge 0x3000) { $level = 'high' } elseif ($rid -ge 0x2000) { $level = 'medium' } elseif ($rid -ge 0x1000) { $level = 'low' }",
    '$locked = [CuNative]::DesktopLocked()',
    `$paused = Test-Path -LiteralPath '${psQuote(pauseFilePath())}'`,
    // Never inject even a no-op move while the user paused control or while the
    // workstation is locked: the probe would be discarded (or, worse, land).
    'if ($paused -or $locked) { $landed = -1 } else { $landed = [CuNative]::ProbeSend() }',
    '$first = New-Object CuNative+POINT',
    '[CuNative]::GetCursorPos([ref]$first) | Out-Null',
    'Start-Sleep -Milliseconds 220',
    '$second = New-Object CuNative+POINT',
    '[CuNative]::GetCursorPos([ref]$second) | Out-Null',
    '$drift = ($first.X -ne $second.X) -or ($first.Y -ne $second.Y)',
    '$sessionId = [int](Get-Process -Id $PID).SessionId',
    '$payload = @{ integrity = @{ level = $level; rid = $rid; sessionId = $sessionId }; locked = $locked; paused = $paused; landed = @{ dispatched = $(if ($landed -ge 0) { 1 } else { 0 }); confirmed = ($landed -ge 1) }; pointerDrifting = $drift; cursor = @{ x = [int]$second.X; y = [int]$second.Y }; foreground = [CuNative]::ForegroundTitle() }',
    '$payload | ConvertTo-Json -Compress -Depth 6',
  ].join('\n')
  let output
  try {
    output = await runPowerShell(body, { timeoutMs: 30_000 })
  } catch (error) {
    return {
      ok: false,
      action: 'inputcheck',
      code: 'inputcheck_failed',
      message: `The input self-check could not run: ${messageOf(error).slice(0, 400)}`,
      guidance: 'Retry once; if it keeps failing, ask the user to check the desktop session.',
      foreground: '',
      provider: await providerSlotReport(),
    }
  }
  const check = {
    staging: { directory: staging, underLocalAppData },
    integrity: {
      level: String(output.integrity?.level ?? 'unknown'),
      rid: Number(output.integrity?.rid) || -1,
      sessionId: Number(output.integrity?.sessionId) || 0,
    },
    locked: output.locked === true,
    landed: {
      dispatched: Number(output.landed?.dispatched) || 0,
      confirmed: output.landed?.confirmed === true,
    },
    pointerDrifting: output.pointerDrifting === true,
    paused: output.paused === true || readPause().paused,
    brake,
  }
  const problems = []
  if (!check.paused && !check.locked && !check.landed.confirmed) problems.push('SendInput did not confirm dispatch')
  if (check.locked) problems.push('the workstation is locked or on a secure desktop')
  if (!underLocalAppData) problems.push('the helper is not staged under %LOCALAPPDATA%')
  if (!brake || !brake.registered) problems.push(brake && brake.error ? brake.error : 'the emergency hotkey is not registered')
  const healthy = problems.length === 0
  const problemText = problems.join('; ')
  return {
    ok: healthy,
    action: 'inputcheck',
    detail: healthy ? (check.paused ? 'input path healthy; desktop control is paused' : 'input path healthy') : `problems: ${problemText}`,
    ...(healthy ? {} : { code: 'inputcheck_failed', message: `The input self-check found: ${problemText}.` }),
    guidance: healthy
      ? check.paused
        ? 'Desktop control is paused by the user; ask them to resume it from the DSH 桌面操作 tab before acting.'
        : 'Desktop input is available; take a screenshot and act normally.'
      : 'Address these before driving the desktop; a locked session or a Low-integrity helper cannot deliver SendInput.',
    foreground: String(output.foreground ?? ''),
    cursor: { x: Number(output.cursor?.x) || 0, y: Number(output.cursor?.y) || 0 },
    check,
    provider: await providerSlotReport(),
  }
}

// ---------------------------------------------------------------------------
// Linux input self-check (mapped onto the shared inputcheck result shape)
// ---------------------------------------------------------------------------

async function linuxInputCheck() {
  const brake = await ensureBrake()
  let result
  try {
    result = await linuxAdapter.inputCheck({ pausePath: pauseFilePath(), brake })
  } catch (error) {
    return {
      ok: false,
      action: 'inputcheck',
      code: 'inputcheck_failed',
      message: `The input self-check could not run: ${messageOf(error).slice(0, 400)}`,
      guidance: 'Retry once; if it keeps failing, ask the user to check the desktop session.',
      foreground: '',
      provider: await providerSlotReport(),
    }
  }
  const healthy = result.ok === true
  return {
    ok: healthy,
    action: 'inputcheck',
    detail: result.detail,
    ...(healthy ? {} : { code: 'inputcheck_failed', message: result.message }),
    guidance: result.guidance,
    foreground: String(result.foreground ?? ''),
    cursor: result.cursor ?? { x: 0, y: 0 },
    check: result.check,
    provider: await providerSlotReport(),
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  pluginContext = ctx
  // Reserve the process's sole computer-use provider slot whenever this
  // composition mounts that service; the desktop tools below do not depend on
  // it, so a profile without the seam still gets working input tools. A second
  // computer-use plugin may already own the slot: record the conflict instead of
  // failing the plugin, and report it from inputcheck and the status route.
  ctx.inject(['computerUse'], (inner) => {
    inner.effect(() => {
      try {
        const dispose = inner.computerUse.register(PROVIDER_NAME)
        providerSlotState = { status: 'registered', error: '' }
        return () => {
          providerSlotState = { status: 'waiting', error: '' }
          if (typeof dispose === 'function') dispose()
        }
      } catch (error) {
        providerSlotState = { status: 'conflict', error: messageOf(error).slice(0, 300) }
        return () => {
          providerSlotState = { status: 'waiting', error: '' }
        }
      }
    }, 'computer-use: provider slot')
  })
  // Chat cards embed captured screenshots; the browser fetches them through
  // this authenticated route. The status route is the user's pause/resume
  // channel and must never be exposed as a model tool.
  ctx.inject(['connection'], (inner) => {
    inner.effect(() => {
      const disposers = [
        inner.connection.fetch.register({
          path: SHOT_ROUTE,
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: (request) => serveScreenshot(request),
        }),
        inner.connection.fetch.register({
          path: STATUS_ROUTE,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: (request) => serveStatus(request),
        }),
        // The 「桌面」view's per-conversation switch: read/write the same
        // capability-toggles.json entry that the tools' `when` predicate reads.
        inner.connection.fetch.register({
          path: CAPABILITY_ROUTE,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: (request) => serveCapability(request),
        }),
      ]
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }, 'computer-use: routes')
  })
  ctx.effect(() => {
    // Opt-in per conversation: the tools exist only while the user (or an
    // approved capability request) enabled computer use for this Session.
    const when = ({ agent }) => computerUseEnabled(agent)
    const disposers = [
      ctx.tools.register(screenshotTool, { when }),
      ctx.tools.register(computerTool, { when }),
    ]
    return () => {
      stopBrake()
      if (LINUX) linuxAdapter.disposeClipboard()
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'computer-use: desktop tools')
}

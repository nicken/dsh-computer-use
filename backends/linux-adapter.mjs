/**
 * dsh-computer-use — Linux / X11 adapter.
 *
 * The glue between the platform-agnostic tool layer in `index.js` and the X11
 * primitives in `linux-x11.mjs`. Everything here is Node-side and dependency
 * free; the tool layer keeps ownership of observation tokens, intent/risk
 * policy, audit, pause and the provider slot.
 *
 * Responsibilities:
 *   - `capture()`  one monitor -> the capture shape index.js mints tokens from
 *   - `validate()` pure argument validation (same rules as the Windows script
 *                  builder, so no invalid call ever reaches the desktop)
 *   - `prove()`    re-prove the observed state immediately before dispatch
 *                  (foreground handle + bounds + sampled pixels), fail closed
 *   - `dispatch()` point/foreground guards + one real X11 action
 *   - `inputCheck()` map the backend self-check onto the tool's result shape
 *
 * Coordinate contract (see CONTRACT.md): every tool-level coordinate is LOCAL
 * to the captured monitor; the adapter adds `screen.x/y` before injecting.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import * as x11 from './linux-x11.mjs'

export const name = 'linux-x11'

const HELPER_DIR = dirname(fileURLToPath(import.meta.url))
const CLIPBOARD_HELPER = join(HELPER_DIR, 'clipboard.py')
const PYTHON = process.env.DSH_COMPUTER_USE_PYTHON || 'python3'

export const INPUT_ACTIONS = ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key']

/**
 * Pointer-moving operations must not interleave: inputCheck warps the pointer
 * to probe the input path, and a dispatch could otherwise race it (or the
 * reverse). Every operation that injects XTest input goes through this queue.
 */
let pointerQueue = Promise.resolve()
function withPointerLock(fn) {
  const run = pointerQueue.then(fn, fn)
  pointerQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Pause between two sequence steps; mirrors the Windows helper's 110 ms. */
const STEP_PAUSE_MS = 110

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

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

function rectString(rect) {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`
}

/**
 * Tool coordinates are LOCAL to the observed monitor (CONTRACT 1.2). A point
 * outside it would silently land on another monitor (or on the root window)
 * after the adapter adds the offset, so it is rejected before any warp.
 */
function assertInside(screen, x, y, label) {
  if (!screen || !Number.isFinite(Number(screen.width)) || !Number.isFinite(Number(screen.height))) return
  const width = Number(screen.width)
  const height = Number(screen.height)
  if (x >= 0 && x < width && y >= 0 && y < height) return
  throw new Error(
    `${label} (${x}, ${y}) is outside the observed monitor ${screen.id ?? ''} (${width}x${height}); ` +
      'take a screenshot of the monitor you want to act on',
  )
}

function pid() {
  return process.pid
}

function tempProofPath() {
  return join(tmpdir(), `dsh-cu-proof-${pid()}-${randomBytes(4).toString('hex')}.png`)
}

function unlinkQuiet(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // A leftover temp file is harmless.
  }
}

/* ------------------------------------------------------------------ */
/* argument validation (pure — no desktop access)                      */
/* ------------------------------------------------------------------ */

function validateKeys(keys) {
  const parts = String(keys ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error('"keys" must name at least one key, for example "Ctrl+Shift+I"')
  // A lone modifier is valid for parity with the Windows resolveKey (xdotool
  // presses and releases it); only the non-final parts must be modifiers.
  x11.resolveKeyToken(parts[parts.length - 1])
  for (const part of parts.slice(0, -1)) {
    const resolved = x11.resolveKeyToken(part)
    if (resolved.kind !== 'modifier') throw new Error(`"${part}" is not a modifier; use Ctrl, Shift, Alt or Win`)
  }
  return `pressed ${keys}`
}

/**
 * Validate one input action (or the wait/sequence flow actions) exactly like
 * the Windows plan builder does, and return what to run plus a human detail.
 * Throws on invalid arguments; never touches the desktop.
 */
export function validate(action, args, limits = {}) {
  const maxTypeLength = Number(limits.maxTypeLength) || 4000
  const maxSequenceSteps = Number(limits.maxSequenceSteps) || 20
  const maxSequenceText = Number(limits.maxSequenceText) || 8000
  const screen = limits.screen ?? null

  const one = (stepAction, stepArgs) => {
    switch (stepAction) {
      case 'move': {
        const x = requiredNumber(stepArgs, 'x')
        const y = requiredNumber(stepArgs, 'y')
        assertInside(screen, x, y, 'move target')
        return {
          action: stepAction,
          args: { x, y },
          detail: `moved the cursor to (${x}, ${y})`,
        }
      }
      case 'click':
      case 'double_click':
      case 'right_click': {
        const x = requiredNumber(stepArgs, 'x')
        const y = requiredNumber(stepArgs, 'y')
        assertInside(screen, x, y, 'click target')
        const label = stepAction === 'right_click' ? 'right' : 'left'
        const twice = stepAction === 'double_click' ? ' twice' : ''
        return {
          action: stepAction,
          args: { x, y },
          detail: `clicked${twice} ${label} at (${x}, ${y})`,
        }
      }
      case 'drag': {
        const x = requiredNumber(stepArgs, 'x')
        const y = requiredNumber(stepArgs, 'y')
        const toX = requiredNumber(stepArgs, 'toX')
        const toY = requiredNumber(stepArgs, 'toY')
        assertInside(screen, x, y, 'drag start')
        assertInside(screen, toX, toY, 'drag end')
        return {
          action: stepAction,
          args: { x, y, toX, toY },
          detail: `dragged from (${x}, ${y}) to (${toX}, ${toY})`,
        }
      }
      case 'scroll': {
        const delta = optionalNumber(stepArgs, 'delta') ?? -120
        const x = optionalNumber(stepArgs, 'x')
        const y = optionalNumber(stepArgs, 'y')
        const anchor = x !== undefined && y !== undefined ? { x, y } : {}
        if (x !== undefined && y !== undefined) assertInside(screen, x, y, 'scroll anchor')
        return {
          action: stepAction,
          args: { delta, ...anchor },
          detail: `scrolled ${delta < 0 ? 'down' : 'up'} by ${Math.abs(delta)}${x !== undefined ? ` at (${x}, ${y})` : ''}`,
        }
      }
      case 'type': {
        const text = String(stepArgs?.text ?? '')
        if (!text) throw new Error('"text" is required for the type action')
        if (text.length > maxTypeLength) throw new Error(`"text" is limited to ${maxTypeLength} characters per call`)
        return { action: stepAction, args: { text }, detail: `typed ${text.length} character(s)` }
      }
      case 'key': {
        const keys = String(stepArgs?.keys ?? '')
        return { action: stepAction, args: { keys }, detail: validateKeys(keys) }
      }
      default:
        throw new Error(`unsupported action "${stepAction}"`)
    }
  }

  if (action === 'wait') {
    const ms = optionalNumber(args, 'ms') ?? 500
    if (ms < 1 || ms > 30_000) throw new Error('"ms" must be between 1 and 30000')
    return { action, ms, detail: `waited ${ms} ms`, guards: [] }
  }
  if (action === 'sequence') {
    const steps = args?.steps
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('"steps" must contain at least one step')
    if (steps.length > maxSequenceSteps) throw new Error(`"steps" is limited to ${maxSequenceSteps} steps per call`)
    let textBudget = 0
    const planned = []
    for (const [index, step] of steps.entries()) {
      const stepAction = typeof step?.action === 'string' ? step.action.trim() : ''
      if (!INPUT_ACTIONS.includes(stepAction)) {
        throw new Error(`step ${index + 1}: action must be one of ${INPUT_ACTIONS.join(', ')}`)
      }
      if (step && (step.state_id !== undefined || step.steps !== undefined || step.action === 'sequence')) {
        throw new Error(`step ${index + 1}: a step cannot carry state_id, steps or nest sequence`)
      }
      if (typeof step?.text === 'string') textBudget += step.text.length
      planned.push(one(stepAction, step))
    }
    if (textBudget > maxSequenceText) {
      throw new Error(`the sequence carries ${textBudget} characters of text; the limit is ${maxSequenceText}`)
    }
    return {
      action,
      steps: planned,
      detail: planned.map((step) => `${step.action}: ${step.detail}`).join('; '),
      guards: [],
    }
  }
  const planned = one(action, args)
  return { ...planned, guards: [] }
}

/* ------------------------------------------------------------------ */
/* clipboard (text injection without XIM/ibus in the way)              */
/* ------------------------------------------------------------------ */

/** A clipboard owner left behind to restore the user's previous clipboard. */
let clipboardRestorer = null

function base64Text(text) {
  return Buffer.from(String(text), 'utf8').toString('base64')
}

/** Read the X11 clipboard as UTF-8 text; '' when nothing readable is owned. */
export async function clipboardGet(timeoutSeconds = 2.5) {
  return await new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let child
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        child?.kill('SIGTERM')
      } catch {
        // already gone
      }
      resolve(value)
    }
    try {
      child = spawn(PYTHON, [CLIPBOARD_HELPER, 'get', String(timeoutSeconds)], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      finish('')
      return
    }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', () => finish(''))
    child.on('exit', () => {
      const encoded = stdout.trim()
      if (encoded === '') return finish('')
      try {
        finish(Buffer.from(encoded, 'base64').toString('utf8'))
      } catch {
        finish('')
      }
    })
    setTimeout(() => finish(''), (timeoutSeconds + 1.5) * 1000).unref?.()
  })
}

/**
 * Own the clipboard with `text`, wait until the owner is serving, and return
 * the helper process (the caller pastes, then terminates it).
 */
async function clipboardOwn(text, holdSeconds) {
  const child = spawn(PYTHON, [CLIPBOARD_HELPER, 'set', base64Text(text), String(holdSeconds)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 1_000) stderr += String(chunk)
  })
  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('the clipboard helper did not become ready in time'))
    }, 4_000)
    child.stdout.on('data', (chunk) => {
      if (settled) return
      if (!String(chunk).includes('READY')) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`the clipboard helper exited (${code}): ${stderr.trim().slice(0, 200)}`))
    })
  })
  return child
}

async function restoreClipboard(previous) {
  try {
    clipboardRestorer?.kill('SIGTERM')
  } catch {
    // already gone
  }
  clipboardRestorer = null
  if (!previous) return
  try {
    const child = spawn(PYTHON, [CLIPBOARD_HELPER, 'set', base64Text(previous), '600'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.unref()
    clipboardRestorer = child
  } catch {
    // Restoration is best effort: the text was already pasted.
  }
}

/** Stop the clipboard restorer (called from the plugin disposer). */
export function disposeClipboard() {
  try {
    clipboardRestorer?.kill('SIGTERM')
  } catch {
    // already gone
  }
  clipboardRestorer = null
}

/**
 * Type text through the clipboard: own CLIPBOARD, press Ctrl+V, then restore
 * the previous clipboard. This is the tool-facing `type` semantics (the model
 * asks to type, not to paste) but the injection avoids XIM/ibus, which would
 * otherwise turn "a.b.c" into pinyin candidates and drop the dots.
 *
 * Falls back to raw xdotool keys for ASCII when the clipboard helper is
 * unavailable; CJK then fails closed with a clear code.
 */
export async function typeText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: 'invalid_args', detail: '"text" is required for the type action' }
  }
  const previous = await clipboardGet()
  let owner = null
  try {
    owner = await clipboardOwn(text, 15)
    const pasted = await x11.pressKeys('ctrl+v')
    if (!pasted.ok) throw new Error(`Ctrl+V failed: ${pasted.detail ?? pasted.code ?? 'unknown'}`)
    await delay(180)
    return { ok: true, detail: `typed ${text.length} character(s)` }
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 200)
    const ascii = /^[\x20-\x7e\r\n\t]*$/.test(text)
    if (ascii) {
      const raw = await x11.typeText(text)
      if (raw.ok) {
        return {
          ok: true,
          detail: `typed ${text.length} character(s)`,
          warning: `clipboard paste unavailable (${reason}); raw key events were used and an active input method may mangle them`,
        }
      }
      return raw
    }
    return { ok: false, code: 'clipboard_unavailable', detail: `text injection needs the clipboard helper: ${reason}` }
  } finally {
    try {
      owner?.kill('SIGTERM')
    } catch {
      // already gone
    }
    await restoreClipboard(previous)
  }
}

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Capture one monitor and return the shape index.js mints observation tokens
 * from. `foreground` is deliberately trimmed to the Windows shape (title,
 * process, handle, rect) because the tool's output schema is shared; the richer
 * X11 facts (classes, pid) stay in the self-check.
 *
 * Optional `region` + `scale` return only the requested part of the monitor to
 * keep the model's image context small. The observation token still binds the
 * whole monitor (fingerprint sampled from the full frame), so acting keeps the
 * same monitor-local coordinate contract; `originX/originY` describe the crop.
 */
export async function capture({ path, screenId, region, scale }) {
  const screens = await x11.listScreens()
  const screen = x11.pickScreen(screens, screenId)
  const wantRegion = region !== undefined && region !== null
  const ratio = scale === undefined || scale === null ? 1 : Number(scale)
  if (wantRegion && (typeof region !== 'object' || Array.isArray(region))) throw new Error('"region" must be an object')
  if (wantRegion && (!Number.isFinite(ratio) || ratio <= 0)) throw new Error('"scale" must be a positive number')
  const fullPath = wantRegion ? `${path}.full.png` : path
  const observation = await x11.observe(screens, screenId, fullPath)
  // Fingerprint first (and decode once if a region crop is needed).
  let fingerprint = observation.fingerprint
  let fingerprintTarget = 'window'
  const needsPixels = fingerprint === '' || wantRegion
  let fullPng = null
  if (needsPixels) {
    try {
      fullPng = x11.decodePng(readFileSync(fullPath))
    } catch {
      fullPng = null
    }
  }
  if (fingerprint === '' && fullPng) {
    fingerprint = x11.fingerprintOfScreen(fullPng)
    fingerprintTarget = fingerprint === '' ? 'none' : 'screen'
  }
  let geometry = {
    path,
    width: observation.width,
    height: observation.height,
    originX: observation.originX,
    originY: observation.originY,
  }
  let regionInfo = null
  if (wantRegion) {
    if (fullPng === null) throw new Error('could not decode the screenshot for region cropping')
    const crop = {
      x: Math.round(Number(region.x)),
      y: Math.round(Number(region.y)),
      width: Math.round(Number(region.width)),
      height: Math.round(Number(region.height)),
    }
    if (Object.values(crop).some((value) => !Number.isFinite(value))) {
      throw new Error('"region" needs finite x, y, width and height')
    }
    if (
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width < 1 ||
      crop.height < 1 ||
      crop.x + crop.width > observation.width ||
      crop.y + crop.height > observation.height
    ) {
      throw new Error(`"region" is outside the ${observation.width}x${observation.height} monitor`)
    }
    let image = x11.cropImage(fullPng, crop)
    if (ratio !== 1) image = x11.scaleImage(image, ratio)
    writeFileSync(path, x11.encodePng(image))
    unlinkQuiet(fullPath)
    geometry = {
      path,
      width: image.width,
      height: image.height,
      originX: observation.originX + crop.x,
      originY: observation.originY + crop.y,
    }
    regionInfo = { ...crop, ...(ratio !== 1 ? { scale: ratio } : {}) }
  }
  return {
    ...geometry,
    screen: observation.screen,
    screens: observation.screens,
    cursor: { x: observation.cursor.x, y: observation.cursor.y },
    foreground: {
      title: observation.foreground.title,
      process: observation.foreground.process,
      handle: observation.foreground.handle,
      rect: observation.foreground.rect,
    },
    fingerprint,
    fingerprintTarget,
    ...(regionInfo ? { region: regionInfo } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* proof: fail closed when the observed state changed                  */
/* ------------------------------------------------------------------ */

/**
 * Re-prove the observed foreground window and its sampled pixels right before
 * dispatch. The pixel sample only needs the window rectangle, so this captures
 * (and decodes) that small area instead of the whole monitor: ~200 ms on a
 * 2560x1440 screen, which keeps per-step sequence checks affordable.
 *
 * Returns `{ ok: true }` or `{ ok: false, code, message, guidance }`.
 */
export async function prove(observation, options = {}) {
  const tolerance = Number.isFinite(options.fingerprintTolerance) ? options.fingerprintTolerance : 8
  const screen = observation?.screen
  const expected = observation?.foreground
  if (!screen || !expected) {
    return {
      ok: false,
      code: 'observation_expired',
      message: 'The observation token does not carry the X11 monitor state any more.',
      guidance: 'Call computer_screenshot again and use the new state_id.',
    }
  }
  const current = await x11.foregroundWindow()
  if (!current.ok) {
    return {
      ok: false,
      code: 'foreground_unreadable',
      message: `The foreground window could not be read: ${current.reason ?? 'unknown'}.`,
      guidance: 'Ask the user to focus the target application, then take a new screenshot.',
    }
  }
  // The monitor layout can change after the screenshot (hotplug, rotation,
  // rearranged xrandr): the same window bounds would then map to a different
  // monitor, so re-read the layout and require the observed geometry.
  let screens
  try {
    screens = await x11.listScreens()
  } catch (error) {
    return {
      ok: false,
      code: 'layout_unreadable',
      message: `The monitor layout could not be re-read: ${String(error?.message ?? error).slice(0, 300)}`,
      guidance: 'Retry once; if it keeps failing, run the inputcheck action.',
    }
  }
  const screenNow = screens.find((candidate) => candidate.id === screen.id)
  if (
    screenNow === undefined ||
    screenNow.x !== screen.x ||
    screenNow.y !== screen.y ||
    screenNow.width !== screen.width ||
    screenNow.height !== screen.height
  ) {
    return {
      ok: false,
      code: 'stale_observation',
      message: 'The observed state is stale (layout): the monitor layout changed after the screenshot.',
      guidance: 'Call computer_screenshot again and use the new state_id.',
      foreground: current.title,
    }
  }
  if (String(current.handle) !== String(expected.handle)) {
    return {
      ok: false,
      code: 'stale_observation',
      message: 'The observed state is stale (window): the foreground window changed after the screenshot.',
      guidance: 'Call computer_screenshot again and use the new state_id.',
      foreground: current.title,
    }
  }
  const rect = rectString(current.rect)
  if (rect !== String(expected.rect)) {
    return {
      ok: false,
      code: 'stale_observation',
      message: 'The observed state is stale (bounds): the foreground window moved or was resized after the screenshot.',
      guidance: 'Call computer_screenshot again and use the new state_id.',
      foreground: current.title,
    }
  }
  const expectedFingerprint = String(observation?.fingerprint ?? '')
  const fingerprintTarget = String(observation?.fingerprintTarget ?? 'window')
  if (expectedFingerprint !== '') {
    const path = tempProofPath()
    try {
      let actual
      let staleMessage
      if (fingerprintTarget === 'screen') {
        // Whole-monitor sample: detects windows appearing/disappearing or the
        // screen switching, even though the foreground window is elsewhere.
        await x11.captureScreen(screenNow, path)
        actual = x11.fingerprintOfScreen(x11.decodePng(readFileSync(path)))
        staleMessage = `The observed state is stale (screen:${actual === '' ? 'unverifiable' : 'changed'}): the monitored screen changed after the screenshot.`
      } else {
        const clip = {
          x: Math.max(current.rect.x, screenNow.x),
          y: Math.max(current.rect.y, screenNow.y),
          width: Math.min(current.rect.x + current.rect.width, screenNow.x + screenNow.width) - Math.max(current.rect.x, screenNow.x),
          height: Math.min(current.rect.y + current.rect.height, screenNow.y + screenNow.height) - Math.max(current.rect.y, screenNow.y),
        }
        if (clip.width < 9 || clip.height < 9) {
          return { ok: true }
        }
        await x11.captureScreen(clip, path)
        const png = x11.decodePng(readFileSync(path))
        const localScreen = { x: clip.x, y: clip.y, width: clip.width, height: clip.height }
        actual = x11.fingerprintOfWindow(png, localScreen, current.rect)
        staleMessage = `The observed state is stale (pixels:changed): the visible window content changed after the screenshot.`
      }
      if (actual !== '') {
        const changed = x11.compareFingerprint(expectedFingerprint, actual, 40)
        if (changed > tolerance) {
          return {
            ok: false,
            code: 'stale_observation',
            message: fingerprintTarget === 'screen'
              ? `The observed state is stale (screen:${changed} cells): the monitored screen changed after the screenshot.`
              : `The observed state is stale (pixels:${changed}): the visible window content changed after the screenshot.`,
            guidance: 'Call computer_screenshot again and use the new state_id.',
            foreground: current.title,
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        code: 'observation_unverifiable',
        message: `The observed state could not be re-checked before dispatch: ${String(error?.message ?? error).slice(0, 300)}`,
        guidance: 'Retry once; if it keeps failing, run the inputcheck action and check the X11 tooling.',
      }
    } finally {
      unlinkQuiet(path)
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* dispatch guards                                                     */
/* ------------------------------------------------------------------ */

async function pointBlocked(screen, localX, localY, isDshWindow) {
  const landed = await x11.warpTo(screen, localX, localY)
  if (!landed.ok) {
    return {
      ok: false,
      code: 'pointer_warp_unstable',
      message: `The pointer could not be placed at (${localX}, ${localY}) on ${screen.id}; refusing to click blindly.`,
      guidance: 'Take a new screenshot and retry; the desktop input path may be busy or the monitor layout changed.',
    }
  }
  const at = await x11.windowAtCursor()
  if (at.ok && at.identified === false) {
    // A WM frame/wrapper without WM_CLASS and title cannot be ruled out as DSH.
    return {
      ok: false,
      code: 'window_unidentified',
      message: `The window under (${localX}, ${localY}) has no readable identity, so it cannot be ruled out as DSH.`,
      guidance: 'Ask the user to confirm the target, or take a new screenshot after the window is fully drawn; the screenshot token was consumed by this attempt, so take a new screenshot before acting again.',
    }
  }
  if (at.ok && isDshWindow(at)) {
    return {
      ok: false,
      code: 'dsh_window_blocked',
      message: `The point (${localX}, ${localY}) is inside the DSH window ("${at.title}"), which only the user may operate.`,
      guidance: 'Ask the user to perform this UI action themselves; desktop automation may only drive other applications. The screenshot token was consumed by this attempt, so take a new screenshot before acting again.',
      foreground: at.title,
    }
  }
  if (!at.ok) {
    return {
      ok: false,
      code: 'window_probe_failed',
      message: `The window under (${localX}, ${localY}) could not be identified: ${at.reason ?? 'unknown'}.`,
      guidance: 'Take a new screenshot and retry.',
    }
  }
  return { ok: true }
}

/**
 * Keyboard actions go to whatever window has focus, so a DSH foreground blocks
 * them. Pointer actions are judged by their *target* instead (see pointBlocked):
 * clicking another window or another monitor is allowed while DSH is focused,
 * which matches the desktop's real semantics rather than a blanket rule.
 */
const KEYBOARD_ACTIONS = ['type', 'key']

/**
 * Foreground/point guards that must hold immediately before input is sent.
 * A plain pointer move is harmless and never blocked by the foreground.
 */
export async function guard(screen, action, args, isDshWindow) {
  if (KEYBOARD_ACTIONS.includes(action) && typeof isDshWindow === 'function') {
    const current = await x11.foregroundWindow()
    if (current.ok && isDshWindow(current)) {
      return {
        ok: false,
        code: 'dsh_window_blocked',
        message: `The foreground window is DSH itself ("${current.title}"), which only the user may operate.`,
        guidance: 'Ask the user to perform this UI action themselves; desktop automation may only drive other applications. The screenshot token was consumed by this attempt, so take a new screenshot before acting again.',
        foreground: current.title,
      }
    }
  }
  if (action === 'click' || action === 'double_click' || action === 'right_click') {
    const x = requiredNumber(args, 'x')
    const y = requiredNumber(args, 'y')
    return await pointBlocked(screen, x, y, isDshWindow)
  }
  if (action === 'drag') {
    const first = await pointBlocked(screen, requiredNumber(args, 'x'), requiredNumber(args, 'y'), isDshWindow)
    if (!first.ok) return first
    return await pointBlocked(screen, requiredNumber(args, 'toX'), requiredNumber(args, 'toY'), isDshWindow)
  }
  if (action === 'scroll') {
    const x = optionalNumber(args, 'x')
    const y = optionalNumber(args, 'y')
    if (x !== undefined && y !== undefined) return await pointBlocked(screen, x, y, isDshWindow)
    const at = await x11.windowAtCursor()
    if (at.ok && typeof isDshWindow === 'function' && isDshWindow(at)) {
      return {
        ok: false,
        code: 'dsh_window_blocked',
        message: `The scroll anchor is inside the DSH window ("${at.title}"), which only the user may operate.`,
        guidance: 'Ask the user to perform this UI action themselves. The screenshot token was consumed by this attempt, so take a new screenshot before acting again.',
        foreground: at.title,
      }
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run one real X11 input action on the observed monitor. The caller has already
 * proven the observation; this adds the point/foreground guards and injects.
 */
export async function dispatch(options) {
  return withPointerLock(() => dispatchLocked(options))
}

async function dispatchLocked({ observation, action, args, isDshWindow, pausePath }) {
  const screen = observation?.screen
  if (!screen) {
    return { ok: false, code: 'observation_expired', message: 'The observation token has no monitor attached.', guidance: 'Take a new screenshot.' }
  }
  // The user can hit pause at any point (including while an approval prompt or
  // the stale-proof capture is pending), so the brake is re-read here, directly
  // before the first pixel moves — the Windows helper does the same.
  if (typeof pausePath === 'string' && pausePath !== '' && existsSync(pausePath)) {
    return {
      ok: false,
      code: 'paused',
      message: 'Desktop control is paused by the user.',
      guidance: 'Only the user can release the pause from the DSH desktop tab. Do not retry until then.',
    }
  }
  // A locked session silently discards injected input; refuse instead of
  // reporting a success the user never sees (the Windows DesktopLocked analog).
  try {
    const lock = await x11.lockState()
    if (lock.locked === true) {
      return {
        ok: false,
        code: 'desktop_locked',
        message: `The X session is locked (${lock.source ?? 'lock screen'}), so injected input would be discarded.`,
        guidance: 'Ask the user to unlock the session, then take a new screenshot and retry.',
      }
    }
  } catch {
    // Best effort: the lock probe is a safety net, not a dependency.
  }
  // Defense in depth: validate() already rejects out-of-monitor points, but the
  // layout could have changed between validation and injection.
  if (['move', 'click', 'double_click', 'right_click', 'drag', 'scroll'].includes(action)) {
    try {
      if (Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y))) {
        assertInside(screen, Math.round(Number(args.x)), Math.round(Number(args.y)), 'target')
      }
      if (action === 'drag') {
        assertInside(screen, Math.round(Number(args?.toX)), Math.round(Number(args?.toY)), 'drag end')
      }
    } catch (error) {
      return { ok: false, code: 'invalid_args', message: String(error?.message ?? error), guidance: 'Take a screenshot of the monitor you want to act on.' }
    }
  }
  const blocked = await guard(screen, action, args, isDshWindow)
  if (!blocked.ok) return blocked
  if (action === 'type') {
    // Clipboard paste, so XIM/ibus cannot mangle the text (the tool still says
    // "type": how it is injected is an implementation detail for the model).
    const typed = await typeText(String(args?.text ?? ''))
    if (!typed.ok) {
      return {
        ok: false,
        code: typeof typed.code === 'string' ? typed.code : 'type_failed',
        message: String(typed.detail ?? 'The type action failed.'),
        guidance: 'Retry once after taking a new screenshot; if it keeps failing, run the inputcheck action.',
      }
    }
    return { ok: true, detail: String(typed.detail ?? 'typed text'), ...(typed.warning ? { warning: typed.warning } : {}) }
  }
  const result = await x11.dispatch(screen, action, args ?? {})
  if (!result.ok) {
    return {
      ok: false,
      code: typeof result.code === 'string' ? result.code : 'action_failed',
      message: typeof result.detail === 'string' && result.detail !== '' ? result.detail : `The ${action} action failed.`,
      guidance: 'Retry once with a fresh screenshot; if it keeps failing, run the inputcheck action.',
      ...(typeof result.detail === 'string' ? { detail: result.detail } : {}),
    }
  }
  return { ok: true, detail: String(result.detail ?? action) }
}

/**
 * Cursor + foreground title read without a screenshot: used when the follow-up
 * capture fails, so the result still reports where the desktop actually is.
 */
export async function readCursorForeground() {
  let cursor = { x: 0, y: 0 }
  let foreground = ''
  try {
    cursor = await x11.cursorPosition()
  } catch {
    // best effort
  }
  try {
    const current = await x11.foregroundWindow()
    if (current.ok) foreground = current.title
  } catch {
    // best effort
  }
  return { cursor, foreground }
}

export async function stepPause() {
  await delay(STEP_PAUSE_MS)
}

/* ------------------------------------------------------------------ */
/* self-check                                                          */
/* ------------------------------------------------------------------ */

/** Map the backend self-check onto the `computer` tool's inputcheck shape. */
export async function inputCheck(options) {
  return withPointerLock(() => inputCheckLocked(options))
}

async function inputCheckLocked({ pausePath, brake }) {
  const result = await x11.inputCheck({ pausePath })
  const problems = Array.isArray(result.problems) ? [...result.problems] : []
  const warnings = Array.isArray(result.warnings) ? [...result.warnings] : []
  const clipboardHelper = existsSync(CLIPBOARD_HELPER)
  if (!clipboardHelper) warnings.push('the clipboard helper (backends/clipboard.py) is missing: `type` falls back to raw key events')
  const healthy = problems.length === 0
  const suffix = warnings.length > 0 ? ` (warnings: ${warnings.join('; ')})` : ''
  return {
    ok: healthy,
    detail: healthy
      ? result.paused === true
        ? `X11 input path healthy; desktop control is paused${suffix}`
        : result.locked === true
          ? `X11 input path healthy; the X session is locked${suffix}`
          : `X11 input path healthy${suffix}`
      : `problems: ${problems.join('; ')}`,
    ...(healthy ? {} : { message: `The input self-check found: ${problems.join('; ')}.` }),
    guidance: healthy
      ? result.paused === true
        ? 'Desktop control is paused by the user; ask them to resume it from the DSH 桌面操作 tab before acting.'
        : result.locked === true
          ? 'The X session is locked; injected input would be discarded. Ask the user to unlock it, then take a screenshot.'
          : 'Desktop input is available; take a screenshot and act normally.'
      : 'Address these before driving the desktop; missing X11 tools or a wrong DISPLAY cannot deliver input.',
    foreground: result.foreground?.title ?? '',
    cursor: result.warp?.after ?? { x: 0, y: 0 },
    check: {
      backend: name,
      display: result.display,
      sessionType: result.sessionType,
      tools: result.tools,
      screens: result.screens,
      root: result.root,
      warp: result.warp,
      capture: result.capture,
      foreground: result.foreground,
      clipboard: { helper: clipboardHelper, python: PYTHON },
      // Detected desktop facts (session type, desktop, tool presence with
      // install hints, python helpers, monitor layout with DPI). Present on
      // every backend that probes its environment; tools and the UI read it to
      // adapt instead of assuming a fixed machine.
      ...(result.environment ? { environment: result.environment } : {}),
      paused: result.paused === true,
      locked: result.locked === true,
      lockSource: result.lockSource ?? null,
      warnings,
      brake,
      // Windows-only diagnostics (staging/integrity) are simply absent on X11:
      // the tool's output schema types them as objects, so `null` would fail
      // validation. "absent" means "not applicable" on this platform.
    },
  }
}

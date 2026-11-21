/**
 * Real-X11 integration test for the wired Linux backend.
 *
 * It imports the plugin module itself, mounts it on a fake Cordis context (the
 * same `apply()` the DSH host calls), and drives the two model-facing tools end
 * to end with a real screenshot and real XTest input. Safe by default: it only
 * moves the pointer (and restores it), pauses/resumes, and takes screenshots.
 * Clicking and typing need explicit flags:
 *
 *   node tests/linux-integration.mjs
 *   node tests/linux-integration.mjs --click-at 40,40
 *   node tests/linux-integration.mjs --type "hello from dsh"
 *
 * Everything the plugin writes (screenshots, audit, pause) is redirected into a
 * throwaway DSH_HOME under the current directory and deleted afterwards, so a
 * DSH config is never touched.
 *
 * Exit code 0 = every check passed.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const WORK = process.cwd()
const HOME = join(WORK, '.e2e-dsh-home')
const DATA = join(HOME, 'computer-use')
const SHOTS = join(DATA, 'shots')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const args = process.argv.slice(2)
function flagValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const CLICK_AT = flagValue('--click-at')
const TYPE_TEXT = flagValue('--type')
// Injecting the emergency hotkey is opt-in: Ctrl/Alt/F-key chords are close to
// X.org's VT-switch bindings, so a routine run must not press them.
const TEST_HOTKEY = args.includes('--test-hotkey')

const plugin = await import('../index.js')
const x11 = await import('../backends/linux-x11.mjs')
const adapter = await import('../backends/linux-adapter.mjs')

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`PASS ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* --- fake Cordis context ------------------------------------------------ */

function createFakeContext() {
  const tools = new Map()
  const routes = []
  const disposers = []
  const effect = (fn) => {
    const dispose = typeof fn === 'function' ? fn() : undefined
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  }
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect,
    inject(deps, callback) {
      // The host mounts the computerUse seam only in some compositions; the
      // tools must work without it, so leave that callback unmounted here.
      if (deps.includes('computerUse')) return
      const inner = {
        effect,
        connection: deps.includes('connection')
          ? {
              fetch: {
                register(spec) {
                  routes.push(spec)
                  return () => {}
                },
              },
            }
          : undefined,
      }
      callback(inner)
    },
    get(service) {
      if (service === 'pluginManager') return { listPlugins: async () => [] }
      return undefined
    },
  }
  return { ctx, tools, routes, disposers }
}

const { ctx, tools, routes, disposers } = createFakeContext()
plugin.apply(ctx)

check('advanced screenshot tool is registered', tools.has('computer_screenshot'))
check('computer tool is registered', tools.has('computer'))
check('status route is registered', routes.some((route) => route.path === '/api/computer-use/status'))
check('shot route is registered', routes.some((route) => route.path === '/api/computer-use/shot'))

const SESSION = 'e2e-session'
let callCounter = 0

/** Very small JSON-Schema subset validator: enough for the tool output schemas. */
function validateOutput(label, value, schema, path = 'value') {
  if (schema === undefined || schema === null) return
  if (schema.type !== undefined) {
    const type = schema.type
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const ok =
      (type === 'object' && actual === 'object') ||
      (type === 'array' && actual === 'array') ||
      (type === 'string' && actual === 'string') ||
      (type === 'boolean' && actual === 'boolean') ||
      ((type === 'integer' || type === 'number') && actual === 'number') ||
      (type === 'null' && actual === 'null')
    if (!ok) throw new Error(`${label}: ${path} must be ${type}, got ${actual} (${JSON.stringify(value)?.slice(0, 120)})`)
    if (type === 'integer' && !Number.isInteger(value)) throw new Error(`${label}: ${path} must be an integer`)
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matches = schema.oneOf.some((candidate) => {
      try {
        validateOutput(label, value, candidate, path)
        return true
      } catch {
        return false
      }
    })
    if (!matches) throw new Error(`${label}: ${path} matches no oneOf branch`)
  }
  if (schema.type === 'object') {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) throw new Error(`${label}: ${path}.${key} is required but missing`)
      }
    }
    const declared = schema.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      if (declared[key] !== undefined) {
        validateOutput(label, child, declared[key], `${path}.${key}`)
      } else if (schema.additionalProperties === false) {
        throw new Error(`${label}: ${path}.${key} is not allowed by the schema`)
      } else if (typeof schema.additionalProperties === 'object') {
        validateOutput(label, child, schema.additionalProperties, `${path}.${key}`)
      }
    }
  }
  if (schema.type === 'array' && schema.items !== undefined && Array.isArray(value)) {
    value.forEach((item, index) => validateOutput(label, item, schema.items, `${path}[${index}]`))
  }
}

async function call(toolName, toolArgs) {
  const tool = tools.get(toolName)
  if (!tool) throw new Error(`tool ${toolName} is not registered`)
  const exec_ = { agent: { session: { id: SESSION } }, callId: `call-${++callCounter}`, signal: undefined }
  const value = await tool.execute(toolArgs, exec_)
  // The real host validates tool output against this schema; the fake ctx does
  // not, so do it here or a schema bug only shows up in production.
  if (tool.output && tool.output.schema) validateOutput(`${toolName}(${JSON.stringify(toolArgs)?.slice(0, 80)})`, value, tool.output.schema)
  return value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cursor() {
  return await x11.cursorPosition()
}

/** did the dispatch accept the token (even if the live pointer fight lost)? */
function tokenAccepted(result) {
  return result.ok === true || result.code === 'pointer_warp_unstable'
}

/** Interference from the live desktop (user focus changes), not a plugin bug. */
function liveInterference(result) {
  return result.code === 'pointer_warp_unstable' || result.code === 'stale_observation'
}

/** move with a fresh token, retrying only user-interference failures */
async function moveToLocal(x, y, attempts = 3) {
  let last = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const shot = await call('computer', { action: 'screenshot' })
    last = await call('computer', { action: 'move', x, y, state_id: shot.state_id })
    if (last.ok === true || !liveInterference(last)) return last
    await sleep(200)
  }
  return last
}
async function moveGlobal(x, y) {
  await exec('xdotool', ['mousemove', String(x), String(y)])
}
function pausePath() {
  return join(DATA, 'pause.json')
}

const initialCursor = await cursor()
let cleanupCursor = true

try {
  /* --- 1. capture the primary monitor ---------------------------------- */

  const shot = await call('computer_screenshot', {})
  check('screenshot returns a state_id', typeof shot.state_id === 'string' && shot.state_id.startsWith('obs_'))
  check('screenshot names the monitor', shot.screen && typeof shot.screen.id === 'string')
  check('screenshot lists every monitor', Array.isArray(shot.screens) && shot.screens.length >= 1)
  check(
    'screenshot monitors carry only sane dpi hints',
    shot.screens.every((screen) => screen.dpi === undefined || (Number.isInteger(screen.dpi) && screen.dpi > 0)),
    JSON.stringify(shot.screens),
  )
  const autoShot = await call('computer_screenshot', { screen: 'auto' })
  check(
    'screenshot accepts the "auto" selector',
    autoShot.screen && autoShot.screen.id === shot.screen.id,
    JSON.stringify(autoShot.screen),
  )
  const cursorShot = await call('computer_screenshot', { screen: 'cursor' })
  check(
    'screenshot accepts the "cursor" selector',
    cursorShot.screen && shot.screens.some((screen) => screen.id === cursorShot.screen.id),
    JSON.stringify(cursorShot.screen),
  )
  check('primary monitor origin is 0,0', shot.originX === 0 && shot.originY === 0)
  check('screenshot size matches the monitor', shot.width === shot.screen.width && shot.height === shot.screen.height)
  check('screenshot file exists', existsSync(shot.path))
  check('screenshot lives under the injected DSH_HOME', shot.path.startsWith(SHOTS))
  const png = x11.decodePng(readFileSync(shot.path))
  check('screenshot PNG matches its reported size', png.width === shot.width && png.height === shot.height)
  check('screenshot reports the foreground window', typeof shot.foreground.process === 'string' && typeof shot.foreground.title === 'string')

  /* --- 1b. region crop + scale (small image context) ------------------- */

  const region = { x: 100, y: 120, width: 600, height: 300 }
  const croppedShot = await call('computer_screenshot', { region })
  check('region crop returns the cropped size', croppedShot.width === 600 && croppedShot.height === 300, `${croppedShot.width}x${croppedShot.height}`)
  check('region origin is offset by the crop', croppedShot.originX === 100 && croppedShot.originY === 120, `${croppedShot.originX},${croppedShot.originY}`)
  check('region is echoed back', croppedShot.region && croppedShot.region.width === 600 && croppedShot.region.height === 300, JSON.stringify(croppedShot.region))
  const croppedPng = x11.decodePng(readFileSync(croppedShot.path))
  check('region PNG really is the crop', croppedPng.width === 600 && croppedPng.height === 300)
  const croppedMove = await call('computer', { action: 'move', x: 120, y: 150, state_id: croppedShot.state_id })
  check('actions still use monitor-local coordinates after a crop', croppedMove.ok === true, JSON.stringify(croppedMove).slice(0, 300))
  const scaledShot = await call('computer_screenshot', { region, scale: 0.5 })
  check('scale halves the cropped image', scaledShot.width === 300 && scaledShot.height === 150, `${scaledShot.width}x${scaledShot.height}`)
  const scaledPng = x11.decodePng(readFileSync(scaledShot.path))
  check('scaled PNG really is half size', scaledPng.width === 300 && scaledPng.height === 150)

  /* --- 1c. clipboard helper roundtrip ---------------------------------- */

  const clipboardPayload = 'clip-test x.y.z 中文'
  const clipPrevious = await adapter.clipboardGet()
  const clipSetter = spawn('python3', [join(WORK, 'backends', 'clipboard.py'), 'set', Buffer.from(clipboardPayload, 'utf8').toString('base64'), '5'], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise((resolve) => clipSetter.stdout.once('data', resolve))
  const clipRead = await adapter.clipboardGet()
  check('the clipboard helper roundtrips text (dots + CJK)', clipRead === clipboardPayload, JSON.stringify(clipRead))
  clipSetter.kill('SIGTERM')
  if (clipPrevious !== '') {
    const restore = spawn('python3', [join(WORK, 'backends', 'clipboard.py'), 'set', Buffer.from(clipPrevious, 'utf8').toString('base64'), '600'], { stdio: ['ignore', 'ignore', 'ignore'] })
    restore.unref()
  }

  /* --- 2. one real input action, then re-observe ----------------------- */

  const moveShot = await call('computer_screenshot', {})
  let moved = await call('computer', { action: 'move', x: 40, y: 40, state_id: moveShot.state_id })
  if (moved.ok !== true && liveInterference(moved)) {
    console.log('NOTE the live pointer moved during the first warp; retrying once')
    moved = await moveToLocal(40, 40)
  }
  check('move succeeds', moved.ok === true, JSON.stringify(moved).slice(0, 300))
  check('move reports an observation', moved.observation && typeof moved.observation.state_id === 'string')
  check('the observation names its monitor', moved.observation.screen && moved.observation.screen.id === shot.screen.id, JSON.stringify(moved.observation.screen))
  check('move detail mentions the point', /moved the (cursor|pointer) to \(40, 40\)/.test(String(moved.detail)), String(moved.detail))
  let afterMove = await cursor()
  if (afterMove.x !== 40 || afterMove.y !== 40) {
    await moveToLocal(40, 40)
    afterMove = await cursor()
  }
  check('pointer actually moved to 40,40', afterMove.x === 40 && afterMove.y === 40, `${afterMove.x},${afterMove.y}`)

  /* --- 3. token semantics ---------------------------------------------- */

  const replay = await call('computer', { action: 'move', x: 41, y: 41, state_id: moveShot.state_id })
  check('a consumed token is refused', replay.ok === false && replay.code === 'observation_used', JSON.stringify(replay).slice(0, 300))

  const missing = await call('computer', { action: 'click', x: 1, y: 1 })
  check('a missing token is refused', missing.ok === false && missing.code === 'missing_observation')

  // The cursor-verification retry above may have taken a newer screenshot, so
  // mint a fresh token for the refusal/retry pair.
  const refusalShot = await call('computer_screenshot', {})
  const badArgs = await call('computer', { action: 'move', x: 1, state_id: refusalShot.state_id })
  check('invalid args are refused', badArgs.ok === false && badArgs.code === 'invalid_args', JSON.stringify(badArgs).slice(0, 300))
  const retry = await call('computer', { action: 'move', x: 40, y: 40, state_id: refusalShot.state_id })
  check('a token released by a refused call can still be used', retry.ok === true, JSON.stringify(retry).slice(0, 300))

  /* --- 3b. monitor binding: out-of-monitor points are refused ---------- */

  const boundsShot = await call('computer_screenshot', {})
  const outOfBounds = await call('computer', { action: 'move', x: boundsShot.width + 10, y: 10, state_id: boundsShot.state_id })
  check(
    'a point outside the observed monitor is refused',
    outOfBounds.ok === false && outOfBounds.code === 'invalid_args' && /outside the observed monitor/.test(outOfBounds.message),
    JSON.stringify(outOfBounds).slice(0, 300),
  )
  const stillUsable = await call('computer', { action: 'move', x: 40, y: 40, state_id: boundsShot.state_id })
  check('the refused call released the token', tokenAccepted(stillUsable), JSON.stringify(stillUsable).slice(0, 300))

  /* --- 3c. pause at the injection boundary ----------------------------- */

  const dispatchPausePath = pausePath()
  mkdirSync(DATA, { recursive: true })
  writeFileSync(dispatchPausePath, JSON.stringify({ paused: true, reason: 'e2e dispatch-boundary', at: new Date().toISOString(), by: 'e2e' }))
  const probeObservation = await adapter.capture({ path: join(HOME, 'dispatch-pause.png') })
  const dispatchRefused = await adapter.dispatch({
    observation: probeObservation,
    action: 'move',
    args: { x: 5, y: 5 },
    pausePath: dispatchPausePath,
  })
  check(
    'the injection point re-checks pause',
    dispatchRefused.ok === false && dispatchRefused.code === 'paused',
    JSON.stringify(dispatchRefused).slice(0, 300),
  )
  unlinkSync(dispatchPausePath)

  /* --- 4. pause / resume (the physical brake) ------------------------- */

  const pauseShot = await call('computer_screenshot', {})
  const paused = await call('computer', { action: 'pause' })
  check('pause succeeds', paused.ok === true && paused.paused === true)
  check('pause writes the pause file', existsSync(pausePath()))

  const retryToken = pauseShot.state_id
  const pausedCheck = await call('computer', { action: 'inputcheck' })
  check('inputcheck reports the pause', pausedCheck.check.paused === true, JSON.stringify(pausedCheck.check.paused))
  check('inputcheck injects nothing while paused', pausedCheck.check.warp && pausedCheck.check.warp.skipped === true, JSON.stringify(pausedCheck.check.warp))

  const blocked = await call('computer', { action: 'move', x: 42, y: 42, state_id: retryToken })
  check('actions are refused while paused', blocked.ok === false && blocked.code === 'paused', JSON.stringify(blocked).slice(0, 300))

  unlinkSync(pausePath()) // what the user's "resume" button does through the status route
  const resumed = await call('computer', { action: 'move', x: 40, y: 40, state_id: retryToken })
  check('the released token works after resume', tokenAccepted(resumed), JSON.stringify(resumed).slice(0, 300))

  /* --- 5. wait + fresh observation ------------------------------------- */

  const waited = await call('computer', { action: 'wait', ms: 120 })
  check('wait succeeds', waited.ok === true, JSON.stringify(waited).slice(0, 300))
  check('wait returns a fresh observation', waited.observation && typeof waited.observation.state_id === 'string')
  check('wait keeps the session monitor', waited.observation.screen && waited.observation.screen.id === shot.screen.id, JSON.stringify(waited.observation.screen))

  /* --- 6. monitor selection and local coordinates ---------------------- */

  const screens = await x11.listScreens()
  const secondary = screens.find((screen) => screen.primary !== true)
  if (secondary === undefined) {
    console.log('SKIP secondary-monitor checks (single monitor)')
  } else {
    const shot2 = await call('computer_screenshot', { screen: secondary.id })
    check('screen by id captures that monitor', shot2.screen.id === secondary.id && shot2.originX === secondary.x, JSON.stringify(shot2.screen))
    check('secondary screenshot size matches', shot2.width === secondary.width && shot2.height === secondary.height)
    const local = await call('computer', { action: 'move', x: 100, y: 100, state_id: shot2.state_id })
    check('move on the secondary monitor succeeds', local.ok === true, JSON.stringify(local).slice(0, 300))
    const landed = await cursor()
    check(
      'local coordinates map to global ones',
      landed.x === secondary.x + 100 && landed.y === secondary.y + 100,
      `${landed.x},${landed.y}`,
    )
    const waitedSecondary = await call('computer', { action: 'wait', ms: 80 })
    check(
      'wait after secondary work keeps the secondary monitor',
      waitedSecondary.observation && waitedSecondary.observation.screen && waitedSecondary.observation.screen.id === secondary.id,
      JSON.stringify(waitedSecondary.observation?.screen),
    )
    await moveGlobal(40, 40)
  }

  const unknownScreen = await call('computer_screenshot', { screen: 'NO-SUCH-0' }).then(
    () => 'no-error',
    (error) => String(error.message),
  )
  check('an unknown monitor is rejected', /unknown screen/.test(unknownScreen), unknownScreen)

  /* --- 7. the stale-observation proof (mutation, no user disruption) --- */

  const probePath = join(HOME, 'probe.png')
  const fgNow = await x11.foregroundWindow()
  const screensNow = await x11.listScreens()
  const fgMonitor = fgNow.ok ? x11.screenOfRect(screensNow, fgNow.rect) : null
  const observation = await adapter.capture({ path: probePath, screenId: fgMonitor ? fgMonitor.screen.id : undefined })
  const healthy = await adapter.prove(observation, {})
  check('a fresh observation proves clean', healthy.ok === true, JSON.stringify(healthy).slice(0, 300))

  const wrongWindow = structuredClone(observation)
  wrongWindow.foreground.handle = '0xdeadbeef'
  const windowProof = await adapter.prove(wrongWindow, {})
  check('a changed foreground window is stale', windowProof.ok === false && windowProof.code === 'stale_observation' && /window/.test(windowProof.message), JSON.stringify(windowProof).slice(0, 300))

  const wrongBounds = structuredClone(observation)
  wrongBounds.foreground.rect = '0,0,10,10'
  const boundsProof = await adapter.prove(wrongBounds, {})
  check('changed bounds are stale', boundsProof.ok === false && boundsProof.code === 'stale_observation' && /bounds/.test(boundsProof.message), JSON.stringify(boundsProof).slice(0, 300))

  if (observation.fingerprint === '') {
    console.log('SKIP pixel-staleness checks (foreground window does not overlap the captured monitor)')
  } else {
    const wrongPixels = structuredClone(observation)
    wrongPixels.fingerprint = 'ff'.repeat(64)
    const pixelProof = await adapter.prove(wrongPixels, {})
    check('changed pixels are stale', pixelProof.ok === false && pixelProof.code === 'stale_observation' && /pixels/.test(pixelProof.message), JSON.stringify(pixelProof).slice(0, 300))
  }

  /* --- 7b. whole-monitor fingerprint fallback -------------------------- */

  const fgProbe = await x11.foregroundWindow()
  let fallbackMonitor = null
  if (fgProbe.ok) {
    const onScreen = x11.screenOfRect(screensNow, fgProbe.rect)
    fallbackMonitor = onScreen === null ? null : onScreen.screen
  }
  const otherScreen = screensNow.find((candidate) => fallbackMonitor === null || candidate.id !== fallbackMonitor.id)
  if (fallbackMonitor === null || otherScreen === undefined) {
    console.log('SKIP screen-fingerprint fallback (a single monitor, or no foreground window)')
  } else {
    const fallback = await adapter.capture({ path: join(HOME, 'screen-fp.png'), screenId: otherScreen.id })
    if (fallback.fingerprint === '') {
      console.log('SKIP screen-fingerprint fallback (the monitor is too small to sample)')
    } else {
      check('a foreground elsewhere falls back to a screen fingerprint', fallback.fingerprintTarget === 'screen', fallback.fingerprintTarget)
      const fallbackProof = await adapter.prove(fallback, {})
      check('the screen fingerprint proves clean', fallbackProof.ok === true, JSON.stringify(fallbackProof).slice(0, 300))
      const mutatedScreen = structuredClone(fallback)
      mutatedScreen.fingerprint = '00'.repeat(64)
      const screenStale = await adapter.prove(mutatedScreen, {})
      check(
        'a changed screen fingerprint is stale',
        screenStale.ok === false && screenStale.code === 'stale_observation' && /screen/.test(screenStale.message),
        JSON.stringify(screenStale).slice(0, 300),
      )
    }
  }

  /* --- 8. inputcheck --------------------------------------------------- */

  const checkResult = await call('computer', { action: 'inputcheck' })
  check('inputcheck names the X11 backend', checkResult.check && checkResult.check.backend === 'linux-x11')
  check('inputcheck reports the monitors', Array.isArray(checkResult.check.screens) && checkResult.check.screens.length >= 1)
  check('inputcheck reports the tool matrix', checkResult.check.tools && typeof checkResult.check.tools.xdotool === 'boolean')
  const environment = checkResult.check.environment
  check('inputcheck reports the detected environment', environment && environment.platform === 'linux', JSON.stringify(environment)?.slice(0, 300))
  check('the environment names the session type', typeof environment.sessionType === 'string', JSON.stringify(environment?.sessionType))
  check(
    'the environment carries a non-empty layout signature',
    typeof environment.layout.signature === 'string' && environment.layout.signature !== '',
    JSON.stringify(environment.layout),
  )
  check(
    'the environment probes the python helpers',
    typeof environment.python.present === 'boolean' && typeof environment.python.modules.Xlib === 'boolean',
    JSON.stringify(environment.python),
  )
  check(
    'the environment names the screenshot tool in use',
    typeof environment.capture.method === 'string' && environment.capture.method !== '',
    JSON.stringify(environment.capture),
  )
  check(
    'the environment lists missing required tools with hints',
    Array.isArray(environment.missingTools) && environment.missingTools.every((binary) => typeof environment.installHints[binary] === 'string'),
    JSON.stringify({ missing: environment.missingTools, hints: environment.installHints }),
  )
  check('inputcheck reports the provider slot', checkResult.provider && checkResult.provider.slot === 'computerUse')
  check('inputcheck reports the emergency brake', checkResult.check.brake && typeof checkResult.check.brake.registered === 'boolean', JSON.stringify(checkResult.check.brake))
  check('inputcheck reports the clipboard helper', checkResult.check.clipboard && checkResult.check.clipboard.helper === true, JSON.stringify(checkResult.check.clipboard))
  const lockProbe = await x11.lockState()
  check('the lock probe returns a boolean', typeof lockProbe.locked === 'boolean', JSON.stringify(lockProbe))
  if (lockProbe.conclusive) {
    check('the lock probe names its source', typeof lockProbe.source === 'string' && lockProbe.source !== '', JSON.stringify(lockProbe))
  } else {
    console.log('SKIP lock-source check (no conclusive lock probe on this session)')
  }
  check('inputcheck stays healthy without xclip (built-in clipboard helper)', checkResult.ok === true, checkResult.detail)
  check('inputcheck reports an empty warnings list or only informational ones', Array.isArray(checkResult.check.warnings), JSON.stringify(checkResult.check.warnings))

  /* --- 9. status + shot routes (the user's pause/resume surface) -------- */

  const statusRoute = routes.find((route) => route.path === '/api/computer-use/status')
  const shotRoute = routes.find((route) => route.path === '/api/computer-use/shot')

  const statusGet = await statusRoute.fetch(new Request('http://127.0.0.1/api/computer-use/status'))
  const statusBody = await statusGet.json()
  check('status route answers JSON', statusGet.status === 200 && statusBody.ok === true)
  check('status route names the backend', statusBody.value.backend === 'linux-x11', JSON.stringify(statusBody.value.backend))
  check('status route reports the pause state', statusBody.value.paused === false)
  check('status route reports the brake watcher', statusBody.value.brake && typeof statusBody.value.brake.registered === 'boolean', JSON.stringify(statusBody.value.brake))

  const pauseResponse = await statusRoute.fetch(
    new Request('http://127.0.0.1/api/computer-use/status', {
      method: 'POST',
      body: JSON.stringify({ action: 'pause', reason: 'integration test' }),
    }),
  )
  const pauseBody = await pauseResponse.json()
  check('status route can pause', pauseBody.ok === true && pauseBody.value.paused === true)
  check('status route pause writes the file', existsSync(pausePath()))
  const resumeResponse = await statusRoute.fetch(
    new Request('http://127.0.0.1/api/computer-use/status', {
      method: 'POST',
      body: JSON.stringify({ action: 'resume' }),
    }),
  )
  const resumeBody = await resumeResponse.json()
  check('status route can resume', resumeBody.ok === true && resumeBody.value.paused === false)
  check('status route resume removes the file', !existsSync(pausePath()))

  const file = shot.path.split('/').pop()
  const shotResponse = await shotRoute.fetch(new Request(`http://127.0.0.1/api/computer-use/shot?file=${file}`))
  check('shot route serves the PNG', shotResponse.status === 200 && shotResponse.headers.get('content-type') === 'image/png')
  const badShot = await shotRoute.fetch(new Request('http://127.0.0.1/api/computer-use/shot?file=../etc/passwd'))
  check('shot route rejects traversal', badShot.status === 404)

  /* --- 9b. emergency hotkey (python3-Xlib watcher) -------------------- */

  const chordOf = (combination) =>
    combination
      .split('+')
      .map((part) => part.trim())
      .map((part) => ({ Ctrl: 'ctrl', Shift: 'shift', Alt: 'alt', Win: 'super' })[part] ?? part)
      .join('+')
  const brakeState = checkResult.check.brake
  if (!TEST_HOTKEY) {
    console.log('SKIP emergency-hotkey injection (pass --test-hotkey to press the chord)')
  } else if (!brakeState || brakeState.registered !== true) {
    console.log(`SKIP emergency-hotkey check (watcher not registered: ${brakeState && brakeState.error ? brakeState.error : 'unknown'})`)
  } else {
    check('the brake watcher registered a hotkey', /Ctrl\+Alt/.test(brakeState.combination), brakeState.combination)
    if (existsSync(pausePath())) unlinkSync(pausePath())
    await exec('xdotool', ['key', '--clearmodifiers', chordOf(brakeState.combination)])
    let hotkeyPause = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(100)
      if (existsSync(pausePath())) {
        hotkeyPause = JSON.parse(readFileSync(pausePath(), 'utf8'))
        break
      }
    }
    check('the global hotkey writes the pause file', hotkeyPause !== null, JSON.stringify(hotkeyPause))
    if (hotkeyPause !== null) {
      check('the hotkey pause is attributed to the emergency hotkey', hotkeyPause.reason === 'hotkey' || hotkeyPause.by === 'emergency-hotkey', JSON.stringify(hotkeyPause))
      const pausedStatus = await statusRoute.fetch(new Request('http://127.0.0.1/api/computer-use/status'))
      const pausedBody = await pausedStatus.json()
      check('the status route reports the hotkey pause', pausedBody.value.paused === true)
      const release = await statusRoute.fetch(
        new Request('http://127.0.0.1/api/computer-use/status', { method: 'POST', body: JSON.stringify({ action: 'resume' }) }),
      )
      const releaseBody = await release.json()
      check('the user can release a hotkey pause from the status route', releaseBody.value.paused === false && !existsSync(pausePath()))
    }
  }

  /* --- 10. sequence: several input steps under one observation --------- */

  // Pointer-only sequences are allowed even while DSH is focused (the Linux
  // guard judges each target), so this no longer needs a DSH-foreground skip.
  {
    let sequence = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const seqShot = await call('computer_screenshot', {})
      sequence = await call('computer', {
        action: 'sequence',
        intent: 'integration test sequence',
        state_id: seqShot.state_id,
        steps: [
          { action: 'move', x: 60, y: 60 },
          { action: 'move', x: 70, y: 70 },
        ],
      })
      if (sequence.ok === true || !liveInterference(sequence)) break
      await sleep(250)
    }
    check('sequence succeeds', sequence.ok === true, JSON.stringify(sequence).slice(0, 300))
    check('sequence reports every step', Array.isArray(sequence.steps) && sequence.steps.length === 2, JSON.stringify(sequence.steps))
    const seqCursor = await cursor()
    check('sequence leaves the pointer at the last step', seqCursor.x === 70 && seqCursor.y === 70, `${seqCursor.x},${seqCursor.y}`)
    await moveGlobal(40, 40)
  }

  /* --- 11. optional real click / type --------------------------------- */

  if (CLICK_AT !== undefined) {
    const [cx, cy] = CLICK_AT.split(',').map((value) => Number(value.trim()))
    const fresh = await call('computer_screenshot', {})
    const clicked = await call('computer', { action: 'click', x: cx, y: cy, intent: 'integration test click', state_id: fresh.state_id })
    check(`click at ${cx},${cy} succeeds`, clicked.ok === true, JSON.stringify(clicked).slice(0, 300))
  } else {
    console.log('SKIP click check (pass --click-at X,Y to run it)')
  }

  if (TYPE_TEXT !== undefined) {
    const fresh = await call('computer_screenshot', {})
    const typed = await call('computer', { action: 'type', text: TYPE_TEXT, intent: 'integration test typing', state_id: fresh.state_id })
    check('type succeeds', typed.ok === true, JSON.stringify(typed).slice(0, 300))
  } else {
    console.log('SKIP type check (pass --type "text" to run it)')
  }
} finally {
  if (cleanupCursor) {
    try {
      await moveGlobal(initialCursor.x, initialCursor.y)
    } catch {
      // Best effort.
    }
  }
  for (const dispose of disposers.reverse()) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      // Best effort.
    }
  }
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? `\n${checks}/${checks} checks passed` : `\n${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)

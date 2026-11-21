/**
 * Static Windows-mode checks: the Linux wiring must not change what win32 sees.
 *
 * It fakes `process.platform` before importing the plugin (backend selection is
 * import-time) and then asserts the platform-facing surface and the pure
 * monitor/region helpers in backends/win32.mjs. Nothing here needs Windows or
 * PowerShell: helpers that would spawn one are never executed.
 *
 * Usage:  node tests/windows-mode-selftest.mjs
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const WORK = process.cwd()
const HOME = join(WORK, '.winmode-dsh-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const realPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

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

const win32 = await import('../backends/win32.mjs')

let plugin
try {
  plugin = await import('../index.js')
} finally {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
}

function fakeContext() {
  const tools = new Map()
  const effect = (fn) => {
    const dispose = typeof fn === 'function' ? fn() : undefined
    return typeof dispose === 'function' ? dispose : () => {}
  }
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    effect,
    inject(deps, callback) {
      if (deps.includes('computerUse')) return
      callback({ effect, connection: { fetch: { register: () => () => {} } } })
    },
    get: () => undefined,
  }
  return { ctx, tools }
}

const { ctx, tools } = fakeContext()
plugin.apply(ctx)
const screenshot = tools.get('computer_screenshot')
const computer = tools.get('computer')

check('both tools are registered in win32 mode', Boolean(screenshot) && Boolean(computer))
check(
  'screenshot description keeps the Windows wording',
  /^Capture one monitor of the Windows desktop/.test(screenshot.description),
  screenshot.description.slice(0, 80),
)
check(
  'screenshot advertises per-monitor capture and region/scale',
  /every monitor in screens/.test(screenshot.description) && /region/.test(screenshot.description) && /scale/.test(screenshot.description),
  screenshot.description,
)
check(
  'screenshot still accepts an optional screen parameter',
  screenshot.parameters.properties.screen !== undefined && /Windows: "all"/.test(screenshot.parameters.properties.screen.description),
  screenshot.parameters.properties.screen.description,
)
check(
  'screenshot schema accepts region and scale',
  screenshot.parameters.properties.region !== undefined && screenshot.parameters.properties.scale !== undefined,
)
check(
  'computer description keeps the Windows wording',
  /^Drive the real Windows desktop with one action per call/.test(computer.description),
  computer.description.slice(0, 80),
)
check('computer description keeps the hotkey sentence', /Ctrl\+Alt\+Shift\+Q/.test(computer.description))
check('computer description keeps the SendInput diagnosis wording', /integrity, locked desktop, dispatch confirmation, pointer drift, brake status/.test(computer.description))
check('computer description does not mention X11', !/X11|LOCAL to the monitor/.test(computer.description))
check(
  'computer description explains Windows global coordinates',
  /desktop-global/.test(computer.description),
  computer.description,
)

/* ---------------- pure win32 helpers (no PowerShell, no Windows) ---------------- */

const monitors = win32.parseMonitorJson({
  monitors: [
    { index: 0, id: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, width: 1920, height: 1080 },
    { index: 1, id: '\\\\.\\DISPLAY2', primary: false, x: -2560, y: 0, width: 2560, height: 1440 },
  ],
})
check('win32 parses the monitor list', monitors.length === 2 && monitors[0].primary === true && monitors[1].x === -2560)
check(
  'win32 accepts an unwrapped single monitor',
  win32.parseMonitorJson({ monitors: { index: 0, id: 'DISPLAY1', primary: true, x: 0, y: 0, width: 1280, height: 720 } }).length === 1,
)
check('win32 selects the primary monitor by default', win32.selectScreen(monitors, undefined).id.endsWith('DISPLAY1'))
check('win32 selects a monitor by index', win32.selectScreen(monitors, '1').id.endsWith('DISPLAY2'))
check('win32 accepts a bare device name', win32.selectScreen(monitors, 'DISPLAY2').id.endsWith('DISPLAY2'))
const all = win32.selectScreen(monitors, 'all')
check('win32 "all" spans the virtual desktop', all.id === 'virtual' && all.x === -2560 && all.width === 4480 && all.height === 1440)
check(
  'win32 lists detected monitors on an unknown id',
  (() => {
    try {
      win32.selectScreen(monitors, 'DISPLAY9')
      return false
    } catch (error) {
      return /detected monitors: .*DISPLAY1 .*DISPLAY2/.test(String(error?.message ?? error))
    }
  })(),
)
const fullArea = win32.captureArea(monitors[0], undefined, undefined)
check('win32 capture area defaults to the whole monitor', fullArea.left === 0 && fullArea.width === 1920 && fullArea.scale === 1)
const regionArea = win32.captureArea(monitors[0], { x: 100, y: 120, width: 600, height: 300 }, 0.5)
check(
  'win32 region is monitor-local and offsets the global capture',
  regionArea.left === 100 && regionArea.top === 120 && regionArea.originX === 100 && regionArea.scale === 0.5 && regionArea.region.scale === 0.5,
)
check(
  'win32 rejects a region outside the monitor',
  (() => {
    try {
      win32.captureArea(monitors[0], { x: 1800, y: 0, width: 600, height: 300 }, 1)
      return false
    } catch {
      return true
    }
  })(),
)
check(
  'win32 rejects a non-positive scale',
  (() => {
    try {
      win32.captureArea(monitors[0], undefined, 0)
      return false
    } catch {
      return true
    }
  })(),
)
check('win32 public screen view is stable', JSON.stringify(win32.publicScreen(monitors[0])).includes('"primary":true'))

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? `\n${checks}/${checks} checks passed` : `\n${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)

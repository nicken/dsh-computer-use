/**
 * Real-hardware smoke test for the Linux/X11 backend.
 *
 * Safe by default: it only enumerates monitors, takes screenshots and moves the
 * pointer (restoring the original position). Clicking and typing need explicit
 * flags.
 *
 *   node backends/smoke-linux.mjs
 *   node backends/smoke-linux.mjs --click-at 400,300
 *   node backends/smoke-linux.mjs --type "hello from dsh"
 *   node backends/smoke-linux.mjs --screen HDMI-1-0
 *
 * Exit code 0 = every check passed.
 */

import { readFileSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import {
  captureScreen,
  clickAt,
  cursorPosition,
  decodePng,
  dispatch,
  inputCheck,
  listScreens,
  observe,
  pickScreen,
  rootBounds,
  screensPublicView,
  typeText,
  warpTo,
} from './linux-x11.mjs'

const args = process.argv.slice(2)
const flagValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const clickAtFlag = flagValue('--click-at')
const typeFlag = flagValue('--type')
const screenFlag = flagValue('--screen')

let failures = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function countdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    process.stdout.write(`\r${remaining}s until the action... `)
    // synchronous spin keeps the countdown honest without blocking the event loop
    const end = Date.now() + 1000
    while (Date.now() < end) {
      // busy wait
    }
  }
  process.stdout.write('\r')
}

async function main() {
  console.log('== self check ==')
  const selfCheck = await inputCheck({ pausePath: '' })
  console.log(JSON.stringify(selfCheck, null, 2))
  check('input check reports no problems', selfCheck.ok, selfCheck.problems.join('; '))
  if (!selfCheck.ok) return

  console.log('')
  console.log('== monitors ==')
  const screens = await listScreens()
  console.log(JSON.stringify(screensPublicView(screens), null, 2))
  console.log(`root: ${JSON.stringify(rootBounds(screens))}`)
  check('exactly two monitors in this fixture run', screens.length >= 1)

  console.log('')
  console.log('== per-monitor capture ==')
  for (const screen of screens) {
    const path = `/tmp/dsh-cu-smoke-${process.pid}-${screen.id}.png`
    await captureScreen(screen, path)
    const png = decodePng(readFileSync(path))
    console.log(`  ${screen.id}: captured ${png.width}x${png.height}`)
    check(`${screen.id} capture matches monitor size`, png.width === screen.width && png.height === screen.height)
    rmSync(path, { force: true })
  }

  console.log('')
  console.log('== observation ==')
  const target = pickScreen(screens, screenFlag)
  const observationPath = `/tmp/dsh-cu-smoke-${process.pid}-observe.png`
  const observation = await observe(screens, target.id, observationPath)
  console.log(JSON.stringify({
    screen: observation.screen,
    cursor: observation.cursor,
    foreground: observation.foreground,
    fingerprintLength: observation.fingerprint.length,
  }, null, 2))
  check('observation screen matches the target', observation.screen.id === target.id)
  check('observation carries a fingerprint when a window is visible', observation.foreground.onThisScreen === false || observation.fingerprint.length === 64 * 6)

  console.log('')
  console.log('== pointer warp and readback ==')
  const origin = await cursorPosition()
  for (const screen of screens) {
    const x = Math.floor(screen.width / 2)
    const y = Math.floor(screen.height / 2)
    const landed = await warpTo(screen, x, y)
    const after = await cursorPosition()
    console.log(`  ${screen.id} local (${x}, ${y}) -> global ${after.x},${after.y}`)
    check(`${screen.id} warp lands exactly`, landed.ok && after.x === screen.x + x && after.y === screen.y + y)
  }
  await warpTo(target, origin.x - target.x, origin.y - target.y)
  check('pointer restored', true)

  console.log('')
  console.log('== key injection (Escape) ==')
  const keyResult = await dispatch(target, 'key', { keys: 'Escape' })
  console.log(`  ${JSON.stringify(keyResult)}`)
  check('Escape key dispatched', keyResult.ok === true)

  if (clickAtFlag !== undefined) {
    const [x, y] = clickAtFlag.split(',').map(Number)
    check('--click-at coordinates are numeric', Number.isFinite(x) && Number.isFinite(y), clickAtFlag)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      console.log('')
      console.log(`== click at ${x},${y} on ${target.id} in 3s (Ctrl+C to abort) ==`)
      countdown(3)
      const clicked = await clickAt(target, { x, y }, 'left', 1)
      console.log(`  ${JSON.stringify(clicked)}`)
      check('click dispatched', clicked.ok === true)
    }
  }

  if (typeFlag !== undefined) {
    console.log('')
    console.log(`== typing in 3s — focus a text field now (Ctrl+C to abort) ==`)
    countdown(3)
    const typed = await typeText(typeFlag)
    console.log(`  ${JSON.stringify(typed)}`)
    check('typing dispatched', typed.ok === true)
  }

  console.log('')
  console.log(`observation screenshot kept at ${observationPath} for inspection`)
}

await main()
console.log('')
console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures} check(s) failed)`)
process.exitCode = failures === 0 ? 0 : 1

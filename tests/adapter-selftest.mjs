/**
 * Offline self-test for the Linux adapter's pure layer (argument validation).
 *
 * Runs anywhere Node 20+ is installed (no X11, no DSH), because it only calls
 * `validate()`: the same rules the Windows PowerShell plan builder enforces.
 *
 * Usage:  node tests/adapter-selftest.mjs
 */

import { validate, INPUT_ACTIONS } from '../backends/linux-adapter.mjs'

const LIMITS = { maxTypeLength: 4000, maxSequenceSteps: 20, maxSequenceText: 8000 }

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

function throws(label, fn, pattern) {
  try {
    fn()
    check(label, false, 'did not throw')
  } catch (error) {
    check(label, pattern.test(String(error.message ?? error)), String(error.message ?? error))
  }
}

/* --- accepted actions --------------------------------------------------- */

const move = validate('move', { x: 10.4, y: 20.6 })
check('move rounds coordinates', move.args.x === 10 && move.args.y === 21)
check('move carries the action', move.action === 'move')

check('click builds a left click', validate('click', { x: 1, y: 2 }).detail === 'clicked left at (1, 2)')
check('double_click says twice', validate('double_click', { x: 1, y: 2 }).detail === 'clicked twice left at (1, 2)')
check('right_click is right', validate('right_click', { x: 1, y: 2 }).detail === 'clicked right at (1, 2)')

const drag = validate('drag', { x: 1, y: 2, toX: 3, toY: 4 })
check('drag keeps both endpoints', drag.args.toX === 3 && drag.args.toY === 4)

const scrollDefault = validate('scroll', {})
check('scroll defaults to -120 at the cursor', scrollDefault.args.delta === -120 && scrollDefault.args.x === undefined)
const scrollAt = validate('scroll', { x: 5, y: 6, delta: 120 })
check('scroll keeps the anchor', scrollAt.args.x === 5 && scrollAt.args.delta === 120)

const typed = validate('type', { text: 'hello' })
check('type keeps the text', typed.args.text === 'hello')
const typedWide = validate('type', { text: '中文' })
check('type accepts non-ASCII (clipboard path)', typedWide.args.text === '中文')

check('key accepts a chord', validate('key', { keys: 'Ctrl+Shift+I' }).detail === 'pressed Ctrl+Shift+I')
check('key accepts a named key', validate('key', { keys: 'Enter' }).args.keys === 'Enter')

const wait = validate('wait', { ms: 250 })
check('wait keeps ms', wait.ms === 250)
check('wait defaults to 500 ms', validate('wait', {}).ms === 500)

const sequence = validate('sequence', {
  steps: [
    { action: 'move', x: 1, y: 1 },
    { action: 'type', text: 'hi' },
    { action: 'key', keys: 'Enter' },
  ],
})
check('sequence plans every step', sequence.steps.length === 3)
check('sequence detail lists steps', /move: .*type: .*key: /.test(sequence.detail))

/* --- rejected actions (parity with the Windows plan builder) ----------- */

throws('move without y is rejected', () => validate('move', { x: 1 }), /"y" is required/)
throws('drag without toX is rejected', () => validate('drag', { x: 1, y: 2, toY: 4 }), /"toX" is required/)
throws('type without text is rejected', () => validate('type', {}), /"text" is required/)
throws('type over the cap is rejected', () => validate('type', { text: 'x'.repeat(4001) }), /limited to 4000/)
throws('key with an unknown key is rejected', () => validate('key', { keys: 'Hyper+Q' }), /unknown key|not a modifier/)
check('key accepts a lone modifier (Windows parity)', validate('key', { keys: 'Ctrl' }).args.keys === 'Ctrl')
check('key accepts the arrow aliases', validate('key', { keys: 'ArrowUp' }).detail === 'pressed ArrowUp')
throws('wait below 1 ms is rejected', () => validate('wait', { ms: 0 }), /between 1 and 30000/)
throws('wait above 30000 ms is rejected', () => validate('wait', { ms: 30001 }), /between 1 and 30000/)
throws('empty sequence is rejected', () => validate('sequence', { steps: [] }), /at least one step/)
throws(
  'sequence over 20 steps is rejected',
  () => validate('sequence', { steps: Array.from({ length: 21 }, () => ({ action: 'move', x: 1, y: 1 })) }),
  /limited to 20/,
)
throws(
  'sequence over the text budget is rejected',
  () => validate('sequence', { steps: [{ action: 'type', text: 'x'.repeat(3000) }, { action: 'type', text: 'y'.repeat(3000) }, { action: 'type', text: 'z'.repeat(3000) }] }),
  /characters of text/,
)
throws(
  'a step cannot nest sequence',
  () => validate('sequence', { steps: [{ action: 'move', x: 1, y: 1, steps: [] }] }),
  /step 1: a step cannot carry state_id, steps or nest sequence/,
)
throws(
  'a step cannot carry state_id',
  () => validate('sequence', { steps: [{ action: 'click', x: 1, y: 2, state_id: 'obs_x' }] }),
  /step 1: a step cannot carry state_id, steps or nest sequence/,
)
throws(
  'a step must be an input action',
  () => validate('sequence', { steps: [{ action: 'wait', ms: 5 }] }),
  /step 1: action must be one of/,
)
throws('an unknown top-level action is rejected', () => validate('jump', {}), /unsupported action/)

/* --- monitor bounds (CONTRACT 1.2/1.3) -------------------------------- */

const SCREEN = { id: 'HDMI-1-0', x: 0, y: 0, width: 1920, height: 1080 }
check('in-bounds move passes', validate('move', { x: 1919, y: 1079 }, { screen: SCREEN }).args.y === 1079)
throws(
  'out-of-bounds move is rejected',
  () => validate('move', { x: 1920, y: 10 }, { screen: SCREEN }),
  /outside the observed monitor/,
)
throws(
  'negative coordinates are rejected',
  () => validate('move', { x: -1, y: 10 }, { screen: SCREEN }),
  /outside the observed monitor/,
)
throws(
  'a drag end outside the monitor is rejected',
  () => validate('drag', { x: 10, y: 10, toX: 5000, toY: 10 }, { screen: SCREEN }),
  /outside the observed monitor/,
)
throws(
  'an out-of-bounds scroll anchor is rejected',
  () => validate('scroll', { x: 2000, y: 10 }, { screen: SCREEN }),
  /outside the observed monitor/,
)
check('without an observed screen there is no bounds check', validate('move', { x: 99999, y: 1 }).args.x === 99999)

/* --- the action vocabulary matches the tool's -------------------------- */

check(
  'input actions are the documented eight',
  INPUT_ACTIONS.join(',') === 'move,click,double_click,right_click,drag,scroll,type,key',
  INPUT_ACTIONS.join(','),
)

console.log(failures === 0 ? `\n${checks}/${checks} checks passed` : `\n${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)

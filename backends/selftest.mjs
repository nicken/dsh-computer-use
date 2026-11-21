/**
 * Offline self-test for backends/linux-x11.mjs.
 *
 * Runs anywhere Node 20+ is installed (no X11, no DSH): it exercises the pure
 * parts — monitor parsing, screen picking, PNG decoding (all five filters),
 * fingerprint sampling/comparison and key token resolution.
 *
 * Usage:  node backends/selftest.mjs
 */

import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  compareFingerprint,
  cropImage,
  decodePng,
  decodeXwd,
  encodePng,
  enrichScreens,
  fingerprintOfScreen,
  fingerprintOfWindow,
  layoutSignature,
  parseMonitors,
  parseOutputFacts,
  pickScreen,
  resolveKeyToken,
  rootBounds,
  screenOfRect,
  screensPublicView,
  scaleImage,
  selectCaptureMethod,
} from './linux-x11.mjs'

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

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/* ------------------------------ CRC32 / PNG ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Encode an RGB image applying a different PNG filter on every row. */
function encodePngFixture(width, height, pixelAt) {
  const channels = 3
  const stride = width * channels
  const encodedRows = []
  let previousRow = null
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5
    const row = Buffer.alloc(stride)
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y)
      row[x * channels] = r
      row[x * channels + 1] = g
      row[x * channels + 2] = b
    }
    const out = Buffer.alloc(stride + 1)
    out[0] = filter
    for (let x = 0; x < stride; x += 1) {
      const value = row[x]
      const a = x >= channels ? row[x - channels] : 0
      const b = previousRow === null ? 0 : previousRow[x]
      const c = x >= channels && previousRow !== null ? previousRow[x - channels] : 0
      let encoded
      switch (filter) {
        case 0: encoded = value; break
        case 1: encoded = value - a; break
        case 2: encoded = value - b; break
        case 3: encoded = value - ((a + b) >> 1); break
        default: encoded = value - paethPredictor(a, b, c); break
      }
      out[x + 1] = encoded & 0xff
    }
    encodedRows.push(out)
    previousRow = row
  }
  const raw = Buffer.concat(encodedRows)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------ monitors ------------------------------ */

const XRANDR_FIXTURE = `Monitors: 2
 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1
 1: +HDMI-1-0 2560/597x1440/336+1920+0  HDMI-1-0
`

const screens = parseMonitors(XRANDR_FIXTURE)
equal('monitor count', screens.length, 2)
equal('primary picked', screens[0].primary, true)
equal('secondary is not primary', screens[1].primary, false)
equal('primary id', screens[0].id, 'eDP-1')
equal('secondary id', screens[1].id, 'HDMI-1-0')
equal('primary width', screens[0].width, 1920)
equal('secondary height', screens[1].height, 1440)
equal('secondary offset x', screens[1].x, 1920)
equal('secondary offset y', screens[1].y, 0)

const root = rootBounds(screens)
equal('root width', root.width, 4480)
equal('root height', root.height, 1440)

equal('default screen is primary', pickScreen(screens).id, 'eDP-1')
equal('by id', pickScreen(screens, 'HDMI-1-0').id, 'HDMI-1-0')
equal('by index', pickScreen(screens, '1').id, 'HDMI-1-0')
equal('"auto" keeps the primary default', pickScreen(screens, 'auto').id, 'eDP-1')
equal('"cursor" follows the pointer', pickScreen(screens, 'cursor', { cursor: { x: 2000, y: 100 } }).id, 'HDMI-1-0')
equal(
  '"cursor" falls back to the primary default',
  pickScreen(screens, 'cursor', { cursor: null }).id,
  'eDP-1',
)
equal(
  'layout signature is stable',
  layoutSignature(screens),
  'eDP-1@0,0:1920x1080*|HDMI-1-0@1920,0:2560x1440',
)

let unknownThrew = false
try {
  pickScreen(screens, 'DP-9')
} catch {
  unknownThrew = true
}
check('unknown screen throws', unknownThrew)
check(
  'unknown screen error lists the detected monitors',
  (() => {
    try {
      pickScreen(screens, 'DP-9')
      return false
    } catch (error) {
      return /detected monitors: eDP-1 .*HDMI-1-0 /.test(String(error?.message ?? error))
    }
  })(),
)

/* ------------------- physical facts / DPI (xrandr --query) ------------------- */

const XRANDR_QUERY_FIXTURE = `Screen 0: minimum 320 x 200, current 5560 x 1920, maximum 16384 x 16384
eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 344mm x 194mm
   1920x1080     60.03*+
HDMI-1-0 connected 2560x1440+1920+0 (normal left inverted right x axis y axis) 597mm x 336mm
   2560x1440     60.00*+
DP-2 connected 1080x1920+4480+0 left (normal left inverted right x axis y axis) 597mm x 336mm
   1080x1920     60.00*+
DP-3 disconnected (normal left inverted right x axis y axis)
`

const facts = parseOutputFacts(XRANDR_QUERY_FIXTURE)
equal('query output count', facts.size, 4)
equal('query parses connected', facts.get('eDP-1').connected, true)
equal('query parses primary', facts.get('eDP-1').primary, true)
equal('query parses physical width', facts.get('eDP-1').mmWidth, 344)
equal('query parses physical height', facts.get('HDMI-1-0').mmHeight, 336)
equal('query parses rotation', facts.get('DP-2').rotation, 'left')
equal('query keeps normal rotation', facts.get('eDP-1').rotation, 'normal')
equal('query parses disconnected', facts.get('DP-3').connected, false)

const enriched = enrichScreens(
  [
    { index: 0, primary: true, id: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0 },
    { index: 1, primary: false, id: 'HDMI-1-0', width: 2560, height: 1440, x: 1920, y: 0 },
    // A portrait monitor: DPI must come from the rotated pixel rectangle.
    { index: 2, primary: false, id: 'DP-2', width: 1080, height: 1920, x: 4480, y: 0 },
  ],
  facts,
)
equal('dpi from physical size', enriched[0].dpi, 142)
equal('dpi of a wider panel', enriched[1].dpi, 109)
equal('portrait dpi uses the rotated edge', enriched[2].dpi, 82)
equal('portrait rotation is kept', enriched[2].rotation, 'left')
check(
  'public view exposes dpi and rotation',
  screensPublicView(enriched)[0].dpi === 142 && screensPublicView(enriched)[2].rotation === 'left',
)
check(
  'a screen without a matching output keeps no dpi',
  !('dpi' in enrichScreens([{ index: 0, primary: true, id: 'VIRTUAL-9', width: 800, height: 600, x: 0, y: 0 }], facts)[0]),
)

const published = screensPublicView(screens)
check('public view shape', published[0].id === 'eDP-1' && published[0].primary === true)

check(
  'screenOfRect picks the overlap',
  screenOfRect(screens, { x: 1900, y: 100, width: 600, height: 400 }).screen.id === 'HDMI-1-0',
)

/* ------------------- capture fallback + XWD decoding ------------------- */

/** Build a minimal XWD file (ZPixmap) from raw pixel bytes. */
function buildXwd({ width, height, bitsPerPixel, byteOrder = 0, masks = [0xff0000, 0x00ff00, 0x0000ff], palette = [], pixelBytes, bytesPerLine }) {
  const rowBytes = bytesPerLine ?? width * Math.ceil(bitsPerPixel / 8)
  const header = Buffer.alloc(100)
  const put = (index, value) => header.writeUInt32BE(value >>> 0, index * 4)
  put(0, 100)
  put(1, 7)
  put(2, 2) // ZPixmap
  put(3, bitsPerPixel)
  put(4, width)
  put(5, height)
  put(7, byteOrder)
  put(8, 32)
  put(10, 32)
  put(11, bitsPerPixel)
  put(12, rowBytes)
  put(13, 4) // TrueColor
  put(14, masks[0])
  put(15, masks[1])
  put(16, masks[2])
  put(17, 8)
  put(18, palette.length)
  put(19, palette.length)
  put(20, width)
  put(21, height)
  const colors = Buffer.alloc(palette.length * 12)
  palette.forEach((entry, index) => {
    const at = index * 12
    colors.writeUInt32BE(entry.pixel >>> 0, at)
    colors.writeUInt16BE(entry.red ?? 0, at + 4)
    colors.writeUInt16BE(entry.green ?? 0, at + 6)
    colors.writeUInt16BE(entry.blue ?? 0, at + 8)
  })
  const data = Buffer.alloc(rowBytes * height)
  pixelBytes.copy(data)
  return Buffer.concat([header, colors, data])
}

const xwdRgb24 = decodeXwd(
  buildXwd({
    width: 2,
    height: 1,
    bitsPerPixel: 24,
    byteOrder: 0, // LSBFirst: [B, G, R]
    pixelBytes: Buffer.from([0, 0, 255, 0, 255, 0]),
  }),
)
equal('xwd decode size', `${xwdRgb24.width}x${xwdRgb24.height}`, '2x1')
equal('xwd LSBFirst red', xwdRgb24.pixel(0, 0).join(','), '255,0,0')
equal('xwd LSBFirst green', xwdRgb24.pixel(1, 0).join(','), '0,255,0')

const xwdMsb32 = decodeXwd(
  buildXwd({
    width: 1,
    height: 1,
    bitsPerPixel: 32,
    byteOrder: 1, // MSBFirst: [A, R, G, B]
    pixelBytes: Buffer.from([0x80, 0x12, 0x34, 0x56]),
  }),
)
equal('xwd MSBFirst 32bpp', xwdMsb32.pixel(0, 0).join(','), '18,52,86')

const xwd565 = decodeXwd(
  buildXwd({
    width: 3,
    height: 1,
    bitsPerPixel: 16,
    byteOrder: 0,
    masks: [0xf800, 0x07e0, 0x001f],
    pixelBytes: Buffer.from([0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00]),
  }),
)
equal('xwd 565 red', xwd565.pixel(0, 0).join(','), '255,0,0')
equal('xwd 565 green', xwd565.pixel(1, 0).join(','), '0,255,0')
equal('xwd 565 blue', xwd565.pixel(2, 0).join(','), '0,0,255')

const xwdPalette = decodeXwd(
  buildXwd({
    width: 1,
    height: 1,
    bitsPerPixel: 8,
    byteOrder: 0,
    masks: [0, 0, 0],
    palette: [{ pixel: 7, red: 0xffff, green: 0x8000, blue: 0x0000 }],
    pixelBytes: Buffer.from([7]),
  }),
)
equal('xwd palette entry', xwdPalette.pixel(0, 0).join(','), '255,128,0')

const xwdGrey = decodeXwd(
  buildXwd({
    width: 1,
    height: 1,
    bitsPerPixel: 8,
    byteOrder: 0,
    masks: [0, 0, 0],
    pixelBytes: Buffer.from([128]),
  }),
)
equal('xwd greyscale fallback', xwdGrey.pixel(0, 0).join(','), '128,128,128')

check(
  'xwd rejects a bad version',
  (() => {
    const dump = buildXwd({ width: 1, height: 1, bitsPerPixel: 24, pixelBytes: Buffer.from([0, 0, 0]) })
    dump.writeUInt32BE(6, 4)
    try {
      decodeXwd(dump)
      return false
    } catch {
      return true
    }
  })(),
)
check(
  'xwd rejects truncated pixel data',
  (() => {
    // Slice the dump short: the header is 100 bytes, the pixels need 48 more.
    const dump = buildXwd({ width: 4, height: 4, bitsPerPixel: 24, pixelBytes: Buffer.alloc(48) }).subarray(0, 120)
    try {
      decodeXwd(dump)
      return false
    } catch {
      return true
    }
  })(),
)

/* capture-tool preference: scrot -> import -> xwd, with a forced override */

equal('capture prefers scrot', selectCaptureMethod({ scrot: true, import: true, xwd: true }).name, 'scrot')
equal('capture falls back to import', selectCaptureMethod({ scrot: false, import: true, xwd: true }).name, 'import')
equal('capture falls back to xwd', selectCaptureMethod({ scrot: false, import: false, xwd: true }).name, 'xwd')
equal('capture honours a forced tool', selectCaptureMethod({ scrot: true, xwd: true }, 'xwd').name, 'xwd')
check(
  'capture reports when nothing is installed',
  (() => {
    const choice = selectCaptureMethod({})
    return choice.name === '' && /no screenshot tool found/.test(choice.error)
  })(),
)
check(
  'capture rejects an unavailable forced tool',
  (() => {
    const choice = selectCaptureMethod({ scrot: true }, 'xwd')
    return choice.name === '' && /xwd/.test(choice.error)
  })(),
)

/* ------------------------------ PNG ------------------------------ */
const width = 40
const height = 30
const pixelAt = (x, y) => [x * 5, y * 7, (x + y) * 3]
const png = decodePng(encodePngFixture(width, height, pixelAt))
equal('png width', png.width, width)
equal('png height', png.height, height)
equal('png channels', png.channels, 3)
for (const [x, y] of [[0, 0], [7, 3], [39, 29], [20, 15]]) {
  const expected = pixelAt(x, y)
  const actual = png.pixel(x, y)
  check(`pixel ${x},${y} (all filters)`, actual[0] === expected[0] && actual[1] === expected[1] && actual[2] === expected[2], `expected ${expected}, got ${actual}`)
}

let badSignatureThrew = false
try {
  decodePng(Buffer.from('not a png'))
} catch {
  badSignatureThrew = true
}
check('non-PNG rejected', badSignatureThrew)

/* ------------------------------ fingerprint ------------------------------ */

const rect = { x: 0, y: 0, width: 40, height: 30 }
const fingerprintA = fingerprintOfWindow(png, screens[0], rect)
check('fingerprint length', fingerprintA.length === 64 * 6, `got ${fingerprintA.length}`)
equal('identical fingerprints differ by 0', compareFingerprint(fingerprintA, fingerprintA), 0)

const shifted = fingerprintA.slice(0, -6) + (fingerprintA.endsWith('000000') ? 'ffffff' : '000000')
check('one sampled pixel is below the stale threshold', compareFingerprint(fingerprintA, shifted) === 1)

const blankFingerprint = fingerprintOfWindow(png, screens[0], { x: 0, y: 0, width: 4, height: 4 })
equal('tiny window yields no fingerprint', blankFingerprint, '')

const offScreen = fingerprintOfWindow(png, screens[1], rect)
equal('window outside the captured screen yields no fingerprint', offScreen, '')

/* ------------------------------ keys ------------------------------ */

equal('ctrl modifier', resolveKeyToken('Ctrl').value, 'ctrl')
equal('win maps to super', resolveKeyToken('Win').value, 'super')
equal('letter', resolveKeyToken('i').value, 'i')
equal('digit', resolveKeyToken('5').value, '5')
equal('function key', resolveKeyToken('f12').value, 'F12')
equal('named key', resolveKeyToken('Enter').value, 'Return')

let badKeyThrew = false
try {
  resolveKeyToken('nope-key')
} catch {
  badKeyThrew = true
}
check('unknown key throws', badKeyThrew)

/* --- PNG encode / crop / whole-screen fingerprint (negative-origin path) --- */

const small = { width: 40, height: 30, channels: 3, data: Buffer.alloc(40 * 30 * 3) }
for (let y = 0; y < small.height; y += 1) {
  for (let x = 0; x < small.width; x += 1) {
    const index = (y * small.width + x) * 3
    small.data[index] = x * 6
    small.data[index + 1] = y * 8
    small.data[index + 2] = (x + y) % 256
  }
}
const encoded = encodePng(small)
check(
  'encodePng starts with the PNG signature',
  encoded.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
)
const roundTrip = decodePng(encoded)
check('encodePng -> decodePng keeps the size', roundTrip.width === small.width && roundTrip.height === small.height)
check(
  'encodePng -> decodePng keeps every pixel',
  (() => {
    for (let y = 0; y < small.height; y += 1) {
      for (let x = 0; x < small.width; x += 1) {
        const expected = [x * 6, y * 8, (x + y) % 256]
        const actual = roundTrip.pixel(x, y)
        if (actual[0] !== expected[0] || actual[1] !== expected[1] || actual[2] !== expected[2]) return false
      }
    }
    return true
  })(),
)
const cropped = cropImage(roundTrip, { x: 5, y: 3, width: 10, height: 8 })
check('cropImage returns the requested size', cropped.width === 10 && cropped.height === 8)
check(
  'cropImage keeps absolute coordinates',
  (() => {
    const decodedCrop = decodePng(encodePng(cropped))
    return decodedCrop.pixel(0, 0)[0] === 5 * 6 && decodedCrop.pixel(0, 0)[1] === 3 * 8
  })(),
)
check(
  'cropImage rejects a non-overlapping rectangle',
  (() => {
    try {
      cropImage(roundTrip, { x: 100, y: 100, width: 5, height: 5 })
      return false
    } catch {
      return true
    }
  })(),
)
const screenFingerprint = fingerprintOfScreen(roundTrip)
check('fingerprintOfScreen has 64 samples', screenFingerprint.length === 64 * 6, String(screenFingerprint.length))
check('fingerprintOfScreen is stable for the same image', fingerprintOfScreen(decodePng(encoded)) === screenFingerprint)
check('fingerprintOfScreen rejects a tiny image', fingerprintOfScreen({ width: 5, height: 5, pixel: () => [0, 0, 0] }) === '')

/* --- nearest-neighbour scale (region screenshots) --- */

const scaledHalf = scaleImage(roundTrip, 0.5)
check('scaleImage halves the dimensions', scaledHalf.width === 20 && scaledHalf.height === 15)
check(
  'scaleImage keeps the nearest source pixel',
  (() => {
    const decodedScaled = decodePng(encodePng(scaledHalf))
    return decodedScaled.pixel(0, 0)[0] === 0 && decodedScaled.pixel(19, 14)[0] === 38 * 6
  })(),
)
check('scaleImage rejects a non-positive factor', (() => {
  try {
    scaleImage(roundTrip, 0)
    return false
  } catch {
    return true
  }
})())

/* ------------------------------ summary ------------------------------ */

console.log('')
console.log(`${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1

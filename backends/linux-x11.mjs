/**
 * dsh-computer-use — Linux / X11 backend primitives.
 *
 * Dependency-free: shells out to xdotool / scrot / xprop / xwininfo / xclip.
 * No DSH coupling: this module can be exercised by selftest.mjs and
 * smoke-linux.mjs on a bare Ubuntu box before it is wired into index.js.
 *
 * Coordinate contract (see backends/CONTRACT.md):
 *   - every tool-level coordinate is LOCAL to the captured monitor
 *   - global X coordinates = screen.x + localX, screen.y + localY
 *   - a screenshot always targets exactly one monitor; never the whole root
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
const TOOL_TIMEOUT_MS = 8_000

export const name = 'linux-x11'
export const platform = 'linux'

/* ------------------------------------------------------------------ */
/* process helpers                                                     */
/* ------------------------------------------------------------------ */

async function tool(command, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(command, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
      code: typeof error?.code === 'number' ? error.code : -1,
      message: String(error?.message ?? error),
    }
  }
}

function fail(command, result) {
  const detail = (result.stderr || result.message || '').trim().slice(0, 500)
  return new Error(`${command} failed${result.code >= 0 ? ` (exit ${result.code})` : ''}: ${detail}`)
}

/** Same as `tool`, but keeps binary stdout (used by the xwd capture path). */
async function toolBuffer(command, args, options = {}) {
  try {
    const { stdout } = await exec(command, args, {
      encoding: 'buffer',
      timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout }
  } catch (error) {
    return {
      ok: false,
      stdout: Buffer.alloc(0),
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
      code: typeof error?.code === 'number' ? error.code : -1,
      message: String(error?.message ?? error),
    }
  }
}

async function toolPresent(binary) {
  // Not a login shell: it may print motd/rc output that looks like a hit.
  const result = await tool('sh', ['-c', `command -v ${binary}`], { timeoutMs: 3_000 })
  return result.ok && result.stdout.trim() !== ''
}

/* ------------------------------------------------------------------ */
/* monitors                                                            */
/* ------------------------------------------------------------------ */

/**
 * Parse `xrandr --listmonitors`.
 * Example line: ` 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1`
 */
export function parseMonitors(text) {
  const screens = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+):\s+\+(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line)
    if (match === null) continue
    screens.push({
      index: Number(match[1]),
      primary: match[2] === '*',
      id: match[3],
      width: Number(match[4]),
      height: Number(match[5]),
      x: Number(match[6]),
      y: Number(match[7]),
    })
  }
  return screens.sort((a, b) => a.index - b.index)
}

/**
 * Parse the connected outputs of `xrandr --query`, the cheapest source of
 * physical panel size and rotation (`--listmonitors` only reports pixels).
 *
 * Example lines:
 *   eDP-1 connected primary 1920x1080+0+0 (normal left inverted ...) 344mm x 194mm
 *   HDMI-1 connected 1080x1920+2560+0 left (normal left inverted ...) 597mm x 336mm
 *
 * The pixel geometry in this output is not used for coordinates — the monitor
 * rectangle always comes from `--listmonitors`. Only the physical size and the
 * rotation hint are merged into the screen facts.
 */
export function parseOutputFacts(text) {
  const outputs = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(connected|disconnected)\b(.*)$/.exec(line)
    if (match === null) continue
    const id = match[1]
    if (match[2] !== 'connected') {
      outputs.set(id, { id, connected: false })
      continue
    }
    const rest = match[3]
    const size = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(rest)
    const physical = /(\d+)mm\s*x\s*(\d+)mm/.exec(rest)
    const rotation = /\b(normal|left|inverted|right)\s+\(/.exec(rest)
    outputs.set(id, {
      id,
      connected: true,
      primary: /\bprimary\b/.test(rest),
      pixelWidth: size === null ? 0 : Number(size[1]),
      pixelHeight: size === null ? 0 : Number(size[2]),
      x: size === null ? 0 : Number(size[3]),
      y: size === null ? 0 : Number(size[4]),
      mmWidth: physical === null ? 0 : Number(physical[1]),
      mmHeight: physical === null ? 0 : Number(physical[2]),
      rotation: rotation === null ? 'normal' : rotation[1],
    })
  }
  return outputs
}

/**
 * Merge physical facts into the monitor list. DPI is derived from the monitor's
 * actual (already rotated) pixel rectangle, so a portrait monitor still reports
 * a sane horizontal density. This is advisory data for the model (region
 * picking, zoom decisions); coordinates and capture never depend on it.
 */
export function enrichScreens(screens, outputs) {
  const connected = [...outputs.values()].filter((output) => output.connected && output.mmWidth > 0)
  for (const screen of screens) {
    let facts = outputs.get(screen.id)
    // Single connected output with a differently-named monitor (mirroring or a
    // custom monitor name): the physical size still describes this screen.
    if ((facts === undefined || !facts.connected) && connected.length === 1) facts = connected[0]
    if (facts === undefined || !facts.connected || facts.mmWidth <= 0) continue
    const rotated = facts.rotation === 'left' || facts.rotation === 'right'
    const mmHorizontal = rotated ? facts.mmHeight : facts.mmWidth
    const mmVertical = rotated ? facts.mmWidth : facts.mmHeight
    if (mmHorizontal <= 0 || mmVertical <= 0) continue
    const dpi = Math.round(screen.width / (mmHorizontal / 25.4))
    const dpiVertical = Math.round(screen.height / (mmVertical / 25.4))
    if (dpi >= 40 && dpi <= 500) screen.dpi = dpi
    if (dpiVertical >= 40 && dpiVertical <= 500) screen.dpiVertical = dpiVertical
    screen.mmWidth = mmHorizontal
    screen.mmHeight = mmVertical
    if (facts.rotation !== 'normal') screen.rotation = facts.rotation
  }
  return screens
}

/**
 * Enumerate the current monitor layout. Both xrandr views are read together so
 * screenshots carry pixel geometry (`--listmonitors`) plus DPI/rotation hints
 * (`--query`). A failed `--query` is not fatal: geometry is what matters.
 */
export async function listScreens() {
  const [monitors, query] = await Promise.all([
    tool('xrandr', ['--listmonitors']),
    tool('xrandr', ['--query']),
  ])
  if (!monitors.ok) throw fail('xrandr --listmonitors', monitors)
  const screens = parseMonitors(monitors.stdout)
  if (screens.length === 0) throw new Error('xrandr reported no monitors')
  if (query.ok) {
    try {
      enrichScreens(screens, parseOutputFacts(query.stdout))
    } catch {
      // Physical size is a hint; never fail a capture over it.
    }
  }
  if (!screens.some((screen) => screen.primary)) screens[0].primary = true
  return screens
}

function largestScreen(screens) {
  return [...screens].sort(
    (a, b) => b.width * b.height - a.width * a.height || a.index - b.index,
  )[0]
}

function screenAtPoint(screens, point) {
  if (point === null || point === undefined) return null
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return (
    screens.find(
      (screen) => x >= screen.x && x < screen.x + screen.width && y >= screen.y && y < screen.y + screen.height,
    ) ?? null
  )
}

/**
 * Resolve a monitor selector.
 *
 *   undefined / '' / 'auto'  primary monitor, else the largest one
 *   'cursor'                 monitor under the pointer, else the auto default
 *   '<id>' / '<index>'       exact monitor id, else its list index
 *
 * `auto` intentionally does not follow the pointer: a predictable default
 * keeps repeated screenshots on the same monitor. Callers that want the
 * pointer's monitor ask for `'cursor'` explicitly.
 */
export function pickScreen(screens, screenId, options = {}) {
  const wanted = screenId === undefined || screenId === null ? '' : String(screenId).trim()
  const keyword = wanted.toLowerCase()
  if (wanted === '' || keyword === 'auto') {
    return screens.find((screen) => screen.primary) ?? largestScreen(screens)
  }
  if (keyword === 'cursor') {
    return screenAtPoint(screens, options.cursor) ?? screens.find((screen) => screen.primary) ?? largestScreen(screens)
  }
  const byId = screens.find((screen) => screen.id === wanted)
  if (byId !== undefined) return byId
  const index = Number(wanted)
  if (Number.isInteger(index)) {
    const byIndex = screens.find((screen) => screen.index === index)
    if (byIndex !== undefined) return byIndex
  }
  const detected = screens.map((screen) => `${screen.id} (${screen.width}x${screen.height} at ${screen.x},${screen.y})`)
  throw new Error(`unknown screen "${wanted}"; detected monitors: ${detected.join(', ')}`)
}

/** Stable fingerprint of the monitor layout, for diagnostics and tests. */
export function layoutSignature(screens) {
  return (Array.isArray(screens) ? screens : [])
    .map((screen) => `${screen.id}@${screen.x},${screen.y}:${screen.width}x${screen.height}${screen.primary ? '*' : ''}`)
    .join('|')
}

export function rootBounds(screens) {
  const left = Math.min(...screens.map((screen) => screen.x))
  const top = Math.min(...screens.map((screen) => screen.y))
  const right = Math.max(...screens.map((screen) => screen.x + screen.width))
  const bottom = Math.max(...screens.map((screen) => screen.y + screen.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function screenPublicView(screen) {
  return {
    id: screen.id,
    index: screen.index,
    primary: screen.primary === true,
    x: screen.x,
    y: screen.y,
    width: screen.width,
    height: screen.height,
    // Physical hints, only when xrandr reported them. They describe the panel,
    // not the coordinate space: tool coordinates stay physical pixels.
    ...(Number.isFinite(screen.dpi) ? { dpi: screen.dpi } : {}),
    ...(screen.rotation !== undefined && screen.rotation !== 'normal' ? { rotation: screen.rotation } : {}),
  }
}

export function screensPublicView(screens) {
  return screens.map(screenPublicView)
}

/* ------------------------------------------------------------------ */
/* screenshots                                                         */
/* ------------------------------------------------------------------ */

/**
 * Screenshot tools, in preference order. `scrot` is the only one that can grab
 * a sub-rectangle directly and is the fastest; ImageMagick's `import` is common
 * on desktops without scrot; `xwd` ships with X11 itself and its dump is
 * decoded here (no image library needed). `DSH_COMPUTER_USE_CAPTURE` pins one
 * of them, which is also how the fallback paths get real-desktop tests.
 */
const CAPTURE_TOOLS = ['scrot', 'import', 'xwd']
const CAPTURE_CACHE_MS = 10_000
let captureCache = null

/** Pure selection rule, so the fallback order is unit-testable without X11. */
export function selectCaptureMethod(available = {}, wanted = '') {
  const forced = String(wanted ?? '').trim().toLowerCase()
  const order = forced === '' ? CAPTURE_TOOLS : [forced]
  for (const name of order) {
    if (CAPTURE_TOOLS.includes(name) && available[name] === true) {
      return { name, available: { ...available } }
    }
  }
  return {
    name: '',
    available: { ...available },
    error:
      forced === ''
        ? 'no screenshot tool found: install scrot, ImageMagick (import) or xwd'
        : `the requested screenshot tool "${forced}" is not installed or not supported`,
  }
}

export async function captureMethod(force = process.env.DSH_COMPUTER_USE_CAPTURE) {
  const available = {}
  for (const binary of CAPTURE_TOOLS) available[binary] = await toolPresent(binary)
  return selectCaptureMethod(available, force)
}

async function currentCapture() {
  if (captureCache !== null && Date.now() - captureCache.at < CAPTURE_CACHE_MS) return captureCache.value
  const value = await captureMethod()
  captureCache = { at: Date.now(), value }
  return value
}

/** Capture the whole root window into a PNG at `path`, using the chosen tool. */
async function captureRoot(path) {
  const choice = await currentCapture()
  if (choice.name === '') throw new Error(choice.error)
  if (choice.name === 'scrot') {
    const result = await tool('scrot', ['-o', path], { timeoutMs: 15_000 })
    if (!result.ok) throw fail('scrot (root)', result)
    return path
  }
  if (choice.name === 'import') {
    const result = await tool('import', ['-silent', '-window', 'root', `png:${path}`], { timeoutMs: 20_000 })
    if (!result.ok) throw fail('import -window root', result)
    return path
  }
  // xwd: dump to stdout and decode it here; PNG encoding is local.
  const result = await toolBuffer('xwd', ['-root', '-silent'], { timeoutMs: 20_000 })
  if (!result.ok) throw fail('xwd -root', result)
  writeFileSync(path, encodePng(decodeXwd(result.stdout)))
  return path
}

/**
 * Capture exactly one monitor's rectangle (never the whole root).
 *
 * `scrot -a` is the fast path, but it cannot express a negative origin (getopt
 * reads `-10` as an option) and it does not exist on every desktop, so anything
 * else goes through "capture the root window, then crop in Node". If the root
 * window does not cover the monitor, fail with a clear message instead of
 * returning the wrong pixels.
 */
export async function captureScreen(screen, path) {
  const choice = await currentCapture()
  if (choice.name === '') throw new Error(choice.error)
  if (choice.name === 'scrot' && screen.x >= 0 && screen.y >= 0) {
    const area = `${screen.x},${screen.y},${screen.width},${screen.height}`
    const result = await tool('scrot', ['-o', '-a', area, path], { timeoutMs: 15_000 })
    if (result.ok) return path
    // A transient scrot failure is not fatal: the root-crop path retries it.
  }
  return await captureScreenByRootCrop(screen, path)
}

async function captureScreenByRootCrop(screen, path) {
  const rootPath = `${path}.root.png`
  try {
    await captureRoot(rootPath)
    const image = decodePng(readFileSync(rootPath))
    const rect = { x: screen.x, y: screen.y, width: screen.width, height: screen.height }
    let crop
    try {
      crop = cropImage(image, rect)
    } catch {
      throw new Error(
        `monitor ${screen.id} at (${screen.x},${screen.y}) is outside the root window ` +
          `(${image.width}x${image.height}), so it cannot be captured by cropping`,
      )
    }
    writeFileSync(path, encodePng(crop))
    return path
  } finally {
    rmSync(rootPath, { force: true })
  }
}

/**
 * Decode an XWD (X Window Dump) into the same image shape as `decodePng`.
 * Only ZPixmap dumps are meaningful for screenshots; 8/16/24/32 bits per pixel
 * and both byte orders are handled, with truecolor masks or (8 bpp) a palette.
 * XWD carries no alpha, so the result is always RGB.
 */
export function decodeXwd(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 100) throw new Error('xwd: the dump is too short for a header')
  const header = []
  for (let index = 0; index < 25; index += 1) header.push(bytes.readUInt32BE(index * 4))
  const headerSize = header[0]
  const version = header[1]
  const format = header[2]
  const width = header[4]
  const height = header[5]
  const byteOrder = header[7]
  const bitsPerPixel = header[11]
  const bytesPerLine = header[12]
  const redMask = header[14]
  const greenMask = header[15]
  const blueMask = header[16]
  const ncolors = header[19]
  if (version !== 7) throw new Error(`xwd: unsupported file version ${version}`)
  if (format !== 2) throw new Error('xwd: only ZPixmap dumps are supported')
  if (width <= 0 || height <= 0) throw new Error('xwd: the dump has no pixels')
  if (![8, 16, 24, 32].includes(bitsPerPixel)) {
    throw new Error(`xwd: unsupported bits-per-pixel ${bitsPerPixel}`)
  }
  const bytesPerPixel = Math.ceil(bitsPerPixel / 8)
  const stride = Math.max(bytesPerLine, width * bytesPerPixel)
  const dataOffset = headerSize + ncolors * 12
  if (dataOffset + stride * (height - 1) + width * bytesPerPixel > bytes.length) {
    throw new Error('xwd: truncated pixel data')
  }

  // XWDCOLOR: pixel(4) + red/green/blue (16 bit each) + flags/pad.
  const palette = new Map()
  for (let index = 0; index < ncolors; index += 1) {
    const at = headerSize + index * 12
    palette.set(bytes.readUInt32BE(at), {
      red: bytes.readUInt16BE(at + 4) >> 8,
      green: bytes.readUInt16BE(at + 6) >> 8,
      blue: bytes.readUInt16BE(at + 8) >> 8,
    })
  }

  const channel = (value, mask) => {
    if (mask === 0) return 0
    let shift = 0
    while (shift < 32 && ((mask >>> shift) & 1) === 0) shift += 1
    const max = mask >>> shift
    if (max === 0) return 0
    return Math.round((((value & mask) >>> shift) * 255) / max)
  }
  const littleEndian = byteOrder === 0
  const out = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const row = dataOffset + y * stride
    for (let x = 0; x < width; x += 1) {
      const at = row + x * bytesPerPixel
      let value = 0
      if (littleEndian) {
        for (let byte = 0; byte < bytesPerPixel; byte += 1) value += bytes[at + byte] * 2 ** (8 * byte)
      } else {
        for (let byte = 0; byte < bytesPerPixel; byte += 1) value = value * 256 + bytes[at + byte]
      }
      let red
      let green
      let blue
      if (redMask !== 0 || greenMask !== 0 || blueMask !== 0) {
        red = channel(value, redMask)
        green = channel(value, greenMask)
        blue = channel(value, blueMask)
      } else {
        const entry = palette.get(value & 0xffffffff)
        if (entry !== undefined) {
          red = entry.red
          green = entry.green
          blue = entry.blue
        } else {
          const grey = Math.round((value * 255) / Math.max(1, 2 ** bitsPerPixel - 1))
          red = grey
          green = grey
          blue = grey
        }
      }
      const to = (y * width + x) * 3
      out[to] = red
      out[to + 1] = green
      out[to + 2] = blue
    }
  }
  return {
    width,
    height,
    channels: 3,
    data: out,
    pixel(x, y) {
      const index = (y * width + x) * 3
      return [out[index], out[index + 1], out[index + 2]]
    },
  }
}

/* ------------------------------------------------------------------ */
/* PNG decode (filtered, 8-bit, non-interlaced) — no dependencies      */
/* ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('interlaced PNG is not supported')
  let channels
  if (colorType === 2) channels = 3
  else if (colorType === 6) channels = 4
  else throw new Error(`unsupported PNG color type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG pixel data')
  const out = Buffer.alloc(stride * height)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[cursor + x]
      const a = x >= channels ? out[rowStart + x - channels] : 0
      const b = y > 0 ? out[prevStart + x] : 0
      const c = x >= channels && y > 0 ? out[prevStart + x - channels] : 0
      let restored
      switch (filter) {
        case 0:
          restored = value
          break
        case 1:
          restored = value + a
          break
        case 2:
          restored = value + b
          break
        case 3:
          restored = value + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`bad PNG filter ${filter} on row ${y}`)
      }
      out[rowStart + x] = restored & 0xff
    }
    cursor += stride
  }
  return {
    width,
    height,
    channels,
    data: out,
    pixel(x, y) {
      const index = (y * width + x) * channels
      return [out[index], out[index + 1], out[index + 2]]
    },
  }
}

/* ------------------------------------------------------------------ */
/* PNG encode / crop (used for monitors with a negative origin)        */
/* ------------------------------------------------------------------ */

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([length, body, crc])
}

let crcTable = null
function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return crc ^ -1
}

/** Minimal 8-bit RGB/RGBA PNG encoder (filter 0), enough to write a crop. */
export function encodePng(image) {
  const { width, height, channels, data } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('encodePng needs positive integer width/height')
  }
  if (channels !== 3 && channels !== 4) throw new Error(`encodePng supports RGB/RGBA, got ${channels}`)
  if (data.length < width * height * channels) throw new Error('encodePng: pixel buffer is too short')
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Copy a rectangle out of a decoded PNG (absolute image coordinates). */
export function cropImage(image, rect) {
  const { width, height, channels, data } = image
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(width, Math.floor(rect.x + rect.width))
  const bottom = Math.min(height, Math.floor(rect.y + rect.height))
  if (right <= x || bottom <= y) throw new Error('cropImage: the rectangle does not overlap the image')
  const out = Buffer.alloc((right - x) * (bottom - y) * channels)
  for (let row = y; row < bottom; row += 1) {
    const from = (row * width + x) * channels
    data.copy(out, (row - y) * (right - x) * channels, from, from + (right - x) * channels)
  }
  return { width: right - x, height: bottom - y, channels, data: out }
}

/** Nearest-neighbour scaling (used by the optional `scale` of a region shot). */
export function scaleImage(image, factor) {
  const ratio = Number(factor)
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('scaleImage needs a positive factor')
  const width = Math.max(1, Math.round(image.width * ratio))
  const height = Math.max(1, Math.round(image.height * ratio))
  const channels = image.channels
  const out = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / ratio))
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / ratio))
      const from = (sourceY * image.width + sourceX) * channels
      const to = (y * width + x) * channels
      for (let channel = 0; channel < channels; channel += 1) out[to + channel] = image.data[from + channel]
    }
  }
  return { width, height, channels, data: out }
}

/** 8x8 sample of the whole monitor (fallback when the foreground is elsewhere). */
export function fingerprintOfScreen(png) {
  if (!png || png.width < 9 || png.height < 9) return ''
  let fingerprint = ''
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const px = Math.min(png.width - 1, Math.floor(((column + 0.5) * png.width) / 8))
      const py = Math.min(png.height - 1, Math.floor(((row + 0.5) * png.height) / 8))
      const [r, g, b] = png.pixel(px, py)
      fingerprint += `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
    }
  }
  return fingerprint
}

/* ------------------------------------------------------------------ */
/* observation: foreground window + pixel fingerprint                  */
/* ------------------------------------------------------------------ */

function parseXpropValue(text, key) {
  const match = new RegExp(`^${key}\\([^)]*\\)\\s*=\\s*(.*)$`, 'm').exec(text)
  return match === null ? '' : match[1].trim()
}

function parseXpropString(text, key) {
  const raw = parseXpropValue(text, key)
  const quoted = raw.match(/"((?:[^"\\]|\\.)*)"/)
  if (quoted === null) return raw
  return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function parseXpropWindowId(text, key) {
  // xprop spells this one with a colon: `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x...`
  const match = new RegExp(`^${key}\\([^)]*\\)\\s*[=:]\\s*window id #\\s*(0x[0-9a-fA-F]+)`, 'm').exec(text)
  return match === null ? '' : match[1]
}

export async function foregroundWindow() {
  const active = await tool('xprop', ['-root', '_NET_ACTIVE_WINDOW'])
  if (!active.ok) return { ok: false, reason: (active.stderr || active.message || '').trim() }
  const windowId = parseXpropWindowId(active.stdout, '_NET_ACTIVE_WINDOW')
  if (windowId === '' || /^0x0+$/.test(windowId)) {
    return { ok: false, reason: 'no active window' }
  }
  const props = await tool('xprop', ['-id', windowId, 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME', '_NET_WM_PID'])
  const geometry = await tool('xwininfo', ['-id', windowId])
  if (!geometry.ok) return { ok: false, reason: (geometry.stderr || '').trim(), windowId }
  const geometryText = geometry.stdout
  const absoluteX = Number(/Absolute upper-left X:\s*(-?\d+)/.exec(geometryText)?.[1] ?? NaN)
  const absoluteY = Number(/Absolute upper-left Y:\s*(-?\d+)/.exec(geometryText)?.[1] ?? NaN)
  const width = Number(/Width:\s*(\d+)/.exec(geometryText)?.[1] ?? NaN)
  const height = Number(/Height:\s*(\d+)/.exec(geometryText)?.[1] ?? NaN)
  const classRaw = props.ok ? parseXpropValue(props.stdout, 'WM_CLASS') : ''
  const classes = [...classRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((entry) => entry[1])
  const title = props.ok
    ? parseXpropString(props.stdout, '_NET_WM_NAME') || parseXpropString(props.stdout, 'WM_NAME')
    : ''
  const pidText = props.ok ? parseXpropValue(props.stdout, '_NET_WM_PID') : ''
  return {
    ok: true,
    windowId,
    handle: windowId,
    title,
    process: classes.length > 0 ? classes[classes.length - 1] : '',
    classes,
    pid: Number(pidText) || 0,
    rect: { x: absoluteX, y: absoluteY, width, height },
  }
}

/**
 * Identity of the window that would receive a click at the pointer (X11 has no
 * cheap point hit-test, so callers warp to the point first). Used by the
 * adapter to keep automated input out of the DSH window even when another
 * application owns the foreground.
 */
export async function windowAtCursor() {
  const location = await tool('xdotool', ['getmouselocation', '--shell'])
  if (!location.ok) return { ok: false, reason: (location.stderr || location.message || '').trim() }
  const windowId = /^WINDOW=(\d+)$/m.exec(location.stdout)?.[1] ?? ''
  if (windowId === '' || windowId === '0') return { ok: false, reason: 'no window under the pointer' }
  const props = await tool('xprop', ['-id', windowId, 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'])
  if (!props.ok) return { ok: false, windowId, reason: `xprop failed: ${(props.stderr || props.message || '').trim()}` }
  const classRaw = parseXpropValue(props.stdout, 'WM_CLASS')
  const classes = [...classRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((entry) => entry[1])
  const title = parseXpropString(props.stdout, '_NET_WM_NAME') || parseXpropString(props.stdout, 'WM_NAME')
  return {
    ok: true,
    windowId,
    title,
    classes,
    process: classes.length > 0 ? classes[classes.length - 1] : '',
    // A frame/wrapper window can have no WM_CLASS at all. Callers that use this
    // as a security guard must treat "unidentified" as "cannot rule out DSH".
    identified: title !== '' || classes.length > 0,
  }
}

/** The monitor a rectangle overlaps the most. */
export function screenOfRect(screens, rect) {
  let best = null
  let bestArea = 0
  for (const screen of screens) {
    const left = Math.max(rect.x, screen.x)
    const top = Math.max(rect.y, screen.y)
    const right = Math.min(rect.x + rect.width, screen.x + screen.width)
    const bottom = Math.min(rect.y + rect.height, screen.y + screen.height)
    const area = Math.max(0, right - left) * Math.max(0, bottom - top)
    if (area > bestArea) {
      bestArea = area
      best = screen
    }
  }
  return best === null ? null : { screen: best, area: bestArea }
}

export function fingerprintOfWindow(png, screen, rect) {
  const left = Math.max(rect.x, screen.x)
  const top = Math.max(rect.y, screen.y)
  const right = Math.min(rect.x + rect.width, screen.x + screen.width)
  const bottom = Math.min(rect.y + rect.height, screen.y + screen.height)
  const width = right - left
  const height = bottom - top
  if (width < 9 || height < 9) return ''
  let fingerprint = ''
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const px = Math.min(width - 1, Math.floor(((column + 0.5) * width) / 8))
      const py = Math.min(height - 1, Math.floor(((row + 0.5) * height) / 8))
      const [r, g, b] = png.pixel(left - screen.x + px, top - screen.y + py)
      fingerprint += `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
    }
  }
  return fingerprint
}

export function compareFingerprint(expected, actual, threshold = 40) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return 999
  if (expected.length !== actual.length || expected.length < 6) return 999
  let changed = 0
  for (let index = 0; index < expected.length; index += 6) {
    const dr = Math.abs(parseInt(expected.slice(index, index + 2), 16) - parseInt(actual.slice(index, index + 2), 16))
    const dg = Math.abs(parseInt(expected.slice(index + 2, index + 4), 16) - parseInt(actual.slice(index + 2, index + 4), 16))
    const db = Math.abs(parseInt(expected.slice(index + 4, index + 6), 16) - parseInt(actual.slice(index + 4, index + 6), 16))
    if (dr > threshold || dg > threshold || db > threshold) changed += 1
  }
  return changed
}

export async function cursorPosition() {
  const result = await tool('xdotool', ['getmouselocation', '--shell'])
  if (!result.ok) throw fail('xdotool getmouselocation', result)
  const read = (key) => Number(new RegExp(`^${key}=(-?\\d+)`, 'm').exec(result.stdout)?.[1] ?? NaN)
  const x = read('X')
  const y = read('Y')
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('xdotool getmouselocation returned no position')
  return { x, y }
}

export function localPoint(screen, globalX, globalY) {
  return { x: globalX - screen.x, y: globalY - screen.y }
}

/**
 * Full observation for one monitor.
 * Returns the shape index.js needs to mint an observation token.
 */
export async function observe(screens, screenId, path) {
  // `screen: "cursor"` follows the pointer, so read it before the capture. The
  // pointer can move again during the capture; the returned cursor is re-read
  // fresh below, so the token always describes the final state.
  const wantsCursor = typeof screenId === 'string' && screenId.trim().toLowerCase() === 'cursor'
  const pointer = wantsCursor ? await cursorPosition() : null
  const screen = pickScreen(screens, screenId, { cursor: pointer })
  await captureScreen(screen, path)
  const png = decodePng(readFileSync(path))
  const foreground = await foregroundWindow()
  const cursor = await cursorPosition()
  const onScreen = foreground.ok ? screenOfRect(screens, foreground.rect) : null
  const fingerprint = foreground.ok ? fingerprintOfWindow(png, screen, foreground.rect) : ''
  return {
    path,
    screen: screenPublicView(screen),
    screens: screensPublicView(screens),
    width: screen.width,
    height: screen.height,
    originX: screen.x,
    originY: screen.y,
    cursor: { ...localPoint(screen, cursor.x, cursor.y), globalX: cursor.x, globalY: cursor.y },
    foreground: foreground.ok
      ? {
          screen: onScreen === null ? '' : onScreen.screen.id,
          onThisScreen: onScreen !== null && onScreen.screen.id === screen.id,
          handle: foreground.handle,
          title: foreground.title,
          process: foreground.process,
          classes: foreground.classes,
          pid: foreground.pid,
          rect: `${foreground.rect.x},${foreground.rect.y},${foreground.rect.width},${foreground.rect.height}`,
          x: foreground.rect.x,
          y: foreground.rect.y,
          windowWidth: foreground.rect.width,
          windowHeight: foreground.rect.height,
        }
      : { screen: '', onThisScreen: false, handle: '', title: '', process: '', classes: [], pid: 0, rect: '', x: 0, y: 0, windowWidth: 0, windowHeight: 0 },
    fingerprint,
  }
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

const MAX_WARP_ATTEMPTS = 3

/** Warp the pointer and PROVE it landed where we asked. */
export async function warpTo(screen, localX, localY) {
  const targetX = screen.x + Math.round(localX)
  const targetY = screen.y + Math.round(localY)
  // `xdotool mousemove --sync` waits for a motion event; asking for the current
  // position produces none and hangs until the call times out. Check first.
  try {
    const current = await cursorPosition()
    if (current.x === targetX && current.y === targetY) {
      return { ok: true, globalX: targetX, globalY: targetY, attempts: 0 }
    }
  } catch {
    // The probe is an optimization only: fall through to the real warp.
  }
  let last = null
  for (let attempt = 1; attempt <= MAX_WARP_ATTEMPTS; attempt += 1) {
    const result = await tool('xdotool', ['mousemove', '--sync', String(targetX), String(targetY)], { timeoutMs: 4_000 })
    if (!result.ok) throw fail('xdotool mousemove', result)
    await delay(20)
    last = await cursorPosition()
    if (last.x === targetX && last.y === targetY) {
      return { ok: true, globalX: targetX, globalY: targetY, attempts: attempt }
    }
    await delay(60)
  }
  return {
    ok: false,
    code: 'pointer_warp_unstable',
    globalX: last?.x ?? null,
    globalY: last?.y ?? null,
    expectedX: targetX,
    expectedY: targetY,
  }
}

async function releaseButtons() {
  await tool('xdotool', ['mouseup', '1'], { timeoutMs: 2_000 })
  await tool('xdotool', ['mouseup', '2'], { timeoutMs: 2_000 })
  await tool('xdotool', ['mouseup', '3'], { timeoutMs: 2_000 })
}

const BUTTON = { left: 1, middle: 2, right: 3 }

export async function move(screen, args) {
  const landed = await warpTo(screen, args.x, args.y)
  return landed.ok
    ? { ok: true, detail: `moved the pointer to (${args.x}, ${args.y}) on ${screen.id}` }
    : landed
}

export async function clickAt(screen, args, buttonName = 'left', repeat = 1) {
  const button = BUTTON[buttonName] ?? 1
  const landed = await warpTo(screen, args.x, args.y)
  if (!landed.ok) return landed
  const result = await tool('xdotool', ['click', '--repeat', String(repeat), '--delay', '80', String(button)])
  if (!result.ok) return { ok: false, code: 'click_failed', detail: (result.stderr || result.message || '').trim() }
  const labels = repeat > 1 ? `clicked ${buttonName} twice` : `clicked ${buttonName}`
  return { ok: true, detail: `${labels} at (${args.x}, ${args.y}) on ${screen.id}` }
}

export async function drag(screen, args) {
  const start = await warpTo(screen, args.x, args.y)
  if (!start.ok) return start
  let failed = null
  try {
    const down = await tool('xdotool', ['mousedown', '1'])
    if (!down.ok) return { ok: false, code: 'drag_failed', detail: (down.stderr || '').trim() }
    const steps = 12
    for (let step = 1; step <= steps; step += 1) {
      const x = Math.round(args.x + ((args.toX - args.x) * step) / steps)
      const y = Math.round(args.y + ((args.toY - args.y) * step) / steps)
      const moved = await tool('xdotool', ['mousemove', String(screen.x + x), String(screen.y + y)], { timeoutMs: 3_000 })
      if (!moved.ok) {
        failed = `drag move ${step}/${steps} failed: ${(moved.stderr || moved.message || '').trim()}`
        break
      }
      await delay(12)
    }
    if (failed === null) {
      // CONTRACT 2.1.2: never report a drag that silently stopped short.
      const targetX = screen.x + Math.round(args.toX)
      const targetY = screen.y + Math.round(args.toY)
      const landed = await cursorPosition()
      if (landed.x !== targetX || landed.y !== targetY) {
        failed = `the pointer stopped at (${landed.x},${landed.y}) instead of (${targetX},${targetY})`
      }
    }
    return failed === null
      ? { ok: true, detail: `dragged from (${args.x}, ${args.y}) to (${args.toX}, ${args.toY}) on ${screen.id}` }
      : { ok: false, code: 'drag_unstable', detail: failed }
  } finally {
    await releaseButtons()
  }
}

export async function scroll(screen, args) {
  const delta = Number.isFinite(args.delta) ? args.delta : -120
  const notches = Math.max(1, Math.round(Math.abs(delta) / 120))
  const button = delta < 0 ? 5 : 4
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
    const landed = await warpTo(screen, args.x, args.y)
    if (!landed.ok) return landed
  }
  const result = await tool('xdotool', ['click', '--repeat', String(notches), '--delay', '40', String(button)])
  if (!result.ok) return { ok: false, code: 'scroll_failed', detail: (result.stderr || '').trim() }
  return { ok: true, detail: `scrolled ${delta < 0 ? 'down' : 'up'} by ${Math.abs(delta)} on ${screen.id}` }
}

/** Read the clipboard, best-effort; empty string when unavailable. */
async function readClipboard() {
  const result = await tool('xclip', ['-o', '-selection', 'clipboard'], { timeoutMs: 2_000 })
  return result.ok ? result.stdout : ''
}

function writeClipboard(text) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}

export async function typeText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: 'invalid_args', detail: '"text" is required for the type action' }
  }
  const ascii = /^[\x20-\x7e\r\n\t]*$/.test(text)
  if (ascii) {
    const result = await tool('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', text], { timeoutMs: 30_000 })
    if (!result.ok) return { ok: false, code: 'type_failed', detail: (result.stderr || '').trim() }
    return { ok: true, detail: `typed ${text.length} character(s)` }
  }
  const previous = await readClipboard()
  const written = await writeClipboard(text)
  if (!written) {
    return { ok: false, code: 'clipboard_unavailable', detail: 'xclip is not installed or the clipboard is unavailable' }
  }
  await delay(60)
  const pasted = await tool('xdotool', ['key', '--clearmodifiers', 'ctrl+v'])
  await delay(120)
  if (previous !== '') await writeClipboard(previous)
  if (!pasted.ok) return { ok: false, code: 'paste_failed', detail: (pasted.stderr || '').trim() }
  return { ok: true, detail: `typed ${text.length} character(s) via clipboard paste` }
}

const MODIFIERS = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  win: 'super',
  super: 'super',
  meta: 'super',
  cmd: 'super',
}

const NAMED_KEYS = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  printscreen: 'Print',
  pause: 'Pause',
  capslock: 'Caps_Lock',
  minus: 'minus',
  plus: 'plus',
  slash: 'slash',
  backslash: 'backslash',
  comma: 'comma',
  period: 'period',
  semicolon: 'semicolon',
  quote: 'apostrophe',
  grave: 'grave',
}

export function resolveKeyToken(token) {
  const lower = String(token ?? '').trim().toLowerCase()
  if (lower === '') throw new Error('empty key in "keys"')
  if (MODIFIERS[lower] !== undefined) return { kind: 'modifier', value: MODIFIERS[lower] }
  if (NAMED_KEYS[lower] !== undefined) return { kind: 'key', value: NAMED_KEYS[lower] }
  if (/^[a-z]$/.test(lower)) return { kind: 'key', value: lower }
  if (/^[0-9]$/.test(lower)) return { kind: 'key', value: lower }
  const functionKey = /^f([1-9]|1[0-2])$/.exec(lower)
  if (functionKey !== null) return { kind: 'key', value: `F${functionKey[1]}` }
  throw new Error(`unknown key "${token}"`)
}

export async function pressKeys(keys) {
  const parts = String(keys ?? '').split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('"keys" must name at least one key, for example "Ctrl+Shift+I"')
  const main = resolveKeyToken(parts[parts.length - 1])
  // Parity with Windows: `xdotool key ctrl` presses and releases the modifier
  // alone, so a lone modifier is a valid (if unusual) key action.
  const modifiers = parts.slice(0, -1).map((part) => {
    const resolved = resolveKeyToken(part)
    if (resolved.kind !== 'modifier') throw new Error(`"${part}" is not a modifier; use Ctrl, Shift, Alt or Win`)
    return resolved.value
  })
  const chord = [...modifiers, main.value].join('+')
  const result = await tool('xdotool', ['key', '--clearmodifiers', chord], { timeoutMs: 5_000 })
  if (!result.ok) return { ok: false, code: 'key_failed', detail: (result.stderr || '').trim() }
  return { ok: true, detail: `pressed ${keys}` }
}

/**
 * Dispatch one input action against a monitor.
 * `action` mirrors the DSH tool's action names.
 */
export async function dispatch(screen, action, args) {
  switch (action) {
    case 'move':
      return move(screen, args)
    case 'click':
      return clickAt(screen, args, 'left', 1)
    case 'double_click':
      return clickAt(screen, args, 'left', 2)
    case 'right_click':
      return clickAt(screen, args, 'right', 1)
    case 'drag':
      return drag(screen, args)
    case 'scroll':
      return scroll(screen, args)
    case 'type':
      return typeText(String(args?.text ?? ''))
    case 'key':
      return pressKeys(String(args?.keys ?? ''))
    default:
      return { ok: false, code: 'unsupported_action', detail: `unsupported action "${action}"` }
  }
}

/* ------------------------------------------------------------------ */
/* self-check                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* lock state                                                          */
/* ------------------------------------------------------------------ */

const LOCK_CACHE_MS = 1_000
const LOCK_WINDOW_CLASSES = [
  'gnome-screensaver',
  'XScreenSaver',
  'xscreensaver',
  'i3lock',
  'swaylock',
  'light-locker',
  'hyprlock',
  'kscreenlocker',
]
let lockCache = { at: 0, value: null }

/**
 * Best-effort "is the X session locked?" probe. A locked session silently
 * discards injected input, so the adapter refuses activating actions when this
 * reports locked (Windows has DesktopLocked for the same reason).
 *
 * Three independent sources, first conclusive answer wins:
 *  1. logind's LockedHint for the session
 *  2. GNOME ScreenSaver.GetActive over the session bus
 *  3. a visible lock-screen window class
 */
export async function lockState() {
  if (lockCache.value !== null && Date.now() - lockCache.at < LOCK_CACHE_MS) return lockCache.value
  const sources = []
  const sessionId = String(process.env.XDG_SESSION_ID ?? '').trim()
  if (sessionId !== '') {
    const result = await tool('loginctl', ['show-session', sessionId, '-p', 'LockedHint'], { timeoutMs: 3_000 })
    if (result.ok) {
      if (/LockedHint=yes/i.test(result.stdout)) {
        lockCache = { at: Date.now(), value: { locked: true, source: 'loginctl', conclusive: true, sources } }
        return lockCache.value
      }
      if (/LockedHint=no/i.test(result.stdout)) {
        lockCache = { at: Date.now(), value: { locked: false, source: 'loginctl', conclusive: true, sources } }
        return lockCache.value
      }
      sources.push('loginctl: no LockedHint')
    } else {
      sources.push('loginctl unavailable')
    }
  } else {
    sources.push('XDG_SESSION_ID is empty')
  }

  const dbus = await tool(
    'dbus-send',
    ['--session', '--print-reply', '--dest=org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver.GetActive'],
    { timeoutMs: 3_000 },
  )
  if (dbus.ok) {
    if (/boolean\s+true/i.test(dbus.stdout)) {
      lockCache = { at: Date.now(), value: { locked: true, source: 'gnome-screensaver', conclusive: true, sources } }
      return lockCache.value
    }
    if (/boolean\s+false/i.test(dbus.stdout)) {
      lockCache = { at: Date.now(), value: { locked: false, source: 'gnome-screensaver', conclusive: true, sources } }
      return lockCache.value
    }
    sources.push('gnome-screensaver: unparsed reply')
  } else {
    sources.push('gnome-screensaver unavailable')
  }

  const lockWindow = await tool('xdotool', ['search', '--onlyvisible', '--class', LOCK_WINDOW_CLASSES.join('|')], {
    timeoutMs: 3_000,
  })
  if (lockWindow.ok && lockWindow.stdout.trim() !== '') {
    const value = { locked: true, source: 'lock-window', conclusive: true, sources }
    lockCache = { at: Date.now(), value }
    return value
  }
  if (lockWindow.ok) sources.push('no lock-screen window')
  else sources.push('xdotool lock-window probe failed')

  const value = { locked: false, source: null, conclusive: false, sources }
  lockCache = { at: Date.now(), value }
  return value
}

const REQUIRED_TOOLS = ['xdotool', 'xprop', 'xwininfo', 'xrandr']
// Optional helpers: reported for diagnostics, never treated as failures.
// A screenshot only needs one of CAPTURE_TOOLS, so those are probed with the
// capture selection instead of being required here.
const OPTIONAL_TOOLS = ['xclip', 'loginctl', 'dbus-send']

const INSTALL_HINTS = {
  xdotool: 'install xdotool (Debian/Ubuntu: sudo apt install xdotool)',
  scrot: 'install scrot (Debian/Ubuntu: sudo apt install scrot)',
  import: 'install ImageMagick (provides import)',
  xwd: 'install x11-apps (provides xwd)',
  xprop: 'install x11-utils (provides xprop and xwininfo)',
  xwininfo: 'install x11-utils (provides xprop and xwininfo)',
  xrandr: 'install x11-xserver-utils (provides xrandr)',
  xclip: 'optional: typing uses the built-in GTK clipboard helper, xclip is only a fallback diagnostic',
  loginctl: 'optional: lock-screen detection falls back to DBus and lock windows',
  'dbus-send': 'optional: lock-screen detection falls back to logind and lock windows',
}

/**
 * The two python helpers are optional but load-bearing for the brake and for
 * non-ASCII typing, so a missing interpreter or module is a warning with a
 * reason rather than a hard failure. Detecting it here (instead of discovering
 * it when the first hotkey or CJK keystroke is needed) is what makes the
 * plugin portable across minimal desktops.
 */
async function pythonProbe() {
  const executable = process.env.DSH_COMPUTER_USE_PYTHON || 'python3'
  const [version, xlib, gtk] = await Promise.all([
    tool(executable, ['-c', 'import sys; print(sys.version.split()[0])'], { timeoutMs: 3_000 }),
    tool(executable, ['-c', 'import Xlib'], { timeoutMs: 5_000 }),
    tool(executable, ['-c', 'import gi; gi.require_version("Gtk", "3.0")'], { timeoutMs: 5_000 }),
  ])
  return {
    executable,
    present: version.ok,
    version: version.ok ? (version.stdout.trim().split(/\r?\n/)[0] ?? '') : '',
    modules: { Xlib: xlib.ok, Gtk3: gtk.ok },
    ...(version.ok ? {} : { error: (version.stderr || version.message || '').trim().slice(0, 200) }),
  }
}

export async function inputCheck(options = {}) {
  const problems = []
  const warnings = []
  const display = process.env.DISPLAY ?? ''
  const sessionType = process.env.XDG_SESSION_TYPE ?? ''
  if (display === '') problems.push('DISPLAY is empty: DSH was probably not started from the desktop session')
  if (sessionType !== '' && sessionType !== 'x11') problems.push(`session type is "${sessionType}", expected "x11"`)

  const captureChoice = await currentCapture()
  const binaries = [...new Set([...REQUIRED_TOOLS, ...OPTIONAL_TOOLS, ...CAPTURE_TOOLS])]
  const presence = await Promise.all(binaries.map((binary) => toolPresent(binary)))
  const tools = Object.fromEntries(binaries.map((binary, index) => [binary, presence[index]]))
  const missingTools = REQUIRED_TOOLS.filter((binary) => tools[binary] !== true)
  for (const binary of missingTools) problems.push(`${binary} is not installed (${INSTALL_HINTS[binary]})`)
  if (captureChoice.name === '') problems.push(`${captureChoice.error} (${CAPTURE_TOOLS.map((name) => INSTALL_HINTS[name]).join('; ')})`)

  const captureInfo = {
    method: captureChoice.name,
    available: captureChoice.available,
    forced: String(process.env.DSH_COMPUTER_USE_CAPTURE ?? '').trim().toLowerCase(),
  }

  const python = await pythonProbe()
  if (!python.present) {
    warnings.push('python3 is not available: the emergency hotkey and the clipboard typing helper are disabled')
  } else {
    if (!python.modules.Xlib) warnings.push('python3-Xlib is missing: the global emergency hotkey cannot be registered')
    if (!python.modules.Gtk3) warnings.push('python3-Gtk3 is missing: typing falls back to raw key events (CJK unavailable)')
  }

  const paused = typeof options.pausePath === 'string' && options.pausePath !== '' && existsSync(options.pausePath)
  let lock = { locked: false, source: null, conclusive: false, sources: [] }
  try {
    lock = await lockState()
  } catch {
    // Best effort: the warp probe below will surface a real input problem.
  }

  let screens = []
  try {
    screens = await listScreens()
  } catch (error) {
    problems.push(`monitor enumeration failed: ${String(error?.message ?? error)}`)
  }

  const layout = {
    signature: layoutSignature(screens),
    screens: screensPublicView(screens),
    root: screens.length > 0 ? rootBounds(screens) : null,
  }

  let warp = null
  // CONTRACT 2.1.5: while paused (or while the session is locked, where input
  // is discarded) do not inject anything — the warp probe is real XTest input.
  if (paused || lock.locked) {
    warp = {
      skipped: true,
      reason: paused
        ? 'desktop control is paused, so the pointer probe was skipped'
        : 'the X session is locked, so the pointer probe was skipped',
    }
  } else if (!problems.some((problem) => problem.startsWith('xdotool'))) {
    try {
      // A human (or another client) can move the pointer between the warp and the
      // read-back, so one failed probe proves nothing. Retry a few times and
      // accept a 1px tolerance before reporting a broken input path.
      let before = null
      let after = null
      let moved = false
      let attempts = 0
      while (attempts < 3 && !moved) {
        attempts += 1
        before = await cursorPosition()
        const direction = before.x < 2 ? 1 : -1
        const probeX = before.x + direction
        const probe = await tool('xdotool', ['mousemove', String(probeX), String(before.y)], { timeoutMs: 3_000 })
        await delay(60)
        after = await cursorPosition()
        await tool('xdotool', ['mousemove', String(before.x), String(before.y)], { timeoutMs: 3_000 })
        moved = probe.ok && Math.abs(after.x - probeX) <= 1 && Math.abs(after.y - before.y) <= 1
        if (!moved) await delay(80)
      }
      warp = { before, after, moved, attempts }
      if (!moved) problems.push(`the pointer did not follow an XTest warp (${attempts} attempts; is another client moving it?)`)
    } catch (error) {
      problems.push(`pointer self-check failed: ${String(error?.message ?? error)}`)
    }
  }

  let capture = null
  if (captureChoice.name !== '') {
    const path = `/tmp/dsh-cu-selfcheck-${process.pid}-${Math.random().toString(36).slice(2, 8)}.png`
    try {
      const screen = screens[0] ?? null
      if (screen !== null) {
        await captureScreen(screen, path)
        const png = decodePng(readFileSync(path))
        capture = { width: png.width, height: png.height, channels: png.channels, method: captureChoice.name }
        if (png.width !== screen.width || png.height !== screen.height) {
          problems.push(`capture size ${png.width}x${png.height} does not match monitor ${screen.id} ${screen.width}x${screen.height}`)
        }
      }
    } catch (error) {
      problems.push(`screenshot self-check failed: ${String(error?.message ?? error)}`)
    } finally {
      try {
        rmSync(path, { force: true })
      } catch {
        // best effort
      }
    }
  }

  let foreground = null
  try {
    foreground = await foregroundWindow()
    if (!foreground.ok) {
      // A locked session legitimately has no active window (and the pointer
      // probe above was skipped). That is a session state, not a broken input
      // path: report it through the guidance instead of as a failing problem.
      if (lock.locked) {
        foreground = { ok: false, reason: 'the X session is locked, so there is no active window' }
        warnings.push('the X session is locked: the active window cannot be read until it is unlocked')
      } else {
        problems.push(`foreground window unreadable: ${foreground.reason ?? 'unknown'}`)
      }
    }
  } catch (error) {
    problems.push(`foreground probe failed: ${String(error?.message ?? error)}`)
  }

  const monitorSummary = screens.length === 0
    ? 'no monitor detected'
    : `${screens.length} monitor(s): ${screens
        .map((screen) => {
          const dpi = Number.isFinite(screen.dpi) ? ` @${screen.dpi}dpi` : ''
          return `${screen.id} ${screen.width}x${screen.height}${dpi}${screen.primary ? ' primary' : ''}`
        })
        .join('; ')}`

  return {
    ok: problems.length === 0,
    backend: name,
    display,
    sessionType,
    tools,
    // One structured block for "what desktop am I on": session type, windowing
    // system hints, the tools that were found, the python helpers and the
    // detected monitor layout (with DPI). Models and the UI read this instead
    // of assuming a fixed machine.
    environment: {
      platform: process.platform,
      sessionType,
      display,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? '',
      desktop: process.env.XDG_CURRENT_DESKTOP ?? '',
      sessionId: process.env.XDG_SESSION_ID ?? '',
      tools,
      missingTools,
      installHints: Object.fromEntries(missingTools.map((binary) => [binary, INSTALL_HINTS[binary]])),
      python,
      capture: captureInfo,
      layout,
    },
    screens: screensPublicView(screens),
    root: screens.length > 0 ? rootBounds(screens) : null,
    warp,
    capture,
    foreground: foreground === null ? null : {
      handle: foreground.handle ?? '',
      title: foreground.title ?? '',
      process: foreground.process ?? '',
      classes: foreground.classes ?? [],
    },
    paused,
    locked: lock.locked === true,
    lockSource: lock.source,
    lockConclusive: lock.conclusive === true,
    problems,
    warnings,
    guidance: problems.length === 0
      ? paused
        ? 'Desktop control is paused; the pointer probe was skipped. Ask the user to resume before acting.'
        : lock.locked
          ? 'The X session is locked; ask the user to unlock it before acting.'
          : `X11 input path is available (${monitorSummary}); take a screenshot and act normally.`
      : `Address these before driving the desktop: ${problems.join('; ')}`,
  }
}

/**
 * Emit the Web bundle the DSH client module loader consumes.
 *
 * Why this exists: the DSH Web module system does not execute ESM plugin files.
 * It serves a classic script per package and expects it to call
 * `window.__ModuleLoader__.load({id, factory})`, where `factory(require)` returns
 * the plugin face (`{name, inject, apply}`). See
 * `@deepseek-ai/dsh-client-modules` (`defaultLoadBundle` appends a plain
 * `<script>`), and every UI plugin shipped with 0.2.2-rc.2 or installed in a
 * profile uses exactly that shape.
 *
 * `client.js` stays the ESM authoring source (importable in Node for checks);
 * this script mechanically wraps it into `client.web.js`. The transform is
 * deliberately dumb and asserted:
 *   1. exactly one top-level `export` statement exists, and it is
 *      `export default face`;
 *   2. every other line is classic-script compatible (no `import`/`export`);
 *   3. the emitted bundle parses as a classic script.
 *
 * Run it with `node scripts/build-client.mjs` (also wired to `npm run
 * build:client` and to `prepack`, so `npm pack` always ships a fresh bundle).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'client.js')
const outputPath = join(root, 'client.web.js')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const source = readFileSync(sourcePath, 'utf8')
const exports = [...source.matchAll(/^export\s.*$/gm)].map((match) => match[0])
const imports = [...source.matchAll(/^import\s.*$/gm)].map((match) => match[0])
if (exports.length !== 1) {
  throw new Error(`client.js must contain exactly one top-level export statement, found ${exports.length}: ${exports.join(' | ')}`)
}
if (exports[0] !== 'export default face') {
  throw new Error(`client.js must end with "export default face", found: ${exports[0]}`)
}
if (imports.length !== 0) {
  throw new Error(`client.js must stay import-free (the Web bundle inlines it), found: ${imports.join(' | ')}`)
}

const body = source.replace(/^export default face$/m, 'const __entry = face')
if (body === source) throw new Error('client.js: the export default transform did not apply')

const indent = (text) => text.replace(/^(?=.)/gm, '    ')
const bundle = `/**
 * GENERATED FILE — do not edit. Source: client.js, generator: scripts/build-client.mjs.
 *
 * Classic script consumed by the DSH Web module loader; it registers a lazy
 * factory (id = package name) and materializes the plugin face on first import.
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory(require) {
${indent(body)}
    // The shell owns React; hand it to the ESM-side implementation.
    __setReactImpl(require('react'))
    return __entry
  },
})
`

try {
  // Parsing only: the bundle body is not executed here.
  new Function(bundle)
} catch (error) {
  throw new Error(`generated client.web.js does not parse as a classic script: ${error.message}`)
}

writeFileSync(outputPath, bundle, 'utf8')
console.log(`client.web.js written (${Buffer.byteLength(bundle)} bytes, id=${pkg.name})`)

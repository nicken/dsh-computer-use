/**
 * dsh-computer-use — Web client half (ESM authoring source).
 *
 * Contributes three things to the Web shell:
 *   1. a Conversation view tab (`conversation.view` id `computer-use`, order 20)
 *      that replays every desktop operation of the Session, grouped by round,
 *      and carries the pause/brake status bar of the Host provider;
 *   2. the per-conversation switch at the top of that tab. Computer use stays
 *      OFF until the user flips it; the switch reads and writes
 *      `/api/computer-use/capability`, i.e. the same
 *      `~/.dsh/capability-toggles.json` entry the tools' `when` predicate reads,
 *      so the tools appear for the agent's next step and disappear again when
 *      the switch is turned off;
 *   3. chat cards for the desktop tools (`tool.call.toolview`), so screenshots
 *      and input actions stay reviewable in the conversation history.
 *
 * Runtime shape: the DSH Web module loader does not execute ESM; it serves a
 * classic script that registers a lazy factory (`window.__ModuleLoader__.load`).
 * This file is the source of truth and `scripts/build-client.mjs` emits
 * `client.web.js` (the artifact the loader actually consumes) from it, while the
 * Node-side `import('./client.js')` keeps yielding `{name, inject, apply}` for
 * checks. Keep exactly one top-level `export` statement in this file so that
 * transform stays mechanical, and never touch `window`/`document` at module
 * scope: `apply` is the only place that runs in the browser.
 */

/** Locale namespace owned by this plugin. */
const NS = 'computerUse'

/** Routes served by the Host half; all are document-relative app routes. */
const CAPABILITY_SUFFIX = 'api/computer-use/capability'
const STATUS_SUFFIX = 'api/computer-use/status'
const SHOT_SUFFIX = 'api/computer-use/shot'

/** Tool wire names owned by dsh-computer-use (`computer_input` is legacy). */
const SHOT_TOOL = 'computer_screenshot'
const INPUT_TOOLS = ['computer', 'computer_input']

const zh = {
  // Tab and trace surfaces (migrated from @local/dsh-session-capabilities).
  desktopView: '桌面',
  desktopTraceTitle: '桌面操作回溯',
  desktopTraceHint: '本会话中 computer_screenshot 与 computer 的执行记录，按轮次分组，可独立查看。',
  desktopFilterAll: '全部',
  desktopFilterRound: '本轮',
  desktopFilterShots: '截图',
  desktopFilterInputs: '操作',
  desktopNoMatch: '当前筛选下没有桌面操作。',
  tapMark: '点击位置已用红框标在 {time} 的截图上',
  desktopAction: '桌面操作',
  desktopScreenshot: '桌面截图',
  running: '执行中…',
  enlarge: '放大',
  shrink: '收起',
  roundTitle: '第 {n} 轮',
  roundOther: '会话开始前',
  opsCount: '{n} 次操作',
  opsSummary: '共 {n} 次操作，{m} 轮',
  opsEmptyTitle: '本会话还没有桌面操作',
  opsEmptyHint: '智能体调用 computer_screenshot 或 computer 后，记录会按轮次汇总在这里。',
  opsNoHookTitle: '桌面视图暂不可用',
  opsNoHookHint: '需要启用轨迹视图（ui-trajectory）才能读取工具调用记录。',
  opsFailed: '调用失败',
  cuRunning: '运行中',
  cuPaused: '已暂停',
  cuPause: '暂停桌面操作',
  cuResume: '恢复桌面操作',
  cuBrake: '急停',
  cuBrakeUnavailable: '急停不可用',
  cuAudit: '审计',
  cuRefused: '已拒绝',
  cuInputCheck: '输入自检',
  cuObservation: '观察令牌',
  cuSteps: '{n} 步',
  cuIntent: '意图',
  cuStatusOffline: '桌面状态不可用',
  // Per-conversation switch (new in 1.5.0).
  capOffTitle: '本会话未开启电脑操作',
  capOffHint: '开启后智能体在下一步即可使用桌面截图与鼠标/键盘工具；默认关闭，且只对当前会话生效。',
  capOnTitle: '本会话已开启电脑操作',
  capOnHint: '桌面截图与鼠标/键盘工具在本会话可用；关闭后立即从工具列表移除。',
  capEnable: '开启电脑操作',
  capDisable: '关闭电脑操作',
  capLoading: '正在读取电脑操作开关…',
  capSaving: '正在保存…',
  capLoadFailed: '无法读取电脑操作开关：{message}',
  capSaveFailed: '保存电脑操作开关失败：{message}',
  capNoSession: '缺少会话 id，无法读写电脑操作开关。',
}

const en = {
  desktopView: 'Desktop',
  desktopTraceTitle: 'Desktop activity',
  desktopTraceHint: 'computer_screenshot and computer calls from this session, grouped by round and reviewable on their own.',
  desktopFilterAll: 'All',
  desktopFilterRound: 'This round',
  desktopFilterShots: 'Screenshots',
  desktopFilterInputs: 'Actions',
  desktopNoMatch: 'No desktop records match this filter.',
  tapMark: 'Click position boxed on the {time} screenshot',
  desktopAction: 'Desktop action',
  desktopScreenshot: 'Desktop screenshot',
  running: 'Running…',
  enlarge: 'Enlarge',
  shrink: 'Shrink',
  roundTitle: 'Round {n}',
  roundOther: 'Before the session',
  opsCount: '{n} actions',
  opsSummary: '{n} actions across {m} rounds',
  opsEmptyTitle: 'No desktop activity yet',
  opsEmptyHint: 'When the agent calls computer_screenshot or computer, its records are collected here by round.',
  opsNoHookTitle: 'Desktop view is unavailable',
  opsNoHookHint: 'Enable the Trajectory view (ui-trajectory) so tool-call records can be read.',
  opsFailed: 'Call failed',
  cuRunning: 'Running',
  cuPaused: 'Paused',
  cuPause: 'Pause desktop actions',
  cuResume: 'Resume desktop actions',
  cuBrake: 'Emergency stop',
  cuBrakeUnavailable: 'Emergency stop unavailable',
  cuAudit: 'Audit',
  cuRefused: 'Refused',
  cuInputCheck: 'Input check',
  cuObservation: 'Observation token',
  cuSteps: '{n} steps',
  cuIntent: 'Intent',
  cuStatusOffline: 'Desktop status is unavailable',
  capOffTitle: 'Computer use is off for this conversation',
  capOffHint:
    'Turn it on so the agent can use the desktop screenshot and mouse/keyboard tools from its next step. Off by default, and scoped to this conversation.',
  capOnTitle: 'Computer use is on for this conversation',
  capOnHint: 'Desktop screenshot and mouse/keyboard tools are available here. Turning it off removes them immediately.',
  capEnable: 'Enable computer use',
  capDisable: 'Disable computer use',
  capLoading: 'Reading the computer-use switch…',
  capSaving: 'Saving…',
  capLoadFailed: 'Cannot read the computer-use switch: {message}',
  capSaveFailed: 'Cannot save the computer-use switch: {message}',
  capNoSession: 'No session id, so the computer-use switch cannot be read or written.',
}

/**
 * React is handed to this module by the generated Web bundle
 * (`client.web.js` → `__setReactImpl(require('react'))`) right before the shell
 * calls `apply`; a bare Node import of this file never needs it.
 */
let ReactImpl = null

/** @internal Set by the generated Web bundle, never by application code. */
function __setReactImpl(React) {
  ReactImpl = React
}

// ---------------------------------------------------------------------------
// Small shared helpers (React-free)
// ---------------------------------------------------------------------------

function messageOf(error) {
  if (!error) return 'Unknown error'
  return typeof error.message === 'string' && error.message ? error.message : String(error)
}

function baseUrl() {
  if (typeof document !== 'undefined' && document && document.baseURI) return document.baseURI
  if (typeof window !== 'undefined' && window && window.location) return window.location.href
  return 'http://dsh.invalid/'
}

function routeUrl(suffix, query) {
  try {
    const url = new URL(suffix, baseUrl())
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
    }
    return url.href
  } catch {
    return `/${suffix}`
  }
}

/** Query and POST the per-conversation tool gate. */
async function capabilityRequest(method, sessionId, enabled) {
  const url = routeUrl(CAPABILITY_SUFFIX, { sessionId })
  const options = { method, credentials: 'same-origin', cache: 'no-store', headers: {} }
  if (method === 'POST') {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify({ sessionId, enabled })
  }
  const response = await fetch(url, options)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const hostReason = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : ''
  if (!response.ok) throw new Error(hostReason || `HTTP ${response.status} ${response.statusText}`)
  if (!payload || payload.ok !== true) throw new Error(hostReason || 'The capability route rejected the request.')
  const value = payload.value && typeof payload.value === 'object' ? payload.value : {}
  // Defensive: accept both the {ok,value:{enabled}} envelope and a bare {enabled}.
  return { enabled: value.enabled === true || payload.enabled === true }
}

/**
 * Read the `{ok,value}` envelope of the computer-use status route, or write a
 * pause/resume action to it when `body` is given. The route belongs to this
 * plugin's Host half; callers swallow failures because the status bar is
 * optional and must degrade quietly.
 */
async function computerUseStatus(body) {
  const options = {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {},
  }
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(routeUrl(STATUS_SUFFIX), options)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const hostReason = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : ''
  if (!response.ok) throw new Error(hostReason || `HTTP ${response.status} ${response.statusText}`)
  if (!payload || payload.ok !== true) throw new Error(hostReason || 'The computer-use route rejected the request.')
  return payload.value
}

function shotUrl(file) {
  return routeUrl(SHOT_SUFFIX, { file })
}

function flattenContentText(block) {
  const parts = []
  if (Array.isArray(block && block.content)) {
    for (const part of block.content) {
      if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('\n')
}

/** Basename of the screenshot path a tool result reported. */
function shotFileName(meta, text) {
  const source = meta && typeof meta.path === 'string' && meta.path ? meta.path : null
  const match = source ? null : /saved to (.+?) \(/.exec(text)
  const path = source ?? (match ? match[1] : '')
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/** Short badge text for an observation token (`obs_3f9a2c1d4e5b` → `1d4e5b`). */
function shortObservationToken(meta) {
  const full =
    meta && typeof meta.state_id === 'string'
      ? meta.state_id
      : meta && meta.observation && typeof meta.observation.state_id === 'string'
        ? meta.observation.state_id
        : ''
  const token = full.trim()
  if (!token) return ''
  const bare = token.startsWith('obs_') ? token.slice(4) : token
  return bare.length > 6 ? bare.slice(-6) : bare
}

/** Wire names of the desktop-operation tools owned by dsh-computer-use. */
function desktopOpKind(name) {
  if (name === SHOT_TOOL) return 'shot'
  // `computer` is the current single input tool; `computer_input` stays for
  // rendering records from older sessions.
  if (INPUT_TOOLS.includes(name)) return 'input'
  return null
}

function clockOf(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return ''
  try {
    return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Plugin factory: everything below needs React.createElement
// ---------------------------------------------------------------------------

function createPlugin(React) {
  const h = React.createElement

  // -------------------------------------------------------------------------
  // Primitive controls
  // -------------------------------------------------------------------------

  function Btn({ variant, className, disabled, onClick, children, title }) {
    return h(
      'button',
      {
        type: 'button',
        className: cx('msm-btn', variant ? `msm-btn-${variant}` : null, className),
        disabled,
        onClick,
        title,
      },
      children,
    )
  }

  function Switch({ checked, disabled, label, onToggle }) {
    return h(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title: label,
        className: 'msm-switch',
        disabled,
        onClick: onToggle,
      },
      h('span', { className: 'msm-switch-knob' }),
    )
  }

  // -------------------------------------------------------------------------
  // Per-conversation capability switch (new in 1.5.0)
  // -------------------------------------------------------------------------

  /**
   * One-line switch above the trace. Off by default: the Host route reports the
   * stored flag, and flipping it writes `~/.dsh/capability-toggles.json` through
   * the Host half, which the tools' `when` predicate reads on the next step.
   * A failed poll degrades to a readable error line instead of hiding the tab.
   */
  function CapabilityBar({ t, sessionId }) {
    const [state, setState] = React.useState({ status: 'loading', enabled: false, error: '' })
    const [busy, setBusy] = React.useState(false)
    const alive = React.useRef(true)
    const load = React.useCallback(async () => {
      if (!sessionId) return
      try {
        const value = await capabilityRequest('GET', sessionId)
        if (alive.current) setState({ status: 'ready', enabled: value.enabled, error: '' })
      } catch (error) {
        if (alive.current) setState((current) => ({ status: 'error', enabled: current.enabled, error: messageOf(error) }))
      }
    }, [sessionId])
    React.useEffect(() => {
      alive.current = true
      if (!sessionId) {
        setState({ status: 'error', enabled: false, error: t('capNoSession') })
        return () => {
          alive.current = false
        }
      }
      void load()
      // The composer's 能力 control writes the same store, so follow it.
      const timer = setInterval(() => void load(), 10000)
      return () => {
        alive.current = false
        clearInterval(timer)
      }
    }, [load, sessionId, t])

    const toggle = async () => {
      const next = !state.enabled
      setBusy(true)
      setState((current) => ({ ...current, error: '' }))
      try {
        const value = await capabilityRequest('POST', sessionId, next)
        if (alive.current) setState({ status: 'ready', enabled: value.enabled, error: '' })
      } catch (error) {
        if (alive.current) {
          setState((current) => ({ ...current, status: 'error', error: t('capSaveFailed', { message: messageOf(error) }) }))
        }
      } finally {
        if (alive.current) setBusy(false)
      }
    }

    const enabled = state.enabled === true
    const title = state.status === 'loading' ? t('capLoading') : enabled ? t('capOnTitle') : t('capOffTitle')
    const hint = enabled ? t('capOnHint') : t('capOffHint')
    return h(
      'div',
      { className: 'cu-cap', 'data-enabled': enabled ? 'true' : 'false', 'data-status': state.status },
      h(
        'div',
        { className: 'cu-cap-text' },
        h('p', { className: 'cu-cap-title' }, title),
        state.status === 'error' && state.error
          ? h('p', { className: 'cu-cap-error', role: 'status' }, state.error)
          : h('p', { className: 'cu-cap-hint' }, hint),
      ),
      h(
        'div',
        { className: 'cu-cap-switch' },
        busy ? h('span', { className: 'cu-cap-saving' }, t('capSaving')) : null,
        h(Switch, {
          checked: enabled,
          disabled: busy || !sessionId,
          label: enabled ? t('capDisable') : t('capEnable'),
          onToggle: () => void toggle(),
        }),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Tool cards (migrated from @local/dsh-session-capabilities)
  // -------------------------------------------------------------------------

  function ScreenshotToolView({ t, phase, block }) {
    const [expanded, setExpanded] = React.useState(false)
    const done = phase === 'result'
    const meta = done && block && typeof block === 'object' ? block.meta : undefined
    const text = done ? flattenContentText(block) : ''
    const file = shotFileName(meta, text)
    const token = done ? shortObservationToken(meta) : ''
    const summary = done
      ? meta && meta.foreground && meta.foreground.title
        ? `"${meta.foreground.title}"`
        : ''
      : t('running')
    return h(
      'div',
      { className: 'msm-tool-card' },
      h(
        'div',
        { className: 'msm-tool-head' },
        h('span', { className: 'msm-tool-title' }, t('desktopScreenshot')),
        token ? h('span', { className: 'msm-tool-token', title: t('cuObservation') }, `${t('cuObservation')} ${token}`) : null,
        h('span', { className: 'msm-tool-sub' }, summary),
        file
          ? h(
              'button',
              { type: 'button', className: 'msm-tool-link', onClick: () => setExpanded((value) => !value) },
              expanded ? t('shrink') : t('enlarge'),
            )
          : null,
      ),
      file
        ? h('img', {
            className: cx('msm-tool-shot', expanded ? 'is-expanded' : null),
            src: shotUrl(file),
            alt: t('desktopScreenshot'),
            loading: 'lazy',
            onClick: () => setExpanded((value) => !value),
          })
        : done
          ? h('p', { className: 'msm-tool-meta' }, text || t('running'))
          : null,
      meta
        ? h(
            'p',
            { className: 'msm-tool-meta' },
            `${meta.width ?? '?'}×${meta.height ?? '?'}` +
              (meta.cursor ? ` · cursor ${meta.cursor.x},${meta.cursor.y}` : '') +
              (meta.foreground && meta.foreground.title ? ` · ${meta.foreground.title}` : ''),
          )
        : null,
    )
  }

  function boolText(value) {
    return typeof value === 'boolean' ? String(value) : '?'
  }

  /** Compact one-line summary of an inputcheck result. */
  function inputCheckSummary(check) {
    const landed =
      check && check.landed && typeof check.landed === 'object' ? check.landed.confirmed : check && check.landed
    const brake = check && check.brake && typeof check.brake === 'object' ? check.brake.registered : check && check.brake
    return [
      `locked ${boolText(check && check.locked)}`,
      `landed ${boolText(landed)}`,
      `drift ${boolText(check && check.pointerDrifting)}`,
      `brake ${boolText(brake)}`,
    ].join(' · ')
  }

  function InputToolView({ t, phase, block }) {
    const done = phase === 'result'
    const meta = done && block && typeof block === 'object' ? block.meta : undefined
    const text = done ? flattenContentText(block) : ''
    const action = meta && meta.action ? String(meta.action) : ''
    const refused = done && meta !== undefined && meta !== null && meta.ok === false
    const detail = meta && meta.detail ? String(meta.detail) : done ? (text.split('\n')[0] ?? '') : t('running')
    const intent = meta && typeof meta.intent === 'string' ? meta.intent : ''
    const steps = meta && Array.isArray(meta.steps) ? meta.steps : null
    const check = meta && meta.check && typeof meta.check === 'object' ? meta.check : null
    const code = refused && meta && typeof meta.code === 'string' ? meta.code : ''
    const message = refused && meta && typeof meta.message === 'string' ? meta.message : ''
    const guidance = refused && meta && typeof meta.guidance === 'string' ? meta.guidance : ''
    return h(
      'div',
      {
        className: 'msm-tool-card',
        'data-refused': refused ? 'true' : undefined,
      },
      h(
        'div',
        { className: 'msm-tool-head' },
        h('span', { className: 'msm-tool-title' }, t('desktopAction')),
        action ? h('span', { className: 'msm-tool-chip' }, action) : null,
        refused ? h('span', { className: 'msm-badge msm-tool-badge-refused' }, t('cuRefused')) : null,
        code ? h('span', { className: 'msm-tool-code' }, code) : null,
        refused ? null : h('span', { className: 'msm-tool-sub' }, detail),
      ),
      refused && message ? h('p', { className: 'msm-tool-error' }, message) : null,
      refused && guidance ? h('p', { className: 'msm-tool-meta' }, guidance) : null,
      !refused && intent ? h('p', { className: 'msm-tool-meta' }, `${t('cuIntent')}: ${intent}`) : null,
      !refused && steps !== null ? h('p', { className: 'msm-tool-meta' }, t('cuSteps', { n: steps.length })) : null,
      !refused && check ? h('p', { className: 'msm-tool-check' }, `${t('cuInputCheck')} · ${inputCheckSummary(check)}`) : null,
    )
  }

  // -------------------------------------------------------------------------
  // Desktop activity (independent Conversation tab)
  // -------------------------------------------------------------------------

  /**
   * Fallback selector hook for profiles where the Trajectory view does not
   * provide its `useTrajectory` standard hook.
   */
  function useNoTrajectory() {
    return null
  }

  /**
   * Project the shared Trajectory snapshot into desktop records. Tool results
   * carry the presentation metadata written by dsh-computer-use, and the
   * Trajectory event locations give each record its round.
   */
  function collectDesktopOps(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.eventNodes)) return []
    const locations = snapshot.eventLocations
    const ops = []
    let fallbackTurn = 0
    for (const node of snapshot.eventNodes) {
      if (node.kind === 'assistant' && typeof node.turn === 'number') fallbackTurn = node.turn
      else if (node.kind === 'turn-end' && typeof node.turn === 'number') fallbackTurn = node.turn
      if (node.kind !== 'tool-result') continue
      const kind = desktopOpKind(node.name)
      if (!kind) continue
      let turn = fallbackTurn
      if (locations && typeof locations.get === 'function') {
        const location = locations.get(node.seq)
        if (location && (location.kind === 'step' || location.kind === 'turn') && location.turn) {
          turn = location.turn.turn
        }
      }
      const meta = node.meta && typeof node.meta === 'object' ? node.meta : null
      const text = flattenContentText(node)
      ops.push({
        id: `op-${node.seq}`,
        kind,
        seq: node.seq,
        time: node.time,
        turn: typeof turn === 'number' ? turn : 0,
        file: kind === 'shot' ? shotFileName(meta, text) : '',
        meta,
        text,
        isError: node.isError === true,
        running: false,
      })
    }
    for (const call of Array.isArray(snapshot.runningCalls) ? snapshot.runningCalls : []) {
      const kind = desktopOpKind(call.name)
      if (!kind || call.phase !== 'start') continue
      ops.push({
        id: `running-${call.callId}`,
        kind,
        seq: Number.MAX_SAFE_INTEGER,
        time: call.time,
        turn: typeof call.turn === 'number' ? call.turn : fallbackTurn,
        file: '',
        meta: null,
        text: '',
        isError: false,
        running: true,
      })
    }
    ops.sort((left, right) => left.seq - right.seq)
    // Attach the screenshot each click-like record was performed against, so
    // the review surface can box the click position on that image.
    const lastShotByTurn = new Map()
    let lastShot = null
    for (const op of ops) {
      if (op.kind === 'shot') {
        if (op.file) {
          lastShot = op
          lastShotByTurn.set(op.turn, op)
        }
        continue
      }
      const action = op.meta && op.meta.action
      if (action !== 'click' && action !== 'double_click' && action !== 'right_click' && action !== 'drag') continue
      const anchor = lastShotByTurn.get(op.turn) ?? lastShot
      if (anchor === undefined) continue
      const width = Number(anchor.meta && anchor.meta.width)
      const height = Number(anchor.meta && anchor.meta.height)
      if (!(width > 0) || !(height > 0)) continue
      op.anchor = { file: anchor.file, width, height, time: anchor.time }
    }
    return ops
  }

  function groupDesktopOps(ops) {
    const groups = new Map()
    for (const op of ops) {
      const key = typeof op.turn === 'number' && op.turn > 0 ? op.turn : 0
      const list = groups.get(key)
      if (list === undefined) groups.set(key, [op])
      else list.push(op)
    }
    return [...groups.entries()]
      .map(([turn, list]) => ({ turn, ops: list }))
      .sort((left, right) => right.turn - left.turn)
  }

  function DesktopOpRow({ t, op, zoomed, onZoom }) {
    const notes = []
    if (op.meta) {
      if (op.kind === 'shot') {
        if (op.meta.width || op.meta.height) notes.push(`${op.meta.width ?? '?'}×${op.meta.height ?? '?'}`)
        if (op.meta.cursor) notes.push(`cursor ${op.meta.cursor.x},${op.meta.cursor.y}`)
        if (op.meta.foreground && op.meta.foreground.title) notes.push(op.meta.foreground.title)
      } else {
        if (op.meta.x !== null && op.meta.x !== undefined) notes.push(`${op.meta.x},${op.meta.y}`)
        if (op.meta.foreground && op.meta.foreground.title) notes.push(op.meta.foreground.title)
      }
    }
    const summary = op.kind === 'input' ? (op.meta && op.meta.detail) || op.text.split('\n')[0] || '' : ''
    // Draw a click record's position on the screenshot the agent acted on.
    let marker = null
    if (op.kind === 'input' && op.anchor && op.meta && typeof op.meta.x === 'number' && typeof op.meta.y === 'number') {
      const positive = (value) => Math.max(0, Math.min(100, value))
      const left = positive((op.meta.x / op.anchor.width) * 100)
      const top = positive((op.meta.y / op.anchor.height) * 100)
      const dragging =
        op.meta.action === 'drag' && typeof op.meta.toX === 'number' && typeof op.meta.toY === 'number'
      const boxLeft = dragging ? positive((Math.min(op.meta.x, op.meta.toX) / op.anchor.width) * 100) : left
      const boxTop = dragging ? positive((Math.min(op.meta.y, op.meta.toY) / op.anchor.height) * 100) : top
      const boxWidth = dragging ? positive((Math.abs(op.meta.toX - op.meta.x) / op.anchor.width) * 100) : 0
      const boxHeight = dragging ? positive((Math.abs(op.meta.toY - op.meta.y) / op.anchor.height) * 100) : 0
      marker = h(
        'div',
        { className: 'msm-cu-mark' },
        h('img', {
          className: 'msm-cu-mark-img',
          src: shotUrl(op.anchor.file),
          alt: t('desktopScreenshot'),
          loading: 'lazy',
        }),
        dragging
          ? h('span', {
              className: 'msm-cu-mark-drag',
              style: { left: `${boxLeft}%`, top: `${boxTop}%`, width: `${boxWidth}%`, height: `${boxHeight}%` },
            })
          : h('span', { className: 'msm-cu-mark-box', style: { left: `${left}%`, top: `${top}%` } }),
      )
    }
    return h(
      'div',
      { className: 'msm-cu-op', 'data-state': op.running ? 'running' : 'settled' },
      h(
        'div',
        { className: 'msm-cu-op-main' },
        h(
          'div',
          { className: 'msm-cu-op-head' },
          h('span', { className: 'msm-cu-op-kind' }, op.kind === 'shot' ? t('desktopScreenshot') : t('desktopAction')),
          op.kind === 'input' && op.meta && op.meta.action ? h('span', { className: 'msm-tool-chip' }, op.meta.action) : null,
          op.running ? h('span', { className: 'msm-badge', 'data-on': 'true' }, t('running')) : null,
          op.isError ? h('span', { className: 'msm-cu-op-time msm-cu-error' }, t('opsFailed')) : null,
          h('span', { className: 'msm-cu-op-time' }, clockOf(op.time)),
        ),
        op.kind === 'shot'
          ? op.file
            ? h('img', {
                className: cx('msm-cu-shot', zoomed ? 'is-large' : null),
                src: shotUrl(op.file),
                alt: t('desktopScreenshot'),
                loading: 'lazy',
                onClick: () => onZoom(),
              })
            : h('p', { className: 'msm-cu-op-text' }, op.text || t('running'))
          : h('p', { className: 'msm-cu-op-text' }, summary || t('running')),
        marker,
        marker ? h('p', { className: 'msm-cu-op-note' }, t('tapMark', { time: clockOf(op.anchor.time) })) : null,
        notes.length > 0 ? h('p', { className: 'msm-cu-op-note' }, notes.join(' · ')) : null,
      ),
    )
  }

  /**
   * Independent Conversation View tab that replays every desktop operation of
   * the current Session, grouped by round, without opening the chat detail. The
   * per-conversation switch is the first row of the tab.
   */
  function DesktopTraceView({ useTrajectory, t, sessionId }) {
    const useSnapshot = typeof useTrajectory === 'function' ? useTrajectory : useNoTrajectory
    const snapshot = useSnapshot((value) => value)
    const [filter, setFilter] = React.useState('all')
    const [overrides, setOverrides] = React.useState(() => new Map())
    const [zoomed, setZoomed] = React.useState(null)
    const rootRef = React.useRef(null)

    // Live pause/brake/audit state of the Host computer-use provider. The route
    // can be absent (older Host half), so failures quietly degrade to "no
    // status bar" instead of breaking this tab.
    const [cuState, setCuState] = React.useState({ value: null, stale: false })
    const [cuBusy, setCuBusy] = React.useState(false)
    const cuAlive = React.useRef(true)
    const loadCuStatus = React.useCallback(async () => {
      try {
        const value = await computerUseStatus()
        if (cuAlive.current) setCuState({ value, stale: false })
      } catch {
        // Keep the last known state on a transient poll failure, but never
        // resurrect a status bar that was never available.
        if (cuAlive.current) setCuState((current) => (current.value === null ? current : { value: current.value, stale: true }))
      }
    }, [])
    React.useEffect(() => {
      cuAlive.current = true
      void loadCuStatus()
      const timer = setInterval(() => void loadCuStatus(), 10000)
      return () => {
        cuAlive.current = false
        clearInterval(timer)
      }
    }, [loadCuStatus])
    const togglePause = async () => {
      const paused = !!(cuState.value && cuState.value.paused === true)
      setCuBusy(true)
      try {
        await computerUseStatus({ action: paused ? 'resume' : 'pause' })
      } catch {
        if (cuAlive.current) setCuState((current) => (current.value === null ? current : { value: current.value, stale: true }))
      } finally {
        if (cuAlive.current) setCuBusy(false)
      }
      // Follow the Host's authoritative state after the toggle.
      await loadCuStatus()
    }

    // The shell reuses one scrollport across Views and leaves the previous
    // View's offset in place, so a freshly selected trace tab can open in the
    // middle of the history. Start at the header, and keep the sticky header
    // reachable even if the shell re-applies an offset right after mount.
    React.useEffect(() => {
      const root = rootRef.current
      if (root === null) return undefined
      const reset = () => {
        root.scrollTop = 0
        let node = root.parentElement
        while (node !== null) {
          const style = window.getComputedStyle(node)
          if (/(auto|scroll)/.test(style.overflowY)) node.scrollTop = 0
          node = node.parentElement
        }
      }
      reset()
      const frame = requestAnimationFrame(reset)
      const timer = setTimeout(reset, 120)
      return () => {
        cancelAnimationFrame(frame)
        clearTimeout(timer)
      }
    }, [])

    const groups = React.useMemo(() => groupDesktopOps(collectDesktopOps(snapshot)), [snapshot])
    const latestTurn = groups.length > 0 ? groups[0].turn : null
    const total = groups.reduce((sum, group) => sum + group.ops.length, 0)
    const visibleGroups = React.useMemo(() => {
      if (filter === 'all') return groups
      return groups
        .map((group) => ({
          turn: group.turn,
          ops: group.ops.filter((op) => {
            if (filter === 'shots') return op.kind === 'shot'
            if (filter === 'inputs') return op.kind === 'input'
            if (filter === 'round') return group.turn === latestTurn
            return true
          }),
        }))
        .filter((group) => group.ops.length > 0)
    }, [groups, filter, latestTurn])
    const expandedOf = (turn) =>
      overrides.has(turn) ? overrides.get(turn) : turn === latestTurn || groups.length === 1
    const toggleRound = (turn) => {
      setOverrides((current) => {
        const next = new Map(current)
        next.set(turn, !expandedOf(turn))
        return next
      })
    }
    const toggleZoom = (opId) => setZoomed((current) => (current === opId ? null : opId))

    const cuValue = cuState.value
    const cuPaused = !!(cuValue && cuValue.paused === true)
    const cuBrake = cuValue && cuValue.brake && typeof cuValue.brake === 'object' ? cuValue.brake : null
    const cuBrakeItem = cuBrake
      ? cuBrake.registered === true
        ? `${t('cuBrake')} ${typeof cuBrake.combination === 'string' && cuBrake.combination ? cuBrake.combination : ''}`.trim()
        : t('cuBrakeUnavailable')
      : t('cuBrakeUnavailable')
    const cuAudit = cuValue && cuValue.audit && typeof cuValue.audit === 'object' ? cuValue.audit : null
    const cuAuditItem = cuAudit ? `${t('cuAudit')} ${cuAudit.actions ?? 0} · ${cuAudit.refusals ?? 0}` : ''

    if (typeof useTrajectory !== 'function') {
      return h(
        'div',
        { className: 'msm-cu' },
        h(
          'div',
          { className: 'msm-cu-inner' },
          h(CapabilityBar, { t, sessionId }),
          h('h2', { className: 'msm-cu-title' }, t('desktopTraceTitle')),
          h(
            'div',
            { className: 'msm-empty' },
            h('p', { className: 'msm-empty-title' }, t('opsNoHookTitle')),
            h('p', { className: 'msm-empty-text' }, t('opsNoHookHint')),
          ),
        ),
      )
    }

    const filters = [
      ['all', t('desktopFilterAll')],
      ['round', t('desktopFilterRound')],
      ['shots', t('desktopFilterShots')],
      ['inputs', t('desktopFilterInputs')],
    ]

    return h(
      'div',
      { className: 'msm-cu', ref: rootRef },
      h(
        'div',
        { className: 'msm-cu-inner' },
        // The switch sits above the sticky header so it never scrolls away.
        h(CapabilityBar, { t, sessionId }),
        h(
          'div',
          { className: 'msm-cu-head' },
          h(
            'div',
            { className: 'msm-cu-heading' },
            h('h2', { className: 'msm-cu-title' }, t('desktopTraceTitle')),
            h('p', { className: 'msm-cu-hint' }, t('desktopTraceHint')),
            cuValue
              ? h(
                  'div',
                  {
                    className: 'msm-cu-status',
                    'data-paused': cuPaused ? 'true' : 'false',
                    'data-stale': cuState.stale ? 'true' : undefined,
                    title: cuState.stale ? t('cuStatusOffline') : undefined,
                  },
                  h(
                    'span',
                    { className: 'msm-cu-status-item' },
                    h('span', { className: 'msm-cu-status-dot', 'data-paused': cuPaused ? 'true' : 'false' }),
                    cuPaused ? t('cuPaused') : t('cuRunning'),
                  ),
                  h('span', { className: 'msm-cu-status-item' }, cuBrakeItem),
                  cuAuditItem ? h('span', { className: 'msm-cu-status-item' }, cuAuditItem) : null,
                  h(Btn, { variant: 'secondary', disabled: cuBusy, onClick: togglePause }, cuPaused ? t('cuResume') : t('cuPause')),
                )
              : null,
          ),
          h(
            'div',
            { className: 'msm-cu-filters', role: 'group' },
            filters.map(([value, label]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'msm-cu-filter',
                  'aria-pressed': filter === value ? 'true' : 'false',
                  onClick: () => setFilter(value),
                },
                label,
              ),
            ),
          ),
        ),
        total > 0 ? h('p', { className: 'msm-cu-summary' }, t('opsSummary', { n: total, m: groups.length })) : null,
        total === 0
          ? h(
              'div',
              { className: 'msm-empty' },
              h('p', { className: 'msm-empty-title' }, t('opsEmptyTitle')),
              h('p', { className: 'msm-empty-text' }, t('opsEmptyHint')),
            )
          : visibleGroups.length === 0
            ? h('p', { className: 'msm-cu-summary' }, t('desktopNoMatch'))
            : visibleGroups.map((group) => {
                const expanded = expandedOf(group.turn)
                return h(
                  'section',
                  { key: `turn-${group.turn}`, className: 'msm-cu-round' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'msm-cu-round-head',
                      'aria-expanded': expanded ? 'true' : 'false',
                      onClick: () => toggleRound(group.turn),
                    },
                    h('span', { className: 'msm-cu-round-title' }, group.turn > 0 ? t('roundTitle', { n: group.turn }) : t('roundOther')),
                    h('span', { className: 'msm-cu-round-meta' }, `${expanded ? '▾' : '▸'} ${t('opsCount', { n: group.ops.length })}`),
                  ),
                  expanded
                    ? h(
                        'div',
                        { className: 'msm-cu-round-body' },
                        group.ops.map((op) =>
                          h(DesktopOpRow, {
                            key: op.id,
                            t,
                            op,
                            zoomed: zoomed === op.id,
                            onZoom: () => toggleZoom(op.id),
                          }),
                        ),
                      )
                    : null,
                )
              }),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Styles: only the rules these surfaces actually use, migrated from
  // @local/dsh-session-capabilities, plus the switch bar added in 1.5.0.
  // -------------------------------------------------------------------------

  const CSS = `
.msm-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;padding:6px 12px}
.msm-btn:disabled{opacity:.55;cursor:default}
.msm-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.msm-btn-secondary{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.msm-btn-ghost{color:var(--dsw-alias-label-secondary)}
.msm-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent)}
.msm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.msm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-switch{position:relative;width:34px;height:20px;flex:none;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.msm-switch:disabled{opacity:.55;cursor:default}
.msm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.msm-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:var(--dsw-alias-bg-base);transition:transform .15s ease}
.msm-switch[aria-checked="true"] .msm-switch-knob{transform:translateX(14px)}
.msm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.msm-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center}
.msm-empty-title{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.msm-empty-text{margin:0;max-width:520px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-badge{border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;padding:0 5px}
.msm-badge[data-on="true"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.msm-tool-card{margin:2px 0;max-width:640px;display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.msm-tool-row{flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap}
.msm-tool-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msm-tool-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.msm-tool-chip{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.msm-tool-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-tool-link{margin-left:auto;padding:2px 4px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:11px;cursor:pointer}
.msm-tool-shot{display:block;max-width:100%;max-height:260px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);object-fit:contain;cursor:zoom-in}
.msm-tool-shot.is-expanded{max-height:none;cursor:zoom-out}
.msm-tool-meta{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-tool-card[data-refused="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.msm-tool-badge-refused{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.msm-tool-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;padding:0 5px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:4px;color:var(--dsw-alias-state-error-primary);white-space:nowrap}
.msm-tool-token{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.msm-tool-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.msm-tool-check{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-cu{box-sizing:border-box;padding:0 clamp(16px,3vw,32px) 200px}
.msm-cu-inner{display:flex;flex-direction:column;gap:12px;max-width:960px;margin:0 auto;padding-top:8px}
.msm-cu .msm-empty{margin:12px 0 0}
.msm-cu-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;background:var(--dsw-alias-bg-base);padding:16px 0 10px}
.msm-cu-heading{min-width:0}
.msm-cu-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.msm-cu-hint{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-cu-filters{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.msm-cu-filter{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:16px;padding:5px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
.msm-cu-filter:hover{color:var(--dsw-alias-label-primary)}
.msm-cu-filter[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.msm-cu-filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-cu-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-cu-round{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.msm-cu-round-head{display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.msm-cu-round-head:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent)}
.msm-cu-round-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.msm-cu-round-title{font-weight:600}
.msm-cu-round-meta{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.msm-cu-round-body{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-cu-op{display:flex;gap:12px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-cu-op:first-child{border-top:0}
.msm-cu-op[data-state="running"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.msm-cu-op-main{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
.msm-cu-op-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msm-cu-op-kind{font-size:12px;font-weight:600}
.msm-cu-op-time{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.msm-cu-op-text{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.msm-cu-op-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-cu-shot{display:block;max-width:min(100%,520px);max-height:220px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);object-fit:contain;cursor:zoom-in}
.msm-cu-shot.is-large{max-height:none;max-width:100%;cursor:zoom-out}
.msm-cu-mark{position:relative;display:block;width:min(100%,520px);margin-top:2px}
.msm-cu-mark-img{display:block;width:100%;height:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.msm-cu-mark-box{position:absolute;width:26px;height:26px;transform:translate(-50%,-50%);border:2px solid #e5484d;border-radius:5px;box-shadow:0 0 0 1px rgb(255 255 255 / 85%);pointer-events:none}
.msm-cu-mark-box::after{content:'';position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 1px rgb(255 255 255 / 90%)}
.msm-cu-mark-drag{position:absolute;border:2px dashed #e5484d;border-radius:5px;background:rgb(229 72 77 / 12%);pointer-events:none}
.msm-cu-error{color:var(--dsw-alias-state-error-primary)}
.msm-cu-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-cu-status[data-stale="true"]{opacity:.6}
.msm-cu-status-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.msm-cu-status-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-state-success-primary)}
.msm-cu-status-dot[data-paused="true"]{background:var(--dsw-alias-state-warn-primary)}
.cu-cap{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.cu-cap[data-enabled="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.cu-cap-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.cu-cap-title{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.cu-cap-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.cu-cap-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.cu-cap-switch{display:inline-flex;align-items:center;gap:8px;flex:none}
.cu-cap-saving{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
`

  // -------------------------------------------------------------------------
  // Plugin face
  // -------------------------------------------------------------------------

  return {
    name: 'computer-use',
    inject: ['slots', 'locale'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'computer-use: dictionaries')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-computer-use'
        tag.dataset.pluginCss = 'dsh-computer-use/client.css'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'computer-use: view styles')

      const t = ctx.locale.bind(NS)

      // Chat cards for the desktop tools, so screenshots stay reviewable in the
      // conversation history (`computer_input` only renders old records).
      ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register({ name: 'tool.call.toolview', key: SHOT_TOOL, locale: NS }, ScreenshotToolView)
        for (const key of INPUT_TOOLS) {
          yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, InputToolView)
        }
      })

      // The desktop activity tab. `inject` hands the view this Session's id,
      // which the per-conversation switch needs for its Host route.
      ctx.slots.inject('conversation.view', function* () {
        yield ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'computer-use',
            order: 20,
            locale: NS,
            label: () => t('desktopView'),
            inject: (sessionId) => ({ sessionId }),
          },
          DesktopTraceView,
        )
      })
    },
  }
}

/**
 * The module face. The generated Web bundle swaps this line for
 * `const __entry = face` and wraps the file in the loader factory, so the file
 * stays a single source of truth for both consumers.
 */
const face = {
  name: 'computer-use',
  inject: ['slots', 'locale'],
  apply(ctx) {
    if (ReactImpl === null) {
      throw new Error('dsh-computer-use: React was not provided; load the generated client.web.js bundle, not client.js directly')
    }
    return createPlugin(ReactImpl).apply(ctx)
  },
}

export default face

# dsh-computer-use — 后端契约与移植说明

Linux/X11 后端已经在 `linux-x11.mjs` + `linux-adapter.mjs` 里实现并**接入 `index.js`**
（1.1.x；Windows 分支行为不变）。本文档固定两件事：① 工具层可见的坐标/屏幕契约；
② `index.js` 与后端之间的接口，供后续抽 `backends/win32.js` 时逐条对齐。

## 1. 工具层契约（模型可见）

### 1.1 屏幕选择

- `computer_screenshot` 的可选参数 `screen` 接受：`"auto"`、`"cursor"`、显示器 id
  （`"HDMI-1-0"`）或 index（`"1"`）。
- **省略 / `"auto"` → 主屏**（`xrandr --listmonitors` 中带 `*` 的那块；没有主屏时取面积最大的屏）。
  `auto` 故意不跟随指针，保证连续截图落在同一块屏上。
- `"cursor"` → 指针所在屏；指针不在任何屏内时回退到主屏/最大屏。
- **布局每次调用现查**（`xrandr --listmonitors` + `xrandr --query`），支持热插拔与旋转，
  不存在缓存；屏幕对象在几何之外附带 `dpi`（按实际旋转方向算）与非 normal 时的 `rotation`。
- 未知 id 的报错会列出当前检测到的全部显示器（id、分辨率、原点），便于换名重试。
- 返回结果始终包含：
  - `screen`：本次截图的那一块（id / index / primary / x / y / width / height，另有 dpi/rotation 时附带）
  - `screens`：当前全部显示器清单（同一形状）
- **一次截图只截一块屏，绝不截整个根窗口。**
- **Windows（1.6.0 起）**：`screen` 语义为“省略/`auto` → 主屏；`"all"` → 整个虚拟桌面；
  其他 → 显示器 id（`DISPLAY1`，可省略 `\\\\.\\` 前缀）或 index”。显示器用 WinForms
  `Screen.AllScreens` 枚举，支持负原点；`region` 也是**显示器局部**坐标，`scale` 在
  PowerShell 侧缩小图片。注意 Windows 的动作坐标见 §1.2。

### 1.2 坐标

- **Linux/X11**：`computer` 的所有坐标（x / y / toX / toY）都是**当前观察屏的局部像素坐标**：
  - 全局 X = `screen.x + x`
  - 全局 Y = `screen.y + y`
- **Windows（1.6.0 起）**：动作坐标仍是**桌面全局坐标**（Win32 `SendInput` 语义），截图的
  `originX/originY` 用于把“图上位置”换算成全局坐标，即“全局 = origin + 图上位置”。
  工具描述里已分别写清楚；两边语义不同是有意的（暂未改动 Windows 输入路径）。
- 模型只需按截图上的像素算，不需要知道偏移。
- 后端负责加偏移后注入，并**读回校验**。

### 1.3 换屏必须重新截图

动作的屏幕**只能等于** observation token 里记录的屏幕：
- 不一致 → 拒绝，报 `stale_observation`（附带"请先对目标屏截图"的 guidance）
- 想操作另一块屏 → 必须先 `computer_screenshot {screen: "..."}` 再动作

`wait` / `pause` 与屏幕无关；`sequence` 的每一步继承 token 的屏幕。

### 1.4 observation token

截图时绑定并返回：

| 字段 | 含义 |
|---|---|
| `screen` | 观察屏 |
| `foreground.handle` | 前台窗口 id（X11 window id） |
| `foreground.title` / `process` / `classes` | 前台窗口身份 |
| `foreground.rect` | `x,y,w,h`（全局坐标） |
| `foreground.onThisScreen` | 窗口是否在观察屏上 |
| `fingerprint` | 窗口矩形 ∩ 观察屏 的 8×8 像素采样（64×6 hex）；窗口完全不在观察屏上时为空串 |
| `cursor` | 屏局部坐标（工具层可见；全局坐标只有后端内部用） |

动作下发前重新采样一次：窗口句柄变了、窗口边界变了、观察屏布局变了，或指纹变化超过阈值
（单像素通道差 > 40 的采样点计数 > 8），即判 `stale_observation`。指纹为空（窗口不在
观察屏上）时只校验句柄/边界/布局——与 Windows 侧"窗口不在虚拟桌面内则跳过像素校验"
保持一致，这是已知的弱化点，见 §4 未完成项。

## 2. 后端接口（`index.js` ↔ backend）

```js
// 枚举（每次现查布局；--query 只用于物理尺寸/旋转提示，失败不影响几何）
listScreens(): Promise<Screen[]>
parseOutputFacts(xrandrQueryText): Map<outputId, OutputFacts>
enrichScreens(screens, outputFacts): Screen[]    // 合入 dpi / rotation
pickScreen(screens, idOrIndex?, { cursor }?): Screen   // 缺省主屏；支持 "auto" / "cursor"
layoutSignature(screens): string                 // 便于诊断/测试的布局指纹
screensPublicView(screens): Screen[]             // 去内部字段，保留 dpi/rotation

// 观察
observe(screens, screenId?, path): Promise<Observation>

// 输入
dispatch(screen, action, args): Promise<{ ok, detail?, code? }>
warpTo(screen, localX, localY): Promise<{ ok, globalX, globalY, attempts?, code? }>

// 自检（environment 含会话类型/桌面/依赖/安装提示/python 模块/布局+DPI）
inputCheck({ pausePath }): Promise<{ ok, problems[], screens, environment, ... }>
```

`action` 取值与现有工具一致：`move / click / double_click / right_click / drag / scroll / type / key`。
`wait / sequence / pause / inputcheck` 的流程控制留在 `index.js`（平台无关），
后端只负责"一个动作用哪块屏、落在哪个坐标"。

### 2.1 不变量（两端必须一致）

1. 一次动作只作用于一块屏，坐标是屏局部坐标。
2. 每次 warp 后读回指针；不匹配重试 3 次，仍不匹配返回 `pointer_warp_unstable`，**不盲点**。
3. 动作前重采样指纹 + 前台窗口，不匹配即 `stale_observation`。
4. 前台窗口是 DSH 自己时拒绝（X11 用 `WM_CLASS` / 标题匹配，Windows 沿用现有判定）；
   点击/拖拽/滚动落点还要用 `windowAtCursor()` 检查落点窗口，身份不可读时 **fail closed**
   （`window_unidentified`）。
5. `pause` 文件存在时拒绝一切输入（释放只由用户/UI 完成）。除了动作前的检查，
   注入点（`adapter.dispatch` 进入 `x11.dispatch` 之前）**必须再读一次** pause 文件，
   覆盖"审批弹窗/像素复核期间用户按下暂停"的窗口；`inputcheck` 在暂停时也不做指针探测。
6. 失败路径 `finally` 释放鼠标按键（`mouseup 1/2/3`），不留按下状态；拖拽结束要读回指针，
   没到目标点即 `drag_unstable`，不谎报成功。
7. 坐标必须落在观察屏内（`0 <= x < width`），越界在 `validate()` 阶段就 `invalid_args`，
   否则加偏移后会落到另一块屏上。
8. 观察屏的 id 与几何在每次证明时重新枚举：热插拔/改布局后即使窗口句柄与边界没变，
   也会以 `stale_observation (layout)` 拒绝。
9. 入口 fail closed：`XDG_SESSION_TYPE=wayland` 或 `DISPLAY` 为空时整个后端判为 unsupported，
   工具直接给出结构化拒绝，而不是让 scrot/xrandr 抛原始错误。

## 3. Linux / X11 依赖

| 用途 | 工具 |
|---|---|
| 显示器枚举 | `xrandr --listmonitors` |
| 单屏截图 | `scrot -a X,Y,W,H` |
| 前台窗口 | `xprop -root _NET_ACTIVE_WINDOW` + `xprop -id` + `xwininfo -id` |
| 输入注入 | `xdotool`（XTest） |
| 中文/非 ASCII 输入 | `xclip` + `xdotool key ctrl+v` |

纯 Node 侧：PNG 解码（`node:zlib`）与指纹采样，无第三方依赖。

- **不支持 Wayland**：没有全局输入注入、没有全局前台窗口；`XDG_SESSION_TYPE=wayland`
  时后端判为 unsupported（XWayland 也不够：只能驱动 XWayland 客户端）。
- **缺 `xclip`** 只影响非 ASCII 打字：`inputcheck` 把它列为 **warning**（`ok` 仍为 true），
  ASCII 输入走 `xdotool type` 正常。
- **负原点的显示器布局**：`scrot -a` 无法表达负坐标，改为截根窗口后在 Node 里裁剪/编码；
  根窗口覆盖不到该显示器时以明确错误拒绝。
- **X11 全局急停热键**：可选，依赖 `python3` + `Xlib`；启动 `backends/x11-hotkey.py`
  在 root 上 XGrabKey（含 Lock/NumLock 变体）。缺依赖时只保留 UI/`pause`。
- 指针探测/截图临时文件用随机名（`/tmp/dsh-cu-selfcheck-<pid>-<rand>.png`），避免并发互踩。

## 4. 实现状态

已完成（1.1.x / 1.2.0）：

1. ~~`backends/index.js`：按 `process.platform` 选后端~~ → `backends/index.mjs`
   （`selectBackend()`：`win32` → `windows-native`，`linux` → `linux-x11`，其他 → `unsupported`）。
2. ~~`index.js`：接屏幕契约~~ → Linux 分支已接：`computer_screenshot { screen }`、
   返回 `screen` / `screens`、动作坐标按 observation 的屏局部坐标注入、换屏报
   `stale_observation`（窗口/边界/像素三重校验）。
   **Windows 分支（1.6.0）**：截图/观察/显示器枚举已抽到 `backends/win32.mjs`，支持
   单屏 / `"all"` / `region` / `scale` 并返回 `screen`/`screens`；动作脚本（SendInput）、
   `inputcheck` 与急停脚本仍在 `index.js`，动作坐标保持桌面全局，尚未改成屏局部。
3. ~~`package.json` 的 `files` 白名单加入 `backends`~~（已加入）。
4. Linux 侧 dispatch 流程（`backends/linux-adapter.mjs`）：
   - `validate()`：与 Windows `actionScript`/`sequenceScript` 同规则的纯参数校验，
     非法调用在提交 token 之前被拒绝；
   - `prove()`：下发前重采样前台窗口句柄 + 边界 + 指纹（只截窗口矩形，~200ms）；
   - `guard()`：前台是 DSH 时拒绝一切激活动作；点击/拖拽/滚动锚点先 warp 再用
     `windowAtCursor()` 检查落点窗口，避免点到可见的 DSH 窗口；
   - `dispatch()`：交给 `linux-x11.mjs` 注入；失败路径释放鼠标按键。
5. 后端补充：`linux-x11.mjs` 新增 `windowAtCursor()`（落点窗口身份）；`warpTo()`
   在指针已在目标位置时直接返回（`xdotool mousemove --sync` 在同坐标上不会产生
   运动事件，会挂到超时）。
6. 1.1.1 独立审阅后的加固（对应 §2.1 不变量 4/5/6/7/8/9）：
   - 注入点二次读 pause 文件；`inputcheck` 暂停时跳过指针探测；
   - `validate()` 增加观察屏边界拒绝，`dispatch()` 下发前再校验一次；
   - `prove()` 每次重新枚举显示器并要求 id/几何一致（布局变化即 `stale_observation`）；
   - 落点窗口身份不可读时 fail closed（`window_unidentified`）；
   - Wayland / 无 `DISPLAY` 在选后端阶段 fail closed；
   - `wait` 的后续截图沿用会话最新的观察屏，不再默默切回主屏；
   - 单动作派发规范化后的 `plan.args`（例如字符串 `delta` 不会变成反向滚动）；
   - 拖拽读回终点，未到目标即 `drag_unstable`；按键别名与 Windows 对齐
     （`ArrowUp` 等、允许单独修饰键）；
   - 后端自检把缺 `xclip` 降级为 warning，临时文件名加随机后缀。

8. 1.3.0：
   - `type` 走剪贴板：写 CLIPBOARD（`backends/clipboard.py`，GTK）→ `Ctrl+V` → 恢复原剪贴板；
     对模型仍是 `type` 语义（黑箱），避免 XIM/ibus 把 `a.b.c` 变成拼音候选、吞掉点号；
     剪贴板不可用时 ASCII 回退 raw keys（并给 warning），CJK 直接 `clipboard_unavailable`；
   - `computer_screenshot { region, scale }`：只返回局部/缩放图片，令牌仍绑定整屏（指纹不变）；
     `originX/originY` 改为裁剪区域绝对原点，动作坐标仍是屏局部；
   - DSH 拦截改为目标级：键盘动作（type/key）看焦点窗口，指针动作（click/drag/scroll）看
     落点窗口；`move` 不受限。这样用户在 DSH 里看对话时，模型仍能操作其它窗口/屏幕；
   - 观测令牌 TTL 可配置：`policy.json` 的 `observationTtlMs`（或环境变量），默认 180s；
   - `inputcheck.check.clipboard` 报告 helper 可用性。

7. 1.2.0 补齐：
   - 锁屏检测（logind LockedHint / GNOME ScreenSaver / 锁屏窗口类）；锁屏时拒绝注入，
     `inputcheck` 跳过指针探测并报告 `locked`/`lockSource`；
   - X11 全局急停热键 `backends/x11-hotkey.py`（python3-Xlib XGrabKey；含 Lock/NumLock
     变体；主 `Ctrl+Alt+Shift+Q`，备用 `Ctrl+Alt+Shift+F12`）；helper 起不来时降级为
     仅 UI 暂停，`inputcheck.check.brake` 给出原因；
   - 负原点显示器布局：截根窗口 + Node 裁剪/编码（`encodePng`/`cropImage`），根窗口
     覆盖不到时明确报错；
   - 指纹为空时回退整屏 8×8 指纹（`fingerprintTarget: 'screen' | 'window' | 'none'`）；
   - `inputcheck` 指针探测与 dispatch 共用指针队列，避免并发抢指针；
   - 热键候选禁止 `Ctrl+Alt+F1..F12`（X.org VT 切换组合，会黑屏），只保留带 Shift 的。

仍未完成（下一步）：

1. `backends/win32.mjs`：把 `index.js` 里的 `PS_PREAMBLE` / `CSHARP` / `actionScript` /
   `Capture-Observation` / `brakeScript` / `inputCheck` 的 PowerShell 部分原样搬过去，
   并补 `EnumDisplayMonitors` 单屏截图（替换 `SystemInformation.VirtualScreen`）。
   搬完后 Windows 才能像 Linux 一样拿到 `screen` 参数与单屏截图。
2. `sequence` 每步都会重采样指纹（符合 2.1 不变量 3），20 步的批处理会多出约
   200ms/步的复核成本；如需更快，可改为批前复核 + 步间只查 pause/前台窗口，
   但那会放松不变量，需显式评估。
3. 锁屏检测：X11 无对应概念（Windows 的 `desktop_locked`），Linux 侧不注入即不
   拦截；`inputcheck` 以 `locked: false` 表示"不适用"。
4. 全局急停热键仍是 Windows-only：Linux 只能从 UI/`pause` 动作暂停，用户从
   status 路由恢复；这点在工具描述和 `inputcheck` 里如实说明。
5. 指纹回退的粒度：前台窗口不在观察屏上时用整屏 8×8 指纹（能发现画面整体变化，
   但不如窗口级精细）。后续可改成"按动作落点所在窗口重新采样"。
6. 负原点显示器布局：`scrot -a` 无法表达负坐标，当前以明确错误拒绝；需要换成
   "截根窗口再按显示器裁剪"的实现（纯 Node 解码已具备裁剪能力）。

## 4b. Linux 侧测试

```bash
# 纯参数校验（无 X11、无 DSH）：含边界、键盘别名、序列限制
node tests/adapter-selftest.mjs

# win32 模拟：伪 platform 导入，检查 Windows 描述/schema 未被 Linux 改动污染
node tests/windows-mode-selftest.mjs

# 真机端到端：用 fake Cordis ctx 挂载 index.js，跑截图/移动/暂停（含注入点复查）/
# 换屏/wait 保持屏/status+shot 路由；DSH 窗口在前台时自动跳过激活动作相关项
node tests/linux-integration.mjs
node tests/linux-integration.mjs --click-at 40,40 --type "hello"   # 会真的点/打字
node tests/linux-integration.mjs --test-hotkey                       # 会真的按急停热键（Shift 组合）
```

集成测试把 `DSH_HOME` 重定向到 `.e2e-dsh-home/`（结束后删除），不碰真实配置。

## 5. 测试

```bash
# 离线（任何平台，无需 X11）
node backends/selftest.mjs
# 真机 X11（只移动指针/截图；点击/输入需显式参数）
node backends/smoke-linux.mjs
node backends/smoke-linux.mjs --screen HDMI-1-0
node backends/smoke-linux.mjs --click-at 400,300 --type "hello"
```

## 6. 分发与跨机同步（dsh-config-manager）

- `package.json` 的 `files` 必须包含 `backends`（已加入）。否则 `npm pack` 不会带上，
  dsh-config-manager 把本地 `link:` 插件打包同步到对端时，后端文件会丢。
- 同步本地插件的实际行为：`npm pack` 成 tarball → 对端解到
  `$DSH_HOME/dsh-config-manager/local-plugins/` 并以 `file:` 安装。它是**快照副本，不是 link**。
- 因此对端**不要在那个副本里开发**：把插件目录拷到开发目录，profile 改挂
  `link:<dev-dir>`，否则改动不会生效、也不会被下一次 push 打包。
- 同版本不同内容可能被同步端当作"相同项"跳过 ⇒ **每次实质改动都要 bump `version`**
  （开发期可用 `1.0.1-dev.N`）。
- 反向同步（Linux → Windows）只在 Linux profile 挂的是 `link:` 开发目录时成立：
  push 时打包的是当前工作树，而不是 config-manager 自己解出来的副本。

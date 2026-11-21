# dsh-computer-use

[English](README.md) | 简体中文

**一个 DeepSeek Harness（DSH）插件：给智能体两个工具——带一次性观察令牌的单屏截图，以及受意图、风险、审批、审计与紧急暂停约束的原生鼠标/键盘输入。**

它不是截图理解模型，也不是工作流引擎。插件提供的是确定性的桌面 *I/O 原语与安全层*；点什么由智能体决定，高风险动作是否放行由 DSH 的审批策略决定。

- 原生后端，无 OCR、无云服务、无运行时 npm 依赖：Windows 使用 Windows PowerShell 5.1 + 内存内 C# `SendInput` helper（`backends/win32.mjs`）；Linux 使用 X11 工具（`xdotool`、`scrot`/`import`/`xwd`、`xprop`、`xwininfo`、`xrandr`），见 `backends/linux-x11.mjs`。
- 观察 → 动作 → 再观察：每次截图生成一次性 `state_id`；每个输入动作都必须携带它，并在真正下发前重新复核。
- 意图、风险与审批：激活动作需要一句 `intent`；风险意图、风险窗口与系统级按键会被评级并交给 DSH 审批 seam，审批不可用时失败即拒绝。
- 内置审计与暂停：每次尝试都写入本地 JSONL 审计（绝不记录输入文本）；pause 文件存在时拒绝一切输入，只有用户能恢复。
- 按会话开启：两个工具默认不注册，直到在会话「桌面」tab 打开开关；状态存在 `~/.dsh/capability-toggles.json`。
- 原生 DSH 集成：会话「桌面」视图、工具卡片、中英文 locale，以及可选的 `computerUse` provider 槽位——即使槽位被其他插件占用，工具仍可用。

支持 Linux/X11 与 Windows。**不支持 Wayland 与 macOS。** 详见 [docs/PLATFORMS.md](docs/PLATFORMS.md)。

---

## 目录

- [这是什么](#这是什么)
- [特性](#特性)
- [与其他方案对比](#与其他方案对比)
- [环境要求](#环境要求)
- [安装](#安装)
- [按会话开启](#按会话开启)
- [快速开始](#快速开始)
- [工具说明](#工具说明)
- [观察令牌与安全流程](#观察令牌与安全流程)
- [文件与状态](#文件与状态)
- [安全警告](#安全警告)
- [已知限制](#已知限制)
- [文档索引](#文档索引)
- [许可证](#许可证)

---

## 这是什么

`dsh-computer-use` 是 DeepSeek Harness 的插件，向模型注册两个工具：

| 工具 | 作用 |
|---|---|
| `computer_screenshot` | 截取**一块显示器**为 PNG，返回路径、几何、光标、前台窗口、显示器清单，以及新的一次性观察令牌（`state_id`）。 |
| `computer` | 在该令牌之下对桌面执行**一个真实输入动作**（或一小批）：move、click、double_click、right_click、drag、scroll、type、key；另有流程动作 `wait`、`sequence`、`inputcheck`、`pause`。 |

桌面原语按平台原生实现；工具契约、令牌生命周期、风险策略、审计与暂停是平台无关的，位于 [`index.js`](index.js)。平台选择在运行时由 [`backends/index.mjs`](backends/index.mjs) 完成。

## 特性

以下能力均在本仓库实现，细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

- **两套原生后端，无第三方运行时。**
  - **Windows**：Windows PowerShell 5.1 + `Add-Type` 编译的内存内 C# P/Invoke helper（`SendInput`、前台窗口、DPI 感知、WinForms `Screen.AllScreens` 显示器枚举）。helper 暂存到 `%LOCALAPPDATA%`，避免工作区目录的低完整性级别悄悄吞掉 `SendInput`。
  - **Linux/X11**：`xdotool` 注入 XTest 输入，截图工具优先 `scrot`（回退 `import`、`xwd`），`xprop`/`xwininfo` 读取前台窗口，`xrandr` 枚举显示器。PNG 解码/编码/裁剪/缩放用 `node:zlib` 完成，不依赖图像库。
  - `package.json` **没有运行时依赖**；没有 OCR、没有本地模型、没有截图理解服务，插件自身不发起外部网络请求（Web 客户端只调用宿主同源的自身路由）。
- **观察令牌，而不是截图路径。** Linux 上令牌绑定所截显示器；两种平台上令牌都绑定前台窗口身份（handle、标题、进程、边界）以及该窗口的 8×8 像素指纹（Linux 上窗口不在该屏时退化为整屏指纹）。令牌一次性使用、会过期（默认 180 秒，可配置），同一会话的新截图会让旧令牌作废。
- **下发前重新证明。** 令牌本身不被盲目信任：真正注入前会重新枚举显示器布局、重新读取前台窗口并重采样指纹。窗口、边界、布局或像素变化都会以 `stale_observation` 拒绝，而不是盲点。
- **意图/风险/审批集成。** click/double_click/right_click/drag/type/key/sequence 需要一句 `intent`（≤ 200 字符）。匹配风险动词（`send`、`delete`、`pay`、`password`、`install`、`confirm` 等）的意图、看起来像银行/账户/邮件界面的窗口，以及系统级组合键（`Alt+F4`、`Ctrl+Alt+Del`、`Win+R`）会被评为高风险。高风险动作需要 `confirm_risk: true`，随后交给 DSH 的 `approval` 服务；审批缺失、被拒绝、被取消或会话策略为 `never` 时一律拒绝（失败即拒绝）。
- **审计。** 每次尝试在 `~/.dsh/computer-use/audit.jsonl` 追加一行 JSON：时间、会话、调用、动作、意图、风险等级、结果、拒绝码、坐标、按键以及文本**长度**（绝不记录输入文本本身）。
- **物理暂停。** `~/.dsh/computer-use/pause.json` 存在时阻断一切输入，包括 sequence 批次中途。模型可以暂停自己，但永远不能恢复：只有用户能在「桌面」tab（status 路由）解除暂停。Windows 以及带 `python3` + `Xlib` 的 X11 环境还提供全局急停热键（`Ctrl+Alt+Shift+Q`，备用 `Ctrl+Alt+Shift+F12`），按下即写入 pause 文件。
- **按会话能力开关，默认关闭。** 两个工具通过 `when` 谓词读取共享的 `~/.dsh/capability-toggles.json`；「桌面」视图顶部的开关写同一个标记，关闭后智能体下一步即看不到工具，无需重启。
- **DSH 窗口保护。** 禁止自动输入进 DSH 自己的窗口（`dsh_window_blocked`），因为该窗口承载安装与授权控件。Linux 采用目标级判定：DSH 在前台时拒绝键盘动作，指针动作只在落点确实落在 DSH 上时拒绝；Windows 保留原来“前台是 DSH 就拦截激活动作”的规则。
- **诊断而不是原始报错。** `computer { "action": "inputcheck" }` 会探测输入链路与环境（Linux：会话类型、依赖工具、显示器布局/DPI、指针 warp、剪贴板 helper、暂停/锁屏与急停状态；Windows：helper 暂存、完整性级别、锁屏、派发确认、指针漂移与急停状态），并给出安装提示与可执行诊断；缺依赖时返回结构化拒绝，而不是让 `scrot`/`xrandr` 抛原始错误。不支持的会话（Wayland、无 `DISPLAY`、其他系统）在选择后端阶段就失败即拒绝。
- **DSH 原生客户端 UI。** `conversation.view` 的「桌面」tab（按轮次分组、筛选、放大截图、点击位置红框标注）；`computer_screenshot` 与 `computer` 的 `tool.call.toolview` 卡片；中英文词典；插件图标。源码见 [`client.js`](client.js) 与生成的 [`client.web.js`](client.web.js)。

## 与其他方案对比

诚实地说：这是**带确定性安全壳的桌面输入原语**，不是自主 computer-use 智能体，也不是浏览器自动化框架。

| 方案 | 给智能体什么 | 安全模型 | 取舍 |
|---|---|---|---|
| **pyautogui 类脚本** | 完整的 Python 鼠标/键盘与截图 API；智能体（或外层）要自己写/跑脚本 | 取决于脚本作者；通常没有观察令牌、下发前复核、审批 seam 或审计 | 每个任务都要定制脚本；坐标/状态竞态容易踩坑；没有 DSH 集成 |
| **Anthropic computer-use demo** | 参考性的“截图 → 鼠标/键盘动作”工具循环与安全建议 | 示例级防护；审批/审计需采用方自建 | 参考 demo，不是打包好的 DSH 插件；运行时、策略和 UI 都要自己负责 |
| **浏览器自动化（Playwright/Selenium/Puppeteer）** | 可靠的浏览器 DOM 级控制 | 浏览器进程沙箱 + 选择器级确定性 | 只能操作浏览器；不能驱动原生应用或系统；需要自己的运行时 |
| **dsh-computer-use** | 两个 DSH 工具：单屏截图 + 原生鼠标/键盘输入原语，带显式观察、意图与风险语义 | 确定性的下发前检查（一次性令牌、重新证明、屏幕边界、暂停、DSH 窗口保护）、高危动作走宿主审批、审计与急停；按会话 opt-in | 真实输入，因此没有沙箱；只支持 Linux/X11 与 Windows；风险评级是启发式而非 allowlist；没有 OCR/元素定位 |

本仓库**没有**使用或捆绑 pyautogui、Playwright、Selenium、Puppeteer，也不调用 OCR 或云端视觉 API。实际使用/参考的项目见 [CREDITS.md](CREDITS.md)。

## 环境要求

- **DSH**：使用支持插件的 profile（实测 `0.2.2-rc.5`，安装示例用 `web`），以及用于「桌面」视图的浏览器。
- **Node.js ≥ 22**（`package.json` 声明；插件只用 ESM 与 Node 内置模块）。
- **Linux**：X11 会话（`DISPLAY` 已设置，`XDG_SESSION_TYPE` 不是 `wayland`）。
  - 必需工具：`xdotool`、`xprop`、`xwininfo`、`xrandr`。
  - 推荐截图工具：`scrot`；`import`（ImageMagick）与 `xwd`（x11-apps）是回退。
  - 推荐 helper：`python3` + `Xlib` 用于全局急停热键；`python3` + GTK 3（`python3-gi`、`gir1.2-gtk-3.0`）用于通过剪贴板可靠输入 Unicode。缺 GTK 时 ASCII 输入回退原始按键，非 ASCII 输入以 `clipboard_unavailable` 失败。
  - Debian/Ubuntu 示例：
    ```bash
    sudo apt install xdotool scrot x11-utils x11-xserver-utils
    # 可选但推荐：
    sudo apt install python3-gi gir1.2-gtk-3.0 python3-xlib
    ```
- **最小安装（除此之外不需要再装任何东西；使用方无需 `npm install`，也没有构建步骤）：**

  | 平台 | 必须安装 | 可选/推荐 |
  |---|---|---|
  | Linux X11 | `xdotool x11-utils x11-xserver-utils scrot` | `python3-xlib`（全局急停热键）、`python3-gi gir1.2-gtk-3.0`（剪贴板输入 Unicode） |
  | Windows 10/11 | 无（自带 Windows PowerShell 5.1） | — |

- **Windows**：Windows 10/11，带 Windows PowerShell 5.1（默认的 `powershell.exe`）。不需要 npm 包，插件本身也不需要管理员权限；helper 文件暂存在 `%LOCALAPPDATA%\dsh-computer-use\helper`。Windows UIPI 仍会阻止 `SendInput` 注入到更高完整性级别的窗口，因此请让 DSH 与目标应用运行在同一权限级别。

> **Windows 状态：** Windows 后端已实现，并有静态/纯函数测试覆盖，但本仓库尚未在真实 Windows 桌面上做端到端验证。请先运行 `computer { "action": "inputcheck" }` 和一次截图确认。详见 [docs/PLATFORMS.md](docs/PLATFORMS.md)。

## 安装

从 GitHub 安装到 DSH profile：

```bash
dsh plugin --profile web add github:nicken/dsh-computer-use
```

如果插件没有出现，重启一次 DSH Web 应用（profile 插件在启动时组合）。安装包已包含生成好的客户端 bundle，安装时不需要构建。

插件的 `dsh` 元数据（`bundle.patch` → `cordis.patch.yml`）把 `computer-use` 条目插入 profile 组合树；`package.json` 提供 Web 客户端（`platform: web`、immediate、注入 locale）。本地开发挂载见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 作用范围：仅 Harness 所在的那台机器

插件把真实输入注入到**运行 DSH 宿主的操作系统会话**（`dsh web` 所在的那台机器）。它不是远程桌面，
也不是浏览器里的远程控制：

- 你从另一台电脑打开 DSH Web UI，agent 操作的仍然是 **Harness 宿主机的桌面**，永远不会是你正在
  浏览的那台电脑。
- 如果 DSH 跑在服务器、虚拟机、容器或 WSL 里，且没有可交互的桌面会话，那么没有桌面可操作
  （Linux 需要 X11 的 `DISPLAY`；Windows 需要已解锁的交互式会话）；Wayland、无头容器和 macOS
  均不支持。
- DSH 页面本身只允许用户操作：插件会拒绝驱动 DSH UI，agent 无法点击自己的控制面板。

要控制另一台机器，请在那台机器上安装并运行 DSH 宿主（建议用专用虚拟机），然后从任意位置连接它的
Web UI——输入仍然发生在运行 agent 的那台机器上。

## 按会话开启

电脑操作**默认关闭，按会话 opt-in**：

1. 在 DSH Web 应用里打开一个会话。
2. 打开会话视图中的**「桌面」**tab（本插件注册的 `computer-use` 视图）。
3. 打开 **「开启电脑操作」** 开关。

开关读写 `~/.dsh/capability-toggles.json`（`{ "version": 1, "sessions": { "<sessionId>": { "computerUse": true } } }`），也就是工具 `when` 谓词读取的同一个标记。开启后智能体下一步即可使用；关闭后两个工具从下一步起移除。MCP/技能管理器的会话内能力控制写同一个文件，用哪个入口都行。

开关缺失或会话没有 id 时工具保持关闭——这是有意的。

## 快速开始

典型的智能体循环（Linux/X11 语义；坐标规则见下文）：

```jsonc
// 1. 观察一块显示器（省略 "screen" = 主屏/最大屏）
{ "tool": "computer_screenshot", "arguments": { "screen": "auto" } }
// → path、width、height、originX、originY、cursor、foreground、
//   state_id、screen、screens
```

PNG **不会自动附加到对话**。智能体必须用图像读取工具打开返回的 `path` 才能真正看到画面。

```jsonc
// 2. 在该令牌下执行一个带意图的动作
{
  "tool": "computer",
  "arguments": {
    "action": "click",
    "x": 420,
    "y": 260,
    "intent": "Open the Settings menu in the test application",
    "state_id": "obs_…"
  }
}
// → ok、detail、cursor、foreground，以及新的观察（path + state_id）
```

```jsonc
// 3. 查看新截图后继续；新的截图会让上一个令牌作废。
```

高风险动作必须显式请求用户审批：

```jsonc
{
  "tool": "computer",
  "arguments": {
    "action": "click",
    "x": 640,
    "y": 480,
    "intent": "Submit the completed order form",
    "confirm_risk": true,
    "state_id": "obs_…"
  }
}
```

如果 DSH 会话审批策略是 `never`，这类动作会以 `risk_denied` 自动拒绝。

### 坐标

- **Linux/X11**：`computer` 的所有坐标（`x`、`y`、`toX`、`toY` 以及滚动锚点）都是**观察令牌对应显示器的局部坐标**。截图原点就是显示器原点；换屏必须重新截图。
- **Windows**：动作坐标是**桌面全局坐标**。截图会返回 `originX`/`originY`，图上位置换算为 `全局 = origin + 图上位置`。
- Linux 上每个坐标都必须落在被观察显示器内，越界会在注入前以 `invalid_args` 拒绝；Windows 的坐标是桌面全局坐标，当前实现没有按单块显示器校验。

## 工具说明

**默认只有一个工具。** `computer({action:"screenshot", ...})` 已合并进 `computer` 工具，
所以一个会话通常只看到一个能力。独立的 `computer_screenshot` 工具只在打开按会话的
“高级工具面”开关后注册（脚本与兼容场景）。下面两者都会说明。

### `computer_screenshot`

| 参数 | 类型 | 含义 |
|---|---|---|
| `screen` | string，可选 | **Linux**：省略/`"auto"` → 主屏（没有主屏时面积最大屏）；`"cursor"` → 指针所在屏；否则显示器 id（如 `"HDMI-1-0"`）或 index（`"1"`）。**Windows**：省略 → 主屏；`"all"` → 整个虚拟桌面；否则显示器 id（如 `"DISPLAY1"`，可省略 `\\.\` 前缀）或 index。 |
| `region` | object，可选 | 显示器局部裁剪 `{ x, y, width, height }`（整数）。只返回该区域；Linux 上观察令牌仍绑定整块显示器。 |
| `scale` | number，可选 | 裁剪区域的可选缩小倍数（例如 `0.5` 将宽高减半）。 |

返回字段：

| 字段 | 含义 |
|---|---|
| `path` | PNG 的绝对路径（要用图像工具读取才能真正看到）。 |
| `width`、`height` | 返回图片的尺寸（有裁剪/缩放时是裁剪后的）。 |
| `originX`、`originY` | 返回图片左上角在桌面上的绝对原点。 |
| `cursor` | 光标位置 `{ x, y }`（Linux 为屏局部；Windows 为桌面全局）。 |
| `foreground` | 前台窗口 `{ title, process, handle, rect }`。 |
| `state_id` | 一次性观察令牌（`obs_…`）。 |
| `screen` | 本次截图的那块显示器 `{ id, index, primary, x, y, width, height }`（Linux 可用时附带 `dpi`/`rotation`）。 |
| `screens` | 当前检测到的全部显示器，结构相同。 |
| `region` | 请求了裁剪时回显 `{ x, y, width, height, scale? }`。 |

显示器布局每次调用都会现查（热插拔、旋转、多屏变化均不缓存）。未知显示器 id 会报错并列出当前检测到的全部显示器。

### `computer`

| 参数 | 类型 | 含义 |
|---|---|---|
| `action` | enum，必填 | `move`、`click`、`double_click`、`right_click`、`drag`、`scroll`、`type`、`key`、`wait`、`sequence`、`inputcheck`、`pause`。 |
| `state_id` | string | 观察令牌。所有输入动作与 `sequence` 必填；`wait`、`inputcheck`、`pause` 不需要。 |
| `intent` | string（≤ 200） | 一句话描述目标。`click`、`double_click`、`right_click`、`drag`、`type`、`key`、`sequence` 必填；参与风险评级并写入审计（截断到 120 字符）。 |
| `confirm_risk` | boolean | 接受高风险动作走用户审批。不设置时，高风险动作在任何实际动作发生前就被拒绝。 |
| `x`、`y` | integer | `move`、点击类动作、拖拽起点或滚动锚点的目标坐标。 |
| `toX`、`toY` | integer | 拖拽终点（仅 `drag`）。 |
| `delta` | integer | `scroll` 滚轮增量：负值向下、正值向上，一格为 `120`（默认 `-120`）。 |
| `text` | string（≤ 4000） | `type` 的文本（Unicode）。 |
| `keys` | string | `key` 的按键组合，例如 `"Ctrl+Shift+I"` 或 `"Enter"`。修饰键：Ctrl/Control、Shift、Alt、Win/Meta/Cmd；命名键包括 Enter/Return、Tab、Escape/Esc、Space、Backspace、Delete/Del、Insert、Home、End、PageUp、PageDown、Up/Down/Left/Right（及 Arrow 别名）、CapsLock、PrintScreen、F1–F12；允许单独使用修饰键。 |
| `ms` | integer | `wait` 时长，1–30000 毫秒（默认 `500`）。 |
| `steps` | array（1–20） | `sequence` 的步骤：输入动作（`move`、`click`、`double_click`、`right_click`、`drag`、`scroll`、`type`、`key`），不带 `state_id`；步骤不能嵌套 `sequence`。步骤文本合计上限 8000 字符。 |

各动作要求：

- `move`、`click`、`double_click`、`right_click` 需要 `x`、`y`。
- `drag` 需要 `x`、`y`、`toX`、`toY`。
- `scroll` 的 `x`/`y` 可选；省略时在当前指针位置滚动。
- `type` 需要 `text`；`key` 需要 `keys`。
- `sequence` 继承令牌的显示器，在步骤之间复查暂停，并在 Linux 上于每一步前重新证明观察状态。
- `inputcheck` 在暂停或锁屏时不注入任何输入；用于诊断输入链路与环境。
- `pause` 幂等且不需要令牌；模型可以暂停，但不能恢复。

成功的输入动作（以及 `wait`）会返回**新的截图与观察令牌**：

```jsonc
{
  "ok": true,
  "action": "click",
  "detail": "clicked left at (420, 260)",
  "cursor": { "x": 420, "y": 260 },
  "foreground": "Test application — main window",
  "observation": {
    "state_id": "obs_…",
    "path": "<DSH_HOME>/computer-use/shots/shot-….png",
    "width": 1920,
    "height": 1080,
    "originX": 0,
    "originY": 0,
    "screen": { "id": "HDMI-1-0", "…": "…" }
  }
}
```

`sequence` 还会返回 `steps: [{ action, detail }]`。失败返回 `ok: false` 与 `code`、`message`、`guidance`；相关时附 `foreground`、`risk`、`steps`、`blockedStep`。

### 拒绝码

| 码 | 含义 |
|---|---|
| `missing_observation` | 没有提供 `state_id`。 |
| `observation_expired` | 令牌未知、属于其他会话，或超过 TTL。 |
| `observation_used` | 令牌已被一次实际下发的动作消费。 |
| `observation_superseded` | 会话里有更新的截图；请使用它的令牌。 |
| `stale_observation` | 截图后布局、前台窗口、窗口边界或采样像素发生变化。 |
| `foreground_unreadable` / `observation_unverifiable` | 无法重新读取前台状态；失败即拒绝。 |
| `intent_required` | 激活动作未提供 `intent`。 |
| `risk_approval_required` | 评为高风险；如确实需要，带 `confirm_risk: true` 重试。 |
| `risk_denied` / `risk_unavailable` | 审批被拒绝/取消，或审批服务不可用——失败即拒绝。 |
| `invalid_args` | 动作参数错误、坐标越界、region/scale 非法，或步骤被拦截。 |
| `paused` | 用户的紧急暂停生效中。 |
| `desktop_locked` | 系统会话已锁定，注入的输入会被丢弃。 |
| `dsh_window_blocked` | 目标是 DSH 窗口，只能由用户操作。 |
| `window_unidentified` / `window_probe_failed` | 无法确定目标窗口身份；失败即拒绝。 |
| `pointer_warp_unstable` / `drag_unstable` | 无法校验指针/拖拽终点；插件拒绝谎报成功。 |
| `clipboard_unavailable` | 非 ASCII 输入需要 GTK 剪贴板 helper，但不可用。 |
| `unsupported_platform` | Wayland、缺少 `DISPLAY` 或不支持的系统。 |
| `inputcheck_failed` / `action_failed` | 自检或 helper 报错；阅读 `message`/`guidance`。 |

拒绝结果都带可执行的 `guidance`，例如“重新截图并使用新的 state_id”。

## 观察令牌与安全流程

1. `computer_screenshot` 只截一块显示器并生成令牌。令牌绑定前台窗口身份及该窗口的 8×8 像素指纹；Linux 上还绑定显示器几何，并在窗口不在该屏时退化为整屏指纹（`fingerprintTarget` 记录 `window`、`screen` 或 `none`）。
2. 会话中的第一次输入调用会原子地预留令牌。如果该调用在下发前被拒绝（参数错误、缺少意图、缺少/被拒审批），预留会释放，同一个 `state_id` 可以重试。一旦动作真正下发，令牌即被消费。
3. 真正下发前，插件重新枚举显示器布局、重新读取前台窗口（handle、边界）并重采样指纹。任何变化都会以 `stale_observation` 拒绝，并标注 `window`、`bounds`、`layout` 或 `pixels` 子类型。
4. 成功动作（包括 `wait`）返回新的截图与令牌；新截图会让上一个令牌作废。令牌默认 180 秒过期（`policy.json` → `observationTtlMs`，或环境变量 `DSH_COMPUTER_USE_OBSERVATION_TTL_MS`；范围 5 秒–30 分钟）。每个进程最多保留 200 个令牌。
5. pause 文件在工具层、后端注入点以及 `sequence` 步骤之间都会被复查，因此紧急停止也能打断批次。

## 文件与状态

所有插件状态位于 `$DSH_HOME/computer-use/`（`$DSH_HOME` 默认 `~/.dsh`）：

| 路径 | 用途 |
|---|---|
| `shots/` | PNG 截图；只保留最新 60 张。 |
| `audit.jsonl` | 每次下发尝试一行 JSON；绝不保存输入文本（只有 `textLength`）。 |
| `pause.json` | 紧急暂停记录；存在即阻断输入。 |
| `brake.json`、`brake.stop` | 急停热键 watcher 的状态/停止请求。 |
| `policy.json` | 可选：`observationTtlMs`、`riskyIntent`、`riskyIntentReplace`、`riskyApp`、`riskyAppReplace`。 |
| `~/.dsh/capability-toggles.json` | 共享的按会话能力存储；本插件只改 `sessions.<id>.computerUse`。 |
| `%LOCALAPPDATA%\dsh-computer-use\helper`（Windows） | 暂存的 PowerShell helper 脚本。 |

截图通过 `/api/computer-use/shot`（`GET`/`HEAD`，仅 PNG 文件名，拒绝路径穿越）提供给已认证的 DSH Web UI。status 路由 `/api/computer-use/status` 是用户的暂停/恢复通道；`/api/computer-use/capability` 支撑按会话开关。这些路由都不会暴露为模型工具。

## 安全警告

本插件会在**真实桌面上执行真实鼠标与键盘输入**，能力等同于用户本人坐在键盘前。开启前请阅读：

- **使用专用 VM 或专用桌面会话。** 除非你接受风险，不要在存有凭据、私密消息或不可替代数据的机器上运行。把它当作远程控制软件，而不是沙箱。
- **截图涉及隐私。** 截图保存在 `~/.dsh/computer-use/shots/`，可能包含密码、token、客户数据或个人信息，且不会做脱敏。智能体读取截图路径时它可能进入模型上下文，也会提供给已认证的 DSH UI。请保持桌面整洁、关闭敏感窗口，必要时清理截图目录。
- **提示注入是真实的动作路径。** 风险策略基于文本与窗口表面的启发式匹配；恶意网页或文档可能把请求伪装成中性意图。审批提示、按会话开关与审计记录是防线——请使用它们并复查智能体做了什么。
- **输入不是秘密安全的。** Linux 上 `type` 通过剪贴板注入（临时成为剪贴板 owner，随后恢复原文本），剪贴板管理器可能保留内容。不要让智能体输入密码；使用应用自身的认证流程。
- **本插件不是 allowlist，也不是安全边界。** 它可以驱动用户能驱动的任何应用（DSH 窗口受保护）。操作系统级隔离、独立账号、网络策略与备份仍由你负责。
- **DSH 窗口保护是安全措施，不是沙箱。** 它阻止自动输入进 DSH 自己的窗口，但无法识别其他所有特权窗口。请让急停热键触手可及。
- **没有外部网络请求。** 插件不会上传截图或调用云服务；Web 客户端只与 DSH 同源的自身路由通信。但当智能体读取截图时，截图会照常通过 DSH 会话进入模型提供方。
- **用完即关。** 智能体不需要桌面时，关闭按会话开关或使用 `pause`。

威胁模型与部署建议见 [docs/SECURITY.md](docs/SECURITY.md)。

## 已知限制

- **不支持 Wayland**（包括仅 XWayland 的会话）：没有全局 X11 输入注入与全局前台窗口。后端在选择阶段就会给出明确原因并拒绝。
- **暂不支持 macOS 与其他平台。**
- **一次截图只截一块显示器。** 要操作另一块屏，必须重新截图；Linux 上令牌绑定所截显示器。
- **Windows 动作坐标是桌面全局坐标**，与 Linux 的屏局部坐标不同。这是当前实现的有意行为，工具描述已写明。Windows 尚未在本仓库中做过真实硬件端到端验证。
- **风险评级是启发式的。** 它看意图文本、前台应用的标题/进程与系统按键组合，不是语义分类器，也不了解你的业务规则；可扩展 `policy.json` 或依赖审批策略。
- **没有 OCR、没有元素定位、没有应用专用驱动。** 智能体必须自己看截图并计算坐标。
- **没有屏幕脱敏、没有按应用 allowlist、没有沙箱。**
- **`sequence` 在步骤之间重新证明状态**，因此长批次每步会有数百毫秒复核开销（Linux）。这是有意设计；未经安全评审不要放松。
- **锁屏检测是 best-effort**（Linux 的 logind/DBus/锁屏窗口探测；Windows 的 `DesktopLocked`）。检测不到的锁屏仍可能让注入输入被丢弃。
- **剪贴板恢复是 best-effort**：超大/二进制剪贴板、剪贴板管理器与 helper 生命周期都可能影响恢复结果。
- **Linux 全局急停热键需要 `python3` + `Xlib`**，最小化会话中可能不可用；UI 暂停仍然有效，`inputcheck` 会报告真实原因。
- **Linux 的 Unicode 输入需要 GTK 3**；缺失时 ASCII 回退原始按键，非 ASCII 以 `clipboard_unavailable` 失败。
- **截图只保留 60 张**，令牌表在内存中：宿主重启会让未使用的令牌失效（`observation_expired`）。
- **多屏布局只在有限真实配置上验证过**；更换显示器后建议先跑一次 `inputcheck`。
- **无自动更新**；通过 DSH profile 的插件机制更新。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、后端契约、令牌生命周期、风险/审批、审计、暂停、能力开关、DSH 集成点。 |
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | Linux/X11 依赖与坐标规则、Windows 后端细节、Wayland 限制、排错。 |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型、默认边界、审批策略、部署建议、漏洞报告。 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地 profile link、目录结构、客户端构建、代码风格、发布流程。 |
| [docs/TESTING.md](docs/TESTING.md) | 三层测试、命令、CI 矩阵与本地复现。 |
| [docs/TOOL-SURFACE.md](docs/TOOL-SURFACE.md) | 把 2 个工具合并为 1 个 `computer` facade + 可选「高级」开关的提案。 |
| [docs/demo-2026-11-10-baidu-news.md](docs/demo-2026-11-10-baidu-news.md) | 一次 Linux/X11 真机会话记录，作为回归对照。 |
| [backends/CONTRACT.md](backends/CONTRACT.md) | 后端契约、坐标规则与不变量（中文）。 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更。 |
| [CREDITS.md](CREDITS.md) | 使用/参考的项目与致谢。 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Issue、PR、测试与行为准则。 |

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

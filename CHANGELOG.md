# CHANGELOG — dsh-computer-use

## Unreleased (this branch)

- **Single tool surface by default.** The default capability registers one `computer` tool;
  `computer({action:"screenshot"})` replaces the usual first call. The standalone
  `computer_screenshot` tool is registered only when `computerUseAdvanced` is on. The Desktop tab
  exposes both switches.
- Integration test now exercises `computer({action:"screenshot"})`.

本文件记录 Linux/X11 接线以来的版本变更。基线 1.0.1 是安装包里原有的 Windows 原生实现。

## 1.6.0 — 2026-11-16

- **抽离 `backends/win32.mjs`**：Windows 原生实现（C# P/Invoke 源码、PowerShell 暂存执行、
  截图/观察、显示器枚举）从 `index.js` 移入 `backends/win32.mjs`；工具层继续保留观测令牌、
  意图/风险、审计与 pause。动作/自检/急停的 PowerShell 脚本仍在 `index.js`（下一步再抽）。
- **Windows 单屏 + region/scale**：`computer_screenshot` 在 Windows 上支持 `screen`
  （省略→主屏；`"all"`→整个虚拟桌面；显示器 id 或 index）、`region`（显示器局部坐标裁剪）
  与 `scale`（缩小图片），返回 `screen`/`screens`。显示器用 WinForms `Screen.AllScreens`
  枚举，负原点布局可用。
  **Windows 的动作坐标仍是桌面全局坐标**：截图返回 `originX/originY`，动作坐标 = 偏移 +
  图上位置；工具描述已写清楚，避免与 Linux 的屏局部坐标混淆。
- 新增 `parseMonitorJson` / `selectScreen` / `captureArea` 纯函数与单测
  （在 Linux 上即可运行，不需要 Windows/PowerShell）；Windows 回归测试同步更新。
- 注：本机没有 Windows，Windows 侧只做了静态与纯函数验证；首次真机使用请先跑一次
  `computer {action:"inputcheck"}` 和一张截图确认。

## 1.5.0 — 2026-11-16

- **会话视图「桌面」tab（Web 端）**：新增 `client.js`（宿主为生成的 `client.web.js`），注册
  `conversation.view`（id `computer-use`，order 20，label 走 locale「桌面/Desktop」）与
  `tool.call.toolview` 卡片（`computer_screenshot` / `computer` / 旧记录 `computer_input`）。
  视图从 `@local/dsh-session-capabilities` 迁移：轮次分组、筛选、截图放大、点击红框标注、
  pause/急停/审计状态条，行为保持一致。
- **tab 内会话级开关（默认关）**：视图顶部一条「本会话未开启电脑操作」+ 开关，状态读写
  `GET/POST /api/computer-use/capability`；开启后工具在智能体下一步即可用，关闭即移除。
  写的是与 MCP/技能管理器共用的 `~/.dsh/capability-toggles.json`，schema 保持
  `{version:1, sessions:{<id>:{computerUse:true}}}`，只改本会话 `computerUse` 一个字段，
  保留其他会话/字段，tmp+rename 原子写。
- `package.json`：1.5.0；`exports["./client"]` → 生成产物 `client.web.js`；新增
  `dsh.client`（platform web、immediately、inject `@deepseek-ai/dsh-client-locale`）。
  `client.js` 是 ESM 源，Web 加载器不执行 ESM，故用 `scripts/build-client.mjs`（prepack）
  生成工厂形式的 `client.web.js`。

## 1.4.0 — 2026-11-15

- **环境自适应（自动检测桌面）**：`inputcheck` 的 `check.environment` 现在报告平台、会话类型、
  `DISPLAY` / `WAYLAND_DISPLAY`、桌面（`XDG_CURRENT_DESKTOP`）与会话 id、依赖二进制是否存在
  及缺失时的安装提示、`python3` 版本与 `Xlib`/`Gtk3` 模块、以及当前显示器布局（含 DPI）和
  稳定的 `layout.signature`。缺 `python3-Xlib`/`Gtk3` 只降级热键/剪贴板输入并给 warning，
  不再等到第一次用热键或输入中文时才发现。
- **屏幕自动探测**：枚举显示器时同时读 `xrandr --listmonitors`（像素几何）与
  `xrandr --query`（物理尺寸、旋转），屏幕对象新增 `dpi`（按实际旋转方向计算）与
  `rotation`（非 normal 时）；布局每次现查，支持热插拔/换屏/旋转，不再假设固定分辨率。
  `--query` 失败只丢 DPI 提示，不影响截图与坐标。
- `computer_screenshot` 的 `screen` 新增 `"auto"`（缺省语义：主屏，没有主屏时面积最大屏）
  与 `"cursor"`（指针所在屏，按指针判断，越界时回退 auto）；未知 id 的报错列出当前检测到的
  全部显示器及几何。`pickScreen`/`layoutSignature`/`parseOutputFacts`/`enrichScreens` 均可单测。
- **锁屏诊断修正**：锁屏时 `inputcheck` 不再把“没有前台窗口”算作输入链路故障，而是
  healthy + `locked: true` + 明确指引（锁屏时注入会被丢弃，先让用户解锁）。
- Wayland 拒绝理由更精确：区分纯 Wayland、XWayland（`DISPLAY` 存在但只能覆盖 X 客户端）、
  以及只有 `WAYLAND_DISPLAY` 没有 `DISPLAY` 的情况。
- 测试：`backends/selftest.mjs` 新增 `parseOutputFacts` / `enrichScreens` / DPI / 旋转 /
  `auto` / `cursor` / `layoutSignature` / 未知屏报错用例，49 → 68 项。

## 1.3.3 — 2026-11-10

- `inputcheck` 的指针探测更健壮：读回失败时最多重试 3 次、允许 1px 容差，并报告尝试次数。
  真实桌面上用户/其它客户端同时移动鼠标时，单次探测会误报“输入链路不可用”。

## 1.3.2 — 2026-11-10

- `inputcheck` 不再把缺少 `xclip` 当作警告：文本输入（含中文）已走内置 GTK 剪贴板 helper，
  `xclip` 只保留在诊断字段里（`tools.xclip`），不影响输入链路。
- 端到端测试相应改为“无 xclip 也健康”。

## 1.3.1 — 2026-11-10

- 仅文档：新增 `CHANGELOG.md`、`docs/demo-2026-11-10-baidu-news.md`，工作区入口
  `../COMPUTER-USE-HANDOFF.md`；`README-DEV.md` 增加“交接与索引”；`package.json` 的
  `files` 纳入 `CHANGELOG.md` 与 `docs/`。

## 1.3.0 — 2026-11-10

- **`type` 改为剪贴板粘贴**（对模型仍是黑箱 `type` 语义）：
  - 新增 `backends/clipboard.py`（python3-GTK3）：`set <base64> [hold]` 成为 CLIPBOARD owner 并
    serve 请求；`get [timeout]` 读取剪贴板；
  - 流程：读旧剪贴板 → own 新文本 → `Ctrl+V` → 恢复旧剪贴板（起一个后台 owner 持有原内容）；
  - 目的：绕开 XIM/ibus。中文输入法激活时 XTest 按键会被合成成拼音候选、吞掉点号（`www.baidu.com`
    → `wwwbaiducom`）；
  - 回退：helper 不可用时 ASCII 走 raw keys 并返回 warning，CJK 直接 `clipboard_unavailable`；
  - `inputcheck.check.clipboard` + warnings 报告 helper 可用性。
- **截图 `region` / `scale`**：`computer_screenshot` 可只返回局部/缩放图，减少模型图像上下文；
  观测令牌仍绑定整屏（指纹不变），`originX/originY` 为裁剪区绝对原点，动作用屏局部坐标。
- **DSH 拦截改为目标级**：键盘动作（type/key）在 DSH 前台时拒绝；指针动作（click/drag/scroll）
  只在落点窗口是 DSH 时拒绝；`move` 不受限。这样用户在 DSH 里看对话时，自动化仍可操作其它
  窗口/屏幕。Windows 保持原来的“前台是 DSH 就挡激活类动作”。
- **观测令牌 TTL 可配置**：`policy.json#observationTtlMs` 或 `DSH_COMPUTER_USE_OBSERVATION_TTL_MS`，
  默认 120s → 180s（范围 5s–30min）。
- 工具描述补充“intent 避免审批类动词”的提示。
- backends/selftest 增加 PNG 缩放用例；tests 增加 region/scale/clipboard 用例，端到端 78 项。
- 文档：README-DEV、CONTRACT、工作区 `COMPUTER-USE-HANDOFF.md`、本 CHANGELOG、demo 记录。

## 1.2.1 — 2026-11-10

- 修复 Linux `inputcheck` 输出违反工具 schema：`check.staging` / `check.integrity` 在 X11 上
  改为**缺省**（不适用），不再填空 `null`（schema 要求 object）。
- 端到端测试新增**工具输出 schema 校验器**（type/required/properties/additionalProperties/items），
  与宿主校验规则对齐，避免同类问题只在线上暴露。

## 1.2.0 — 2026-11-10

- **锁屏检测**：logind `LockedHint` / GNOME ScreenSaver DBus / 常见锁屏窗口类三路探测；锁屏时
  拒绝注入，`inputcheck` 跳过指针探测并报告 `locked`/`lockSource`。
- **X11 全局急停热键**：新增 `backends/x11-hotkey.py`（python3-Xlib XGrabKey，含 Lock/NumLock
  变体；主 `Ctrl+Alt+Shift+Q`，备用 `Ctrl+Alt+Shift+F12`）。BadAccess 时同步降级到备用组合；
  helper 起不来时降级为仅 UI 暂停。
- **负原点显示器布局**：`scrot -a` 无法表达负坐标 → 改为“截根窗口 + Node 裁剪/编码”；根窗口
  覆盖不到时明确报错。
- **指纹为空时回退**：前台窗口不在观察屏上时使用整屏 8×8 指纹（`fingerprintTarget: screen`）。
- **指针操作串行化**：`inputcheck` 指针探测与 dispatch 共用指针队列，避免并发抢指针。
- 热键候选禁止 `Ctrl+Alt+F1..F12`（X.org VT 切换组合，会黑屏）。

## 1.1.1 — 2026-11-10

独立审阅后的加固：

- 注入点二次读 pause（覆盖审批弹窗/像素复核期间用户按暂停的时间窗）；`inputcheck` 暂停时不注入指针。
- `validate()` 增加观察屏边界拒绝；`dispatch()` 下发前再校验。
- `prove()` 每次重新枚举显示器并要求 id/几何一致（布局变化 → `stale_observation (layout)`）。
- 落点窗口身份不可读时 fail closed（`window_unidentified`；xprop 失败 → `window_probe_failed`）。
- Wayland / `DISPLAY` 为空时选后端阶段 fail closed。
- `wait` 的后续截图沿用会话最新观察屏，不再默默切回主屏。
- 单动作派发规范化后的 `plan.args`（字符串 `delta` 不再反向滚动）。
- 拖拽读回终点（`drag_unstable`）；按键别名与 Windows 对齐（`ArrowUp` 等、允许单独修饰键）。
- 缺 `xclip` 降级为 warning；`scrot` 自检临时文件名加随机后缀；`toolPresent` 改用 `sh -c`。
- Windows status payload 去掉 `backend` 字段（仅 Linux 返回），恢复 1.0.1 形状。

## 1.1.0 — 2026-11-10

- Linux/X11 后端接入工具层：`backends/index.mjs` 平台选择 + `backends/linux-adapter.mjs` 接线。
- `computer_screenshot { screen }`、返回 `screen`/`screens`；每屏单屏截图、屏局部坐标、换屏校验。
- 新增 `windowAtCursor()`（落点窗口身份）；`warpTo()` 在指针已在目标位置时直接返回
  （`xdotool mousemove --sync` 同坐标不产生运动事件，会挂到超时）。
- `package.json` 版本 1.1.0、files 加入 `backends`。

## 1.0.1（基线，Windows）

- 工具层：观测令牌、意图/风险/审批、审计、pause、status/shot 路由、provider slot 共存。
- Windows 实现：PowerShell 5.1 + C# P/Invoke（`SendInput`）、`%LOCALAPPDATA%` helper staging、
  全局急停热键 watcher、`inputcheck`（完整性/锁屏/派发确认/指针漂移）。
- `backends/`：Linux/X11 原语（未接线）、契约文档、离线自检、真机冒烟。

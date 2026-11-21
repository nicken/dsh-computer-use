# dsh-computer-use — 开发说明（Linux/X11 接线版）

> 版本号以 `package.json` 为准，变更见 `CHANGELOG.md`；本文不再写死版本，避免文档漂移。

`@local/dsh-computer-use` 原先是 Windows 原生插件（PowerShell 5.1 + C# `SendInput`）。
1.1.0 起把 Linux/X11 后端接进**同一套工具面**（`computer_screenshot` / `computer`），
Windows 原生路径自 1.6.0 起抽到 `backends/win32.mjs`，行为（输入、令牌、审批）保持不变。之后的演进：

- 1.2.x：锁屏检测、X11 全局急停热键、负原点显示器布局、指纹回退、指针操作串行化；
- 1.3.x：`type` 改为剪贴板粘贴（绕开 XIM/ibus）、截图 `region`/`scale`、目标级 DSH 拦截、
  观测令牌 TTL 可配置；
- 1.4.0：**环境自适应** —— 会话类型、显示器布局（含 DPI/旋转）、依赖与 Python helper
  全部运行时探测，不再假设固定机型（详见下节）。

⚠️ 热键候选**永远不要**用 `Ctrl+Alt+F1..F12`：那是 X.org 内置的 VT 切换组合，
未被 grab 拦截时会切走显示（黑屏）。代码里只保留带 Shift 的组合。

## 交接与索引

- 工作区入口文档（推荐先读）：`../COMPUTER-USE-HANDOFF.md`
- 版本变更：`CHANGELOG.md`
- 真机验证记录：`docs/demo-2026-11-10-baidu-news.md`
- 后端契约与不变量：`backends/CONTRACT.md`

## 目录

```
index.js                     工具层 + 观测令牌 + 意图/风险/审批 + 审计 + pause
                             （Windows 的 PowerShell/C# helper 在 backends/win32.mjs）
                             + 会话能力开关路由 /api/computer-use/capability（1.5.0）
client.js                    Web 端「桌面」视图的 ESM 源（conversation.view + 工具卡片
                             + 会话内开关；Node 可直接 import 做检查）
client.web.js                由 scripts/build-client.mjs 从 client.js 生成的浏览器产物
                             （window.__ModuleLoader__.load 工厂形式，Web 加载器只认这种）
scripts/build-client.mjs     生成 client.web.js；npm run build:client / prepack 自动跑
locale/{zh,en}.json          插件元数据 + 视图/开关文案镜像（权威副本在 client.js 字典）
backends/index.mjs           平台选择：win32 -> windows-native, linux -> linux-x11, 其他 -> unsupported
backends/win32.mjs           Windows 原语：C# P/Invoke 源码、PowerShell 暂存执行、显示器枚举、单屏/region/scale 截图
backends/linux-x11.mjs       X11 原语：布局/DPI 探测、单屏截图、PNG 编解码/裁剪/缩放、指纹、输入注入
backends/linux-adapter.mjs   接线层：capture / validate / prove / guard / dispatch / inputCheck
backends/x11-hotkey.py       X11 全局急停热键 watcher（python3-Xlib；无它则自动降级）
backends/clipboard.py        X11 剪贴板 helper（python3-GTK；type 的粘贴通道，含恢复原剪贴板）
backends/CONTRACT.md         工具层契约与不变量（中文）
backends/selftest.mjs        X11 原语的离线自检（无 X11 也能跑）
backends/smoke-linux.mjs     真机冒烟（默认只截屏/移指针并复位）
tests/adapter-selftest.mjs    接线层纯参数校验自检（边界/别名/序列）
tests/windows-mode-selftest.mjs  win32 模拟回归 + win32 纯函数（无需 Windows）
tests/linux-integration.mjs   用 fake Cordis ctx 挂载 index.js 的真机端到端（安全默认）
```

## 环境自适应（1.4.0+）

“通用”体现在**不信任任何一台上位机的假设**，每一步都先探测再决定：

| 探测项 | 来源 | 用在哪里 |
|---|---|---|
| 会话/平台 | `XDG_SESSION_TYPE`、`DISPLAY`、`WAYLAND_DISPLAY`、`XDG_CURRENT_DESKTOP` | 后端选择（Wayland/XWayland 拒绝并说明原因）、`inputcheck.check.environment` |
| 显示器布局 | 每次 `xrandr --listmonitors` + `xrandr --query` | 截图的 `screen`/`screens`；`dpi`（按实际旋转方向算）、`rotation`、`layout.signature`；热插拔/旋转即时生效 |
| 默认屏 | 主屏 → 无主屏时面积最大屏 | 省略 `screen` 时；`screen:"cursor"` 跟随指针，越界回退 |
| 依赖二进制 | `command -v` 探测 5 个必需 + 3 个可选 | 缺必需项 → `problems` + 安装提示；`xclip` 只是诊断项（输入已走 GTK helper） |
| Python helper | `python3 -c` 探测版本、`Xlib`、`Gtk3` | 缺失只降级热键/剪贴板输入并给 warning，不阻塞截图与常规输入 |
| 锁屏状态 | logind `LockedHint`、GNOME DBus、锁屏窗口类 | 锁屏时 `inputcheck` 报 healthy + `locked:true`，动作拒绝注入 |

`--query` 解析失败只会丢 DPI 提示，不影响几何与坐标；未知显示器 id 的报错会列出当前
检测到的全部显示器（id、分辨率、原点），方便模型换名重试。

## 运行原理（Linux）

1. 工具层校验 `state_id`（一次性观测令牌）、`intent`、风险等级与审批，非法调用在
   提交令牌之前就被拒绝，因此拿回同一个令牌可以重试。
2. `computer_screenshot` 截**一块**显示器（省略/`auto` → 主屏；`cursor` → 指针所在屏；
   也可用 id 或 index），同时返回屏局部几何、`screen`/`screens`（含 dpi）、前台窗口与
   8×8 像素指纹，铸造新令牌。
3. 动作坐标是**观测屏的局部坐标**；adapter 加 `screen.x/y` 后注入，并由 `warpTo`
   读回校验指针落点（失败 `pointer_warp_unstable`，不盲点）。
4. 下发前 `prove()` 重新枚举显示器布局、读取前台窗口句柄/边界，并只截窗口矩形重算
   指纹，任一不符即 `stale_observation`；注入点再读一次 pause 文件（覆盖审批/复核
   期间按暂停的时间窗）；激活动作遇到 DSH 前台、或落点窗口是 DSH/身份不可读时拒绝
   （`dsh_window_blocked` / `window_unidentified`）。
5. 动作后自动再截一张同屏截图并铸新令牌，模型可以“观察 → 动作 → 观察”。
6. `pause` 写 pause 文件，所有输入在文件存在时直接拒绝（含 `inputcheck` 的指针探测）；
   只有用户经 status 路由（或 UI 的“恢复桌面操作”）能清除。X11 下另有 python3-Xlib
   的全局急停热键（主 `Ctrl+Alt+Shift+Q`，备用 `Ctrl+Alt+Shift+F12`），helper 不可用时
   如实降级为“仅 UI/pause”，状态在 `inputcheck.check.brake` 与 `/api/computer-use/status` 可见。
7. 越界坐标在 `validate()` 阶段即拒绝（加偏移后会落到另一块屏上）；`wait` 的后续截图
   沿用会话当前观察屏。
8. 负原点布局（副屏在左侧/上方）：`scrot -a` 不能表达负坐标，改为“截根窗口 + 纯 Node
   裁剪/编码”，根窗口覆盖不到时明确报错，不会静默截错屏。

## 测试

```bash
node backends/selftest.mjs             # X11 原语 + 布局/DPI + PNG 编解码/裁剪/缩放（离线）
node tests/adapter-selftest.mjs        # 参数校验/边界（离线）
node tests/windows-mode-selftest.mjs   # win32 模拟回归（离线）
node tests/linux-integration.mjs       # 真机端到端（默认只截图/移指针/pause；注入点击打字需 --click-at/--type）
node backends/smoke-linux.mjs          # 真机冒烟
```

端到端测试在 DSH 窗口处于前台时会自动跳过 sequence/click/type 相关检查（激活类动作
被前端安全策略拒绝，属设计行为）；此时会把对应项打印为 SKIP 而不是失败。
**跑 e2e 前确认会话未锁屏**：锁屏时没有前台窗口，与输入链路无关的检查也会失败。

集成测试会把 `DSH_HOME` 重定向到 `.e2e-dsh-home/`（跑完删除），截图/审计/pause
全部落在里面，不碰真实 `~/.dsh`。它直接 `import('../index.js')` 并在 fake ctx 上
调用 `apply()`，所以**不需要重启 DSH** 也能验证接线。

## 安装到 profile / 开发挂载

当前线上 profile（`~/.dsh/profiles/web`）用的是**开发挂载**：

```json
"@local/dsh-computer-use": "link:/home/nicken/Documents/deepseek-harness/default-workspace/projects/dsh-computer-use"
```

`package.json` 的 `dsh.profile.bundles` 里也有它，插件自带的 `cordis.patch.yml` 负责把
`computer-use` 条目插进组合树（profile 自己的 `cordis.patch.yml` 不需要再写）。

- **改代码后**：触发一次 profile 重组让 dsh-hmr 替换已变化的文件，例如
  `echo '# hmr reload' >> ~/.dsh/profiles/web/cordis.patch.yml`（写 `~/.dsh` 需要宿主权限）；
  新装/卸载插件、改组合或 HMR 把插件标成 `failed` 时才重启 `dsh web`。
- **新增文件**（例如新的 `backends/*.mjs`）能否被 HMR 接上不保证，新增后建议重启一次。

回滚：把 profile 依赖改回 1.0.1 快照
`file:~/.dsh/dsh-config-manager/local-plugins/@local__dsh-computer-use-1.0.1.tgz`，
`pnpm install --offline` 后重启；或按 `~/.dsh/profiles/web/package.json.bak-20261110-113131` 恢复。

## 发布包

```bash
cd dsh-computer-use
# 先 bump package.json 的 version 并补 CHANGELOG
npm_config_cache="$PWD/.npm-cache" npm_config_logs_dir="$PWD/.npm-logs" npm pack
# 产出 local-dsh-computer-use-<ver>.tgz，重命名为 @local__dsh-computer-use-<ver>.tgz
sha256sum @local__dsh-computer-use-<ver>.tgz   # 校验值现查，不写死在文档里
```

## 已知限制

- **Wayland 不支持**：没有全局输入注入与全局前台窗口；XWayland（`DISPLAY` 存在）也只覆盖
  X 客户端，后端会明确拒绝并说明是哪一种情况。
- 多屏时一次只截一块屏；换屏必须重新截图（令牌绑定屏）。
- 全局急停热键需要 `python3` + `Xlib`；缺了只保留 UI/`pause` 暂停，`inputcheck` 会 warning。
  中文输入需要 `python3-GTK3`；缺了回退 raw keys（ASCII）或报 `clipboard_unavailable`。
- 锁屏探测是 best-effort（logind/DBus/锁屏窗口），探不到时按“未锁”处理，不阻塞动作。
- `sequence` 逐步重采样指纹（~200ms/步），20 步批处理会有数秒复核开销。
- 剪贴板恢复边界：超长/二进制剪贴板、系统剪贴板管理器、helper 生命周期（600s 后自然退出）
  仍可加固。
- **Windows 坐标系与 Linux 不同**：Windows 的动作坐标是**桌面全局坐标**，截图只返回
  `originX/originY`；模型必须把“图上位置 + origin”算成全局坐标。Linux 则是屏局部坐标。
- Windows 侧（1.6.0）已支持单屏 / `screen:"all"` / `region` / `scale`，但本机没有 Windows，
  只做了静态与纯函数验证，**未在真实 Windows 上跑过 PowerShell**；首次实机使用先跑
  `inputcheck` + 一张截图。动作/自检/急停的 PowerShell 脚本仍在 `index.js`，尚未抽入
  `backends/win32.mjs`（见 CONTRACT.md §4）。
- 布局/DPI/旋转/热插拔已在 1.4.0 覆盖，但多屏组合只在部分真实布局上验证过；换环境后
  建议先跑一次 `inputcheck`。

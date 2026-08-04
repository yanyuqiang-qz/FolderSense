# 文件夹管家 FolderSense

> 帮助英文不熟练的用户 **看懂并管理本地文件夹** 的跨平台桌面应用。
> 中文优先、界面简洁、完全离线可运行，AI 打标签时可选择任意兼容 OpenAI 的服务。

---

## 1. 它解决什么问题

很多用户面对一堆英文命名的文件夹（如 `node_modules`、`build`、`assets`、`dist`、`public`）时不知道里面是什么、能不能删。
FolderSense 通过 **扫描文件夹结构 + AI 语义理解**，为每个文件夹生成一句中文用途说明和若干中文标签，
并允许用户手动补充标签与备注、按标签检索，从而把“看不懂的文件夹”变成“可理解、可分类、可管理”的资产。

五大核心能力：

| 能力 | 说明 |
| --- | --- |
| 文件系统浏览 | 树形 / 列表两种视图，懒加载展开，支持搜索、排序、类型过滤；针对大目录做了性能优化 |
| AI 自动标签 | 调用兼容 OpenAI 的接口，依据“文件夹画像”生成中文用途说明 + 多个语义标签 + 置信度；支持单/批量、重新生成；无 Key 时本地规则兜底 |
| 用户自定义标签 | 手动增删改标签与备注，可“覆盖”AI 结果；支持标签颜色、分类、按标签组合检索 |
| 本地数据存储 | 标签、备注、扫描索引全部本地持久化；文件夹被移动 / 重命名后，标签通过指纹自动重连 |
| 设置 | AI 服务配置（Key / 模型 / 预设）、扫描范围与排除目录、语言与主题、隐私开关 |

---

## 2. 技术选型（为什么这么选）

| 选型 | 理由 |
| --- | --- |
| **Electron 43.x** | 一套代码同时覆盖 Windows / macOS / Linux；复用成熟的前端技术栈；**零原生依赖**，避免 `node-gyp` 编译在不同机器上的坑；主进程 / 预加载 / 渲染进程三层隔离，安全边界清晰 |
| **主进程纯 Node.js** | 仅用 `fs`、`worker_threads`、`crypto` 与 JSON 持久化，不引入重型数据库，部署简单、故障面小 |
| **渲染进程原生 JS + CSS** | 不依赖前端框架，体积小、可离线、易维护；虚拟滚动（windowed rendering）自实现，避免引入大依赖 |
| **懒加载 + LRU 缓存 + mtime 增量** | 目录只在展开时 `readdir`；以目录 `mtime` 作为缓存版本号，未变化的目录直接命中内存；增量索引只重读“变化过”的目录，整盘扫描也不卡 |
| **文件夹指纹（结构哈希 + inode）** | 指纹由“子项名称集合 + 数量”决定、与路径无关，配合 inode 做强匹配，实现移动 / 重命名后标签自动重连 |
| **OpenAI 兼容 API + 本地启发式兜底** | 用户可用任意兼容服务（OpenAI / DeepSeek / 通义千问 / GLM / Kimi / 本地 Ollama）；未配置 Key 时自动降级为本地规则，完全离线可用 |
| **contextIsolation + 关闭 nodeIntegration + 预加载白名单 + CSP** | 渲染进程完全没有 Node 能力，只能通过白名单里的方法与主进程通信，杜绝任意代码执行 |

> 关于“为什么要 Electron 而不是纯 Web / Tauri”：本应用需要直接、递归地读取用户本地磁盘（含大目录、隐藏目录、排除目录），
> 浏览器沙箱无法做到；Tauri 需要 Rust 工具链与系统原生编译，跨机器构建门槛高。Electron 在“能力强 + 跨平台 + 零原生编译”之间取得了最平衡的点。

---

## 3. 项目结构

```
folder-sense/
├── package.json              # 应用元信息、脚本、electron-builder 打包配置
├── electron/                 # 主进程（Node.js 侧）
│   ├── main.js               # 启动、窗口创建、单实例锁、退出前数据落盘、权限拒绝
│   ├── preload.js            # 安全桥接：把白名单方法暴露为 window.api（渲染进程无 Node 能力）
│   ├── ipc.js                # 所有 IPC 路由（参数校验、调用核心模块、统一返回 {ok,data}）
│   └── core/                 # 内核（全部为纯 Node，不依赖 Electron，可独立测试）
│       ├── jsonStore.js     # 原子写入 JSON 持久层（临时文件 + rename + .bak 备份 + 防抖）
│       ├── paths.js         # 数据目录定位（系统 userData/data），不污染被扫描磁盘
│       ├── settings.js      # 设置管理：API Key 用 safeStorage 加密、隐私默认值、脱敏视图
│       ├── fileTypes.js     # 扩展名 → 大类映射、特征文件识别（如 package.json→Node 项目）
│       ├── scanner.js       # 文件系统内核：懒加载 / LRU / 排序过滤 / 画像 / 指纹
│       ├── indexWorker.js   # worker_threads 后台增量索引
│       ├── indexer.js       # 索引驱动器：调度 worker、持久化、搜索
│       ├── library.js       # 标签注册表 + 文件夹注记（AI 结果 / 用户标签 / 覆盖 / 重连）
│       ├── ai.js            # AI 打标签：隐私载荷构造、远程调用、本地启发式、审计日志
│       ├── tagJob.js        # 批量打标签任务（并发控制、取消、进度上报）
│       └── relink.js        # 移动 / 重命名后的标签自动重连（阈值 AUTO 0.9 / SUGGEST 0.5）
└── renderer/                # 渲染进程（前端，原生 JS + CSS）
    ├── index.html           # 布局 + 内联 SVG 图标 + CSP
    ├── styles/main.css      # 深色 / 浅色主题变量与完整界面样式
    └── js/
        ├── util.js          # 通用工具（DOM、图标、时间、尺寸、剪贴板、标签样式…）
        ├── i18n.js          # 中 / 英 文案字典与切换
        ├── state.js         # 全局状态（设置、标签、当前视图、选中项…）
        ├── explorer.js      # 虚拟滚动的树 / 列表视图、批量操作、右键菜单
        ├── detail.js        # 右侧详情：用途说明、置信度、标签编辑、备注、审计预览
        ├── tagsview.js      # 标签云、按标签检索、失效路径检查
        ├── settings.js      # 设置界面（AI 预设、隐私、扫描范围、审计日志）
        └── app.js           # 启动编排、事件订阅、全局搜索、快捷键
```

---

## 4. 数据模型

所有数据存放在系统标准用户数据目录下的 `data/`（Windows 通常为
`%APPDATA%/文件夹管家 FolderSense/data/`，macOS 为 `~/Library/Application Support/文件夹管家 FolderSense/data/`），
**绝不写入被扫描的磁盘**，避免污染用户文件。

### 4.1 `settings.json` — 设置
```jsonc
{
  "ui":        { "language": "zh-CN", "theme": "dark", "showHiddenFiles": false, "defaultSort": "name-asc" },
  "scan":      { "roots": [], "excludeNames": ["node_modules",".git",...], "excludeKeywords": [],
                "maxDepth": 6, "maxEntriesPerDir": 8000, "maxIndexEntries": 200000,
                "followSymlinks": false, "autoScanOnStart": false },
  "ai":        { "enabled": true, "baseUrl": "https://api.openai.com/v1",
                "apiKeyEnc": "<base64 密文>", "apiKeyPlain": "",
                "model": "gpt-4o-mini", "temperature": 0.2, "timeoutMs": 60000,
                "concurrency": 2, "tagCount": 5, "maxSampleFiles": 40,
                "sendFileNames": true,    // 发送采样文件名（帮助判断用途）
                "sendFullPath": false,    // 发送完整绝对路径（默认关闭）
                "readFileContent": false },// 读取文件内容（默认永久关闭）
  "privacy":   { "auditLog": true }       // 记录每次 AI 请求的元信息，可审计
}
```
> API Key 只会以 **加密** 形式存入 `apiKeyEnc`；当系统加密不可用（如某些 Linux 无桌面环境）时降级为明文 `apiKeyPlain`，并在界面明确提示风险。

### 4.2 `tags.json` — 标签注册表
```jsonc
{
  "version": 1,
  "categories": [ { "id": "purpose", "name": "用途" }, /* 用途 / 项目 / 内容类型 / 状态 / 其它 */ ],
  "items": [
    { "id": "t_xxx", "name": "照片", "color": "#e05561", "category": "content",
      "source": "ai",        // ai 自动生成 | user 手动添加
      "createdAt": 1700000000000 }
  ]
}
```
AI 产出的标签会自动登记进注册表，因此 AI 标签与手动标签共用同一套颜色 / 分类 / 过滤逻辑。

### 4.3 `annotations.json` — 文件夹注记（核心关联）
以 **文件夹绝对路径** 为 key：
```jsonc
{
  "version": 1,
  "items": {
    "C:\\Users\\me\\Pictures\\Trip": {
      "path": "C:\\Users\\me\\Pictures\\Trip",
      "name": "Trip",
      "aiSummary": "存放旅行照片的文件夹",   // AI 生成的用途说明
      "aiTagIds": ["t_1", "t_2"],            // AI 给出的标签
      "aiConfidence": 0.85,                  // 置信度 0~1
      "aiModel": "gpt-4o-mini",
      "aiSource": "remote",                  // remote | local（本地规则兜底）
      "aiReason": "以图片文件为主",
      "removedAiTagIds": [],                 // 用户“否决”的 AI 标签（重新生成不会再加回）
      "userTagIds": ["t_9"],                 // 用户手动添加的标签
      "summaryOverride": "",                 // 用户覆盖的说明（优先于 aiSummary 显示）
      "note": "2024 春节全家出游",            // 用户备注
      "fingerprint": {                       // 用于移动 / 重命名后重连
        "structure": "<sha1 结构哈希>", "inode": "12345:678",
        "childCount": 12, "birthtimeMs": 1700000000000, "sampleNames": ["a.jpg","b.jpg"]
      },
      "status": "ok",                        // ok | missing（原路径已不存在）
      "history": [ { "from": "旧路径", "to": "新路径", "at": 0, "method": "auto" } ],
      "updatedAt": 1700000000000
    }
  }
}
```
**覆盖语义**：用户对某个 AI 标签点“移除”，不是删除，而是记入 `removedAiTagIds`；
重新生成 AI 结果时这些被否决的标签不会复活，用户也可一键“恢复 AI 标签”。

### 4.4 `index.json` — 增量索引
记录被扫描目录的 `路径 / mtime / 直接子项`，供“按名称找目录”和失效路径重连使用。
增量扫描时只对 `mtime` 变化的目录重新读取，未变化的目录直接复用。

### 4.5 `ai-audit.log` — AI 请求审计
每行一条 JSON：`时间、文件夹、模式(remote/local)、接口地址、模型、发送字节数、是否发送文件名/完整路径/文件内容、耗时`。
**用户随时可在“设置 → 隐私”里查看到底发给了 AI 什么，并可一键清空。**

---

## 5. 权限与隐私处理方案（重点）

### ❓ 是否会上传文件内容？
**不会。默认任何时候、任何情况下都不会读取或上传任何文件的内容。**

应用只把“**文件夹画像**”发给 AI，画像包含且仅包含：
- 文件夹名称、上级文件夹名称
- 子文件夹名称、扩展名分布（如 `.jpg×12`）、各类文件数量与总大小
- 可选的**采样文件名**（仅文件名，如 `index.js`、`readme.md`，不含内容）
- 识别到的特征文件（如存在 `package.json` 即视为 Node 项目）

### 隐私开关（都在 `设置 → AI / 隐私` 中可见、可改）
| 开关 | 默认值 | 含义 |
| --- | --- | --- |
| `readFileContent` | **关闭（永久）** | 读取文件内容的总开关，需手动开启；即便开启也**不会**发送内容 |
| `sendFileNames` | 开启 | 发送采样文件名（帮助 AI 更准确判断用途） |
| `sendFullPath` | **关闭** | 默认只发送文件夹名，避免泄露用户名 / 盘符 / 目录结构 |
| `privacy.auditLog` | 开启 | 每次 AI 请求都会写审计日志，用户可随时查看 / 清空 |

### 数据安全
- **API Key 加密存储**：使用系统钥匙串（`safeStorage` / Windows DPAPI / macOS Keychain）加密后落盘，明文不进 `settings.json`；渲染进程只拿到脱敏后的掩码（如 `sk-****7890`）。
- **数据全部本地**：标签、备注、索引、审计日志都写在本机用户数据目录，不上传任何服务器（除用户主动配置的 AI 接口外）。
- **不申请系统权限**：摄像头 / 麦克风 / 定位等权限请求一律拒绝。
- **网络最小面**：渲染进程 CSP 禁止任意 `connect-src`；主进程仅访问用户填写的 AI 接口地址。

---

## 6. 运行与构建

### 环境要求
- Node.js 18+（建议 20+；本项目开发期使用 Node 22 / 24 验证）
- Electron 43.x（**代码兼容 Electron 24+**，只使用了跨版本稳定的 API）
- 二进制在 `npm install` 时由 npm 镜像自动下载；具体版本以安装时解析到的为准

### 开发运行
```bash
npm install
npm start          # 普通启动（需要带显示器的桌面环境）
npm run dev        # 启动并自动打开 DevTools
```
> 说明：Electron 的运行时二进制在 `npm install` 阶段下载。本应用在编码上不依赖特定小版本，
> 在 Electron 24 与 43 上均可正常运行；在普通网络环境下 `npm install` 会拉取到与 `package.json`
> 中声明的 `^43.2.0` 一致的二进制。

### 打包发布（生成安装包）
`electron-builder` 已写入 `devDependencies`，`npm install` 后自带，无需单独安装。常用命令：
```bash
npm run dist:win    # Windows：NSIS 安装包 + 免安装便携版（portable）
npm run dist:mac    # macOS：dmg + zip
npm run dist:linux  # Linux：AppImage + deb
npm run dist        # 当前平台全部目标
```
产物位于 `dist/`：Windows 为 `dist/win-unpacked/`（解包目录）、`dist/*.exe`（便携版）与 NSIS 安装包；macOS/Linux 类似。

#### 关于代码签名
- **Windows / macOS 发行版需要代码签名证书**，否则用户安装 / 运行时会看到“未知发布者”警告。请在 CI 或本机配置 `CSC_LINK` / `CSC_KEY_PASSWORD`（macOS 也可使用钥匙串中的开发者身份）。
- **仅本地自测、不想签名**：关闭证书自动发现即可跳过签名，生成未签名的可执行文件：
  ```bash
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
  ```
- **`asar` 关闭是有意为之**：本应用用 `worker_threads` 跑后台增量索引，按绝对路径加载 `electron/core/indexWorker.js`；asar 归档内的文件无法被 worker 直接加载，故设置 `"asar": false`，确保 `resources/app/electron/core/indexWorker.js` 以真实文件落地、运行时可读。代价是启动略慢、目录略大，对本类工具影响可忽略。

---

## 6.1 CI/CD（GitHub Actions 自动出包）
仓库已内置 `.github/workflows/build.yml`：推送 `v*` tag（如 `v0.1.0`）即自动在 Windows / macOS / Ubuntu 三台 runner 上并行构建安装包，并汇总发布到 GitHub Release；手动触发（`workflow_dispatch`）则只上传 Actions 产物、不发布。

- **代码签名（可选）**：在仓库 `Settings → Secrets and variables → Actions` 配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 即可对 Win / macOS 包签名。不配置时，流水线默认 `CSC_IDENTITY_AUTO_DISCOVERY=false`，会构建**未签名**包而不报错。macOS 如需公证，再补充 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 并放开对应 `env`。
- **asar 已按应用需求关闭**（`worker_threads` 需按真实路径加载 `indexWorker.js`），流水线直接复用 `package.json` 的 `build` 配置，无需额外处理。
- 触发示例：
  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```

---

## 7. 验证情况

面向“无显示器的 CI / 沙箱”做了可在纯 Node 下运行的逻辑冒烟测试（不涉及 GUI），覆盖：

- **持久化**：`JsonStore` 原子写入、损坏文件从 `.bak` 恢复。
- **标签逻辑**：AI 结果与用户标签合并、对 AI 标签的“否决 / 恢复”覆盖语义、按标签组合检索、导出 / 导入合并。
- **扫描内核**：懒加载、隐藏文件过滤、目录优先排序、`Intl.Collator` 中文排序、类型过滤、查询过滤、文件夹画像、`mtime` 版本化 LRU 缓存、结构指纹与相似度评分。
- **AI 隐私载荷**：确认默认**不发送完整路径**、默认**发送采样文件名**、可选项可显式开启完整路径；无 Key 时本地启发式按文件类型给出合理标签。
- **移动 / 重命名重连**：移动后通过 inode / 结构指纹自动把标签接到新路径，并写入 `history`。
- **设置与隐私**：API Key 加密落盘、脱敏视图、隐私默认值（`readFileContent=false`、`sendFullPath=false`、`sendFileNames=true`、`auditLog=true`）。
- **进程间契约**：`preload.js` 的白名单与 `ipc.js` 注册的处理器 **一一对应**，无遗漏、无越权。
- **打包流水线（electron-builder）**：以本地 Electron 完成一次 `--dir` 未打包构建，确认 `asar` 关闭生效、`resources/app/electron/core/indexWorker.js` 等以真实文件落地、应用可执行文件生成成功（沙箱内因无代码签名证书而用 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名做验证）。

> 说明：GUI 窗口渲染需要在带显示器的桌面环境运行（`npm start`），沙箱无显示器无法启动窗口；
> 上述逻辑层已通过自动化验证，渲染层与进程间通信的契约已静态校验一致。

---

## 8. 已知限制与可扩展点

- 需要桌面环境才能使用 GUI（Electron 应用本质）。
- 整盘首次扫描仍受磁盘 IO 限制，已通过“增量 + 缓存 + 后台 worker”显著缓解。
- 本地启发式兜底仅依据文件类型分布，准确度低于真实 AI；建议配置 Key 以获得最佳体验。
- 可扩展：标签间关系（层级 / 同义）、跨设备同步（导入 / 导出已支持）、对文件内容的更细粒度本地摘要（需用户显式开启）。

---

## 许可证
MIT

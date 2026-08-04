# 发布指南（RELEASE.md）

本文件说明如何把 **文件夹管家 FolderSense** 推送到 GitHub 并通过 CI 自动出三平台安装包。
全流程分三块：**① 一次性准备（建仓库 + 推送代码）** → **② 可选：配置签名** → **③ 打 tag 出 Release（你来执行）**。

> 约定：`yanyuqiang/FolderSense` 是占位，请替换成你自己的 **GitHub 用户名 / 仓库名**。

---

## ① 一次性准备：建仓库并推送代码

### 1. 在 GitHub 网页上新建仓库
- 打开 <https://github.com/new>
- Repository name 填 `FolderSense`（随意）
- 选 **Public** 或 **Private** 均可
- **不要**勾选 “Add a README file / .gitignore / LICENSE”（本地已有，避免冲突）
- 点击 **Create repository**

### 2. 在本机项目目录关联远程仓库
在 `D:\Flodercode`（即本仓库根目录）执行：

```bash
# 把下面 URL 换成你刚建的仓库地址
git remote add origin https://github.com/yanyuqiang/FolderSense.git

# 确认 remote 已设置
git remote -v
```

### 3. 推送 main 分支
```bash
git push -u origin main
```
推送成功后，GitHub 仓库里就会出现完整源码（已含 `.github/workflows/build.yml`、`.gitignore`、`package.json` 等）。

---

## ②（可选）配置代码签名 Secret

不配也能出包，只是生成**未签名**安装包（Windows 上安装时会提示“未知发布者”，macOS 上需手动放行）。
配置后即为**已签名**包，体验更顺。

进入：**仓库 → Settings → Secrets and variables → Actions → Secrets → New repository secret**

| Secret 名 | 说明 | 是否必须 |
| --- | --- | --- |
| `CSC_LINK` | 证书文件（`.p12`）。填 **base64 字符串** 或 **可访问的文件 URL** | 可选 |
| `CSC_KEY_PASSWORD` | 证书导出密码 | 可选（配了 `CSC_LINK` 才需要） |
| `APPLE_ID` | Apple ID（仅 macOS 公证） | 可选 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 专用密码（仅 macOS 公证） | 可选 |
| `APPLE_TEAM_ID` | Apple 开发者团队 ID（仅 macOS 公证） | 可选 |

> 工作流已默认 `CSC_IDENTITY_AUTO_DISCOVERY=false`，所以**没配证书也不会报错**，只会出未签名包。

macOS 公证还需在 `.github/workflows/build.yml` 的 macOS 步骤里取消注释那三行 `APPLE_*` 的 env（见文件内注释）。

---

## ③ 打 tag 并发布（出 Win / macOS / Linux 三套包）

这一步由你执行。本质是打一个 `v*` 开头的 tag 并推送到 GitHub，CI 会自动：
1. 在 `windows-latest` / `macos-latest` / `ubuntu-latest` 三个 runner 上 `npm ci` + 打包；
2. 把产物汇总，创建一个 **GitHub Release** 并把安装包挂上去。

```bash
# 打标签（版本号按需修改，必须 v 开头）
git tag v0.1.0

# 推送 tag（注意：推 main 不会触发出包，必须推 tag）
git push origin v0.1.0
```

> 等价一行写法：`git tag v0.1.0 && git push origin v0.1.0`

---

## ④ 查看产物

- **构建日志**：仓库 → **Actions** → 选 `Build & Release` 工作流，能看到三个平台的构建步骤。
- **安装包**：仓库 → **Releases** → 找到 `v0.1.0`，里面有：
  - Windows：`FolderSense-Setup-0.1.0.exe`（NSIS 安装包）+ `FolderSense-0.1.0-portable.exe`（免安装便携版）
  - macOS：`FolderSense-0.1.0.dmg` + `FolderSense-0.1.0-mac.zip`
  - Linux：`FolderSense-0.1.0.AppImage` + `FolderSense-0.1.0.deb`

---

## ⑤ 常见问题

**Q：CI 拉到的是哪个 Electron 版本？**
A：CI 跑在 GitHub 标准 runner 上，`npm ci` 会按 `package.json` 的 `electron: ^43.2.0` 从官方源拉到正确的 **43.2.0**（不受本地沙箱镜像错位影响）。

**Q：没配证书能正常用吗？**
A：能。Windows 未签名包安装时会弹“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”即可；macOS 未签名 app 需在“系统设置 → 隐私与安全性”里点“仍要打开”。

**Q：只想本地试构建、不发布 Release？**
A：在仓库 → **Actions → Build & Release → Run workflow**（手动触发 `workflow_dispatch`），只会上传 Actions 产物、不会建 Release。

**Q：tag 打错了想重来？**
A：
```bash
git tag -d v0.1.0                 # 删本地 tag
git push origin :refs/tags/v0.1.0 # 删远程 tag
# 修正后重新打 tag 并推送
git tag v0.1.0 && git push origin v0.1.0
```

**Q：worker 加载报错（asar）？**
A：已在 `package.json` 关掉 `asar`（worker_threads 需按真实路径加载 `indexWorker.js`），CI 直接复用该配置，无需额外处理。

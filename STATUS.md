# 状态

| 项 | 值 |
| --- | --- |
| 最后更新 | 2026-09-18 |
| 当前阶段 | **Phase 0 · Host Capability Audit** |
| 插件版本 | 0.1.0 |
| 阶段结论 | 项目骨架已初始化；执行计划分析能力**尚未实现**，且按计划不得在审计完成前开工 |

## 1. 完成度速览

| 能力 | 状态 |
| --- | --- |
| 官方 Svelte + Vite 项目骨架 | ✅ 已初始化 |
| UI 构建（`npm run build`） | ✅ 通过 |
| 打包（`dbx-plugin package`） | ✅ 通过 |
| `dbx-plugin dev` 本地开发主机 | ⚠️ 可用，但 Windows 需绕过上游 bug（见第 4 节） |
| `manifest.json` 合法性 | ✅ 通过（对上游 `main` 分支真实 schema） |
| native backend（Rust / Go） | ❌ 不存在（符合 Thin Plugin 原则） |
| 数据库驱动依赖 | ❌ 不存在（符合禁止清单） |
| AI / LLM 依赖 | ❌ 不存在 |
| Execution Plan Parsing | ⛔ 未实现 |
| Plan Normalization | ⛔ 未实现 |
| Metrics Engine | ⛔ 未实现 |
| Hotspot Analysis | ⛔ 未实现 |
| Rule-based Diagnosis | ⛔ 未实现 |
| Findings + Evidence | ⛔ 未实现 |
| Plan Diff | ⛔ 未实现 |

> ⛔ 表示"按计划不应开始"，**不是**待办遗留。启动条件见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) 的 Phase 0 出口条件。

## 2. 本次初始化的实测验证记录

环境：Windows，Node.js v24.15.0，npm 11.12.1，`@dbx-app/plugin-cli@0.1.9`。

| # | 验证项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 安装依赖 | `npm install` | ✅ `added 37 packages`，`found 0 vulnerabilities` |
| 2 | UI 构建 | `npm run build` | ✅ `vite v7.3.6`，109 modules transformed，`built in 1.52s`，输出 `DBX_UI_BUILD_SUCCESS` |
| 3 | 打包 | `dbx-plugin package <project-abs-path>` | ✅ `dist/io.github.0verme.plan-detective-0.1.0-universal.dbxp`（14,351 bytes）+ `.artifact.json`（190 bytes），`unsigned review candidate` |
| 4 | 本地开发主机 | `dbx-plugin dev --path <project> --port 5193` | ⚠️ 移除 `[dev] ui_build`/`ui_watch` 后：`Plugin dev host: http://127.0.0.1:5193`，`GET / → HTTP 200`（172,406 bytes）。保留官方配置时在 Windows 失败（见 4.4） |
| 5 | manifest 合法性 | `ajv-cli validate --spec=draft2020 -s manifest.schema.json -d manifest.json` | ✅ `manifest.json valid`（schema 取自上游 `main` 分支） |
| 6 | 无 native backend | 查找 `Cargo.toml` / `go.mod` / `*.rs` / `*.go` | ✅ 无匹配 |
| 7 | 无数据库驱动 | 审计 `package.json` 与 `node_modules` 顶层 | ✅ 仅 `svelte`、`vite`、`@sveltejs/vite-plugin-svelte` 及其传递依赖 |

`ui/` 是**需要入库的构建产物**：上游 release workflow 不执行 `npm install` / `npm run build`，直接运行 `dbx-plugin package .`。实测在缺少 `ui/` 时打包报错：

```text
error: manifest UI entry 'ui/index.html' does not exist at ...\ui\index.html
```

因此不要将 `ui/` 加入 `.gitignore`。已在 `.pi-lens.json` 中把 `ui/**`、`dist/**` 排除出静态扫描，避免对压缩产物误报。

## 3. Host API 现状（文档级取证，待现场验证）

取证时间 2026-09-18，来源 `t8y2/dbx` 的 `main` 分支公开文档：

- 前端沙箱公开桥接方法为 `ready` / `context` / `locale` / `theme` / `request` / `invoke` / `notify` / `onInit` / `onContext` / `onEvent` / `onBinary` / `sendBinary` / `readAsset` / `readAssetUrl` / `openWorkbench` / `openFilesystem`。
- 公开的插件可回调宿主方法仅有 `host/requestUserInput`（Host API 1.1）。
- 公开 manifest 权限名称为 `host.events`、`host.binary`、`host.workbench`、`host.filesystem`、`host.network:<https origin>`。
- 上述公开 API 面中**没有** SQL 执行、EXPLAIN 或执行计划获取相关入口。
- 独立开发主机（`dbx-plugin dev`）明确说明不模拟 native connection actions、query-result contributions 与 DBX component kit。

**这是当前最重要的未决问题**：`dbx-plugin` 插件能否通过公开 Host API 取得执行计划，尚未得到证据支持。审计清单见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)。

按项目纪律，在证据明确前不自行实现数据库连接层或执行层。

## 4. 已知上游问题（已取证，未修复）

以下问题属于 `@dbx-app/plugin-cli` / 官方模板 / 上游仓库现状，**本次初始化未擅自修改**，等待决策。

### 4.1 `create` 不接受 `.` 相对路径（Windows 实测）

```text
$ dbx-plugin create . --template svelte ...
error: Project directory needs a UTF-8 name
```

- 实测：传绝对路径 `dbx-plugin create E:\...\<project> ...` 成功；传 `.` 必失败（纯 ASCII 参数与目录名同样失败，已排除编码因素）。
- 影响：官方文档给出的 `dbx-plugin create my-plugin` 类用法在 Windows 上不可用。
- 本次初始化绕过方式：使用绝对路径。

### 4.2 `manifest.json` 的 `$schema` 指向不存在的 ref

```text
https://raw.githubusercontent.com/t8y2/dbx/plugin-sdk-v1/plugins/manifest.schema.json
```

- 实测该 URL 返回 **404**。
- `plugin-sdk-v1` 在 `t8y2/dbx` 中**既不是分支也不是 tag**（API 查询均为 404）。
- `https://raw.githubusercontent.com/t8y2/dbx/main/plugins/manifest.schema.json` 返回 200，内容可正常校验本仓库 manifest。
- 影响：编辑器/校验器无法解析 manifest schema。未擅自改为 `main`。

### 4.3 发布 workflow 引用了不存在的 ref

`.github/workflows/plugin-release.yml`（官方模板原样生成）：

```yaml
uses: t8y2/dbx/.github/workflows/plugin-release-reusable.yml@plugin-sdk-v1
```

- `plugin-sdk-v1` ref 不存在（见 4.2），该 reusable workflow 在 `main` 上确实存在。
- 影响：发 release 时此 workflow 会因 ref 无法解析而失败。未擅自改为 `main`。

### 4.4 `dbx-plugin dev` 在 Windows 上无法执行 UI build 命令

配置 `[dev] ui_build = ["npm", "run", "build"]` 时：

```text
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported.  Defaulting to Windows directory.
Error: EISDIR: illegal operation on a directory, lstat 'E:'
Build failed (exit 1)
```

- 根因：dev runtime 把 canonicalize 得到的 verbatim 路径 `\\?\E:\...` 作为子进程 cwd 传给 `cmd.exe`，而 cmd 不支持 UNC 路径。dev 自身日志亦印证：`"project":"\\\\?\\E:\\vbcoding\\..."`。
- 实测绕过：移除 `[dev]` 的 `ui_build` / `ui_watch` 后，dev host 正常启动并服务已构建的 `ui/`（`GET / → HTTP 200`）。
- 现状：仓库保留官方模板默认配置（在 Linux / macOS 上正常），Windows 下需手动临时移除该段，或改用 WSL。

### 4.5 template README 的相对链接在独立仓库中失效

官方模板 README 使用 `../../../../GETTING_STARTED.zh-CN.md` 指向 DBX 主仓内文件，在独立插件仓库中为坏链接。本仓库 README 已改写为上游公开地址。

### 4.6 版本差异观察

模板生成的 workflow 固定 `plugin-cli-version: 0.1.6`，本次初始化使用 `0.1.9`（两者在 npm 上均存在）。如后续出现打包行为差异，需先核对 CLI 版本。

## 5. 待办

1. 完成 Phase 0 Host Capability Audit（清单见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)）。
2. 就第 4 节上游问题决定处理方式：本地修正 ref / 提 Issue 到 `t8y2/dbx` / 等待上游修复。
3. 审计结论明确后再规划 Phase 1。

## 6. 相关文档

- [README.md](README.md) —— 项目定位与开发方式
- [AGENTS.md](AGENTS.md) —— 仓库约束与红线
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构边界与职责划分
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) —— 决策记录、审计清单、Fixture 策略

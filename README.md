# 待办工作台

待办工作台是一款本地优先的桌面办公软件，用任务卡片管理待办，用进度时间线记录任务从提出到完成的全过程，并可一键生成周报、月报、季报和年报。

## 功能

- 可配置开机自动启动，使用 Electron 的系统登录项能力。
- 关闭主窗口时自动隐藏到系统托盘，任务与数据库连接保持运行；单击托盘图标即可恢复窗口，也可从右键菜单明确退出应用。
- 创建、编辑、筛选和删除待办任务，支持状态、优先级、需求人、负责人、协作人、起止日期与完成进度。
- 每次进度填报独立记录完成内容、记录时间、需求人、下一步事项和待对接人员。
- 在任务详情中按时间查看完整处理流程，历史填报不会被后续进度覆盖。
- 根据指定日期自动计算周、月、季度或年度范围并汇总工作记录。
- 报表支持 Markdown、HTML、PDF 导出，并可选择使用 OpenAI 兼容 API 润色。
- 默认使用本地 SQLite；可在设置中切换至 MySQL。
- MySQL 密码和模型 API Key 使用 Electron `safeStorage` 调用操作系统凭据保护能力加密后保存。

## 界面结构

- **工作概览**：任务统计、平均进度、近期动态和临近截止事项。
- **待办任务**：按状态、优先级和关键词筛选，点击卡片进入任务处理时间线。
- **工作汇报**：选择周期和日期，生成本地事实汇总；按需调用大模型润色并导出。
- **系统设置**：配置开机启动、SQLite/MySQL 和大模型接口。

## 技术架构

```text
Renderer（HTML / CSS / JavaScript）
          │ 仅允许调用白名单 API
          ▼
Preload（contextBridge，隔离上下文）
          │ Electron IPC
          ▼
Main Process
  ├─ 任务与进度服务
  ├─ 报表汇总 / AI 调用 / PDF 导出
  ├─ 开机登录项
  ├─ safeStorage 凭据加密
  └─ DatabaseManager
       ├─ SQLiteAdapter（默认，Node 内置 SQLite）
       └─ MySQLAdapter（mysql2）
```

渲染层启用了 `contextIsolation` 和 `sandbox`，并关闭 `nodeIntegration`。页面不能直接读取文件、访问数据库或取得凭据明文；所有能力都通过 `src/preload.cjs` 中的白名单接口进入主进程。

## 数据模型

`tasks` 保存任务当前状态：标题、说明、需求人、负责人、协作人、状态、优先级、完成进度、起止日期和完成时间。

`progress_entries` 保存不可覆盖的过程记录：所属任务、当时进度、本次完成内容、需求人、下一步、待沟通人员和发生时间。删除任务时，其进度记录会随外键级联删除。

## 本地开发

### 环境要求

- Node.js 22 或更高版本（测试脚本使用内置 `node:sqlite`）
- npm 10 或更高版本
- Windows 10/11（开机自启动和安装包主要按 Windows 验证）

### 安装与运行

```powershell
npm install
npm start
```

运行自动化测试和语法检查：

```powershell
npm run check
npm test
npm run smoke
```

构建 Windows 安装包：

```powershell
npm run dist
```

输出位于 `release/`。NSIS 安装器允许选择安装目录，并会创建桌面和开始菜单快捷方式。

## 数据库配置

### SQLite（默认）

SQLite 无需额外服务。路径留空时，数据库为 Electron 用户数据目录中的 `todo-workbench.db`。应用设置页底部会显示当前用户数据目录。需要备份时，退出应用后复制 `.db` 文件即可；如果目录中同时存在 `-wal` 或 `-shm` 文件，应一并复制。

也可以填写一个绝对路径，将数据库放到指定目录。应用会自动创建父目录和数据表。

### MySQL

先在 MySQL 8.x 中创建数据库，推荐使用 `utf8mb4`：

```sql
CREATE DATABASE todo_workbench
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

在“系统设置 → 数据存储”中填写主机、端口、数据库名、用户名和密码，先点击“测试数据库连接”，再保存设置。账号需要对目标数据库拥有建表及增删改查权限。

切换数据库只改变后续读写位置，不会自动迁移原数据库中的任务。切换前请自行备份；如需迁移，可分别导出并导入数据，或扩展 `DatabaseManager` 增加迁移流程。

## 大模型配置

应用支持两类 OpenAI 兼容端点：

- Chat Completions，例如 `https://api.openai.com/v1/chat/completions`
- Responses API，例如 `https://api.openai.com/v1/responses`

在设置中填写 API 地址、模型名和 API Key，点击“测试模型连接”验证后保存。启用后，报表页会出现可选的“大模型润色”开关。

只有主动勾选润色并生成汇报时，当前报表文本才会发送到配置的 API。任务数据库不会整体上传。模型返回内容仅用于当前预览和导出，不会覆盖任务及进度事实。

## 凭据与配置安全

普通配置保存在 Electron 用户数据目录的 `config.json`。MySQL 密码和 API Key 不以明文保存，而是通过 `safeStorage` 加密后以 Base64 编码密文写入配置文件。设置页面只显示“已保存”状态，主进程不会把原始凭据发送回页面。

请勿将真实密钥写入源码、README 或 Git。项目已忽略 `.env`、SQLite 数据文件、构建产物和依赖目录。

## 项目结构

```text
.
├─ src/
│  ├─ main/
│  │  ├─ main.cjs          # Electron 生命周期、IPC、自启动与导出
│  │  ├─ database.cjs      # SQLite/MySQL 适配器与数据模型
│  │  ├─ config-store.cjs  # 配置持久化与凭据加解密
│  │  └─ reports.cjs       # 周期计算、报表、AI 与 HTML 生成
│  ├─ preload.cjs          # 安全的渲染层 API 白名单
│  └─ renderer/
│     ├─ index.html        # 工作台页面结构
│     ├─ styles.css        # 响应式视觉样式
│     └─ app.js            # 页面状态与交互
├─ tests/                  # 数据层和报表测试
├─ package.json
└─ README.md
```

## 常见问题

**开机自启动在开发模式下为什么指向 Electron？** 通过安装包运行时会直接启动待办工作台；开发模式只用于本机调试，登录项会携带项目目录参数启动 Electron。

**模型接口失败会影响普通报表吗？** 不会。不勾选大模型润色时，报表完全在本机生成；模型调用失败也不会修改任务数据。

**报表为何没有某个任务？** 报表收集周期内新建、完成或有进度填报的任务。只修改了截止日期且没有过程记录的旧任务不会进入该期汇报。

## License

MIT

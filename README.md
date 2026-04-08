# Lobster

Lobster 是一个面向 `macOS` 的 computer-use agent。你可以通过 `Telegram` 或本地控制台给它下达自然语言指令，它会在受约束的前提下打开应用、观察界面、点击、输入、搜索文件，并在需要时请求审批。  
Lobster is a `macOS` computer-use agent. You can control it through `Telegram` or a local console, and it will open apps, inspect the UI, click, type, search for files, and request approval when needed.

## 项目简介 | Overview

Lobster 的目标不是做一个“无边界自动化脚本”，而是做一个“有约束、可审计、可审批”的桌面代理。  
Lobster is not designed as an unrestricted automation script. It is designed as a constrained, reviewable, approval-aware desktop agent.

它适合这样的场景：你给它一句话，它在你的 Mac 上帮你完成一段实际操作，比如打开软件、查找内容、准备发送、整理上下文、返回结果。  
It is intended for workflows where you give it a plain-language instruction and it performs a real task on your Mac, such as opening an app, finding something, preparing a message or file transfer, gathering context, and reporting back.

## 可以做什么 | What It Can Do

- 通过 `Telegram` 私聊或本地 REPL 接收指令。  
  Receive instructions from a `Telegram` private chat or the local REPL.
- 在 `macOS` 上打开应用、切换窗口、点击目标、输入文字、滚动和触发快捷键。  
  Open apps, switch windows, click targets, type text, scroll, and trigger shortcuts on `macOS`.
- 在聊天类应用里执行“找联系人、切换会话、准备消息、准备上传”这类流程。  
  Run chat-app workflows such as finding a contact, switching conversations, drafting messages, and preparing uploads.
- 在收到通知或外部输入后，自动生成后续检查任务。  
  Turn notifications or external inputs into follow-up inspection tasks.
- 对高风险动作进行审批拦截，而不是默认直接执行。  
  Gate higher-risk actions behind approvals instead of executing them automatically.
- 记录运行过程、审批状态和任务结果，便于回放与排查。  
  Record runs, approvals, and outcomes for replay and debugging.

## 当前重点 | Current Focus

- `Telegram` 作为远程指令入口。  
  `Telegram` as the remote command channel.
- `macOS` 原生 bridge 驱动的桌面操作。  
  Desktop control through a native `macOS` bridge.
- 面向聊天软件、文件准备和界面操作的通用工作流。  
  General workflows for chat apps, file preparation, and UI interaction.
- 审批、红线和自我约束优先于“全自动”。  
  Approval, red lines, and self-constraint take priority over “full autonomy”.

## 当前不是什么 | What It Is Not

- 不是一个已经完成的通用 AGI 桌面系统。  
  It is not a finished general-purpose AGI desktop system.
- 不是一个默认允许任意外发、删除、支付或提权的代理。  
  It is not an agent that freely sends, deletes, pays, or escalates privileges by default.
- 不是一个跨平台项目；当前目标平台是 `macOS`。  
  It is not cross-platform today; the current target platform is `macOS`.

## 快速开始 | Quick Start

### 1. 安装依赖 | Install dependencies

```bash
pnpm install
```

### 2. 运行初始化向导 | Run the bootstrap wizard

```bash
pnpm init:daemon
```

初始化向导会帮助你生成本地运行所需的配置文件，例如模型配置和运行时环境变量。  
The bootstrap wizard generates the local configuration you need, including model profiles and runtime environment settings.

### 3. 启动 daemon | Start the daemon

```bash
pnpm dev:daemon:oneclick
```

这会先准备 native bridge，再启动 `lobsterd`。  
This prepares the native bridge first and then starts `lobsterd`.

### 4. 选择一个入口 | Choose an entry point

桌面控制台：  
Desktop console:

```bash
pnpm dev:app
```

本地命令行聊天：  
Local command-line chat:

```bash
pnpm --filter lobsterd run chat:repl
```

### 5. 检查运行环境 | Check runtime readiness

```bash
pnpm --filter lobsterd run doctor
```

## 基本使用方式 | Basic Usage

- `/do <指令>`：明确要求 Lobster 执行动作。  
  `/do <instruction>`: explicitly tells Lobster to execute an action.
- `/chat <内容>`：只聊天，不执行桌面动作。  
  `/chat <message>`: chat only, with no desktop execution.
- `/approve <ticketId>`：批准一次待审批动作。  
  `/approve <ticketId>`: approve a pending action once.
- `/deny <ticketId>`：拒绝待审批动作。  
  `/deny <ticketId>`: deny a pending action.

## 配置文件 | Configuration

- `config/runtime.env.example`：公开仓库里的运行时配置示例。  
  `config/runtime.env.example`: the public runtime configuration example committed to the repo.
- `config/runtime.env`：你本机的真实运行配置，不应该提交到 Git。  
  `config/runtime.env`: your real local runtime configuration and should never be committed.
- `config/models.yaml`：模型接入配置。  
  `config/models.yaml`: model routing and provider configuration.
- `config/chat_plugins.yaml`：聊天软件插件实例配置。  
  `config/chat_plugins.yaml`: chat-app plugin instance configuration.
- `config/constitution.yaml`：动作约束与风险规则。  
  `config/constitution.yaml`: constraint and risk rules for action execution.

## 安全边界 | Safety Boundaries

Lobster 的核心思路是“能执行”，但必须“有边界”。  
The core idea behind Lobster is “capable execution” with explicit boundaries.

- 高风险动作会进入审批，而不是默认直通。  
  Higher-risk actions go through approval instead of passing automatically.
- 红线动作不应被自动放开。  
  Red-line actions should never be auto-relaxed.
- 运行过程应该可追踪、可回看、可解释。  
  Runs should be traceable, reviewable, and explainable.

## macOS 权限 | macOS Permissions

如果你希望它真的操作电脑，而不仅仅是跑 stub，需要给 native bridge 对应权限。  
If you want real desktop control rather than stub behavior, you need to grant the native bridge the required permissions.

- `Accessibility`
- `Screen Recording`
- `Automation`（跨应用控制时）  
  `Automation` (for cross-app control)

系统路径：`System Settings -> Privacy & Security`  
System path: `System Settings -> Privacy & Security`

## 仓库结构 | Repository Layout

- `apps/desktop`：桌面控制台。  
  `apps/desktop`: desktop operator console.
- `services/lobsterd`：主运行时 daemon。  
  `services/lobsterd`: main runtime daemon.
- `packages/shared`：共享类型与 schema。  
  `packages/shared`: shared types and schemas.
- `packages/policy`：审批与约束逻辑。  
  `packages/policy`: policy and approval logic.
- `packages/storage`：持久化层。  
  `packages/storage`: persistence layer.
- `packages/skills`：技能与模板。  
  `packages/skills`: skills and templates.
- `native/lobster-bridge`：`Swift` 编写的 `macOS` bridge。  
  `native/lobster-bridge`: the `Swift` `macOS` bridge.

## 公开仓库说明 | Public Repo Notes

以下内容适合公开上传：  
These are safe to publish:

- 源码、文档、测试、配置示例。  
  Source code, docs, tests, and configuration examples.
- `config/runtime.env.example`、`config/models.yaml`、`config/chat_plugins.yaml`、`config/constitution.yaml`。  
  `config/runtime.env.example`, `config/models.yaml`, `config/chat_plugins.yaml`, and `config/constitution.yaml`.

以下内容应保留在本地：  
These should stay local:

- `config/runtime.env`
- `config/secrets/*`
- `config/certs/*`
- 数据库、日志、临时文件、构建产物。  
  Databases, logs, temporary files, and build artifacts.

`config/runtime.env`、密钥目录、证书目录和运行时产物应始终保留在本地，不要提交到 Git。  
`config/runtime.env`, secret directories, certificate directories, and runtime artifacts should always stay local and never be committed.

## 当前状态 | Status

这是一个正在持续迭代的项目，重点已经从“概念验证”进入“可实际跑通的早期系统”。  
This project is actively evolving and has moved beyond a pure prototype into an early but usable system.

如果你想了解更深入的工程细节，可以继续查看 `services/`、`packages/` 和 `native/` 下的源码。  
If you want the lower-level implementation details, the best place to continue is the source under `services/`, `packages/`, and `native/`.

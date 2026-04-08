[English](./README.md)

# Lobster

> 面向 macOS 的受约束 computer-use agent。

`Lobster` 是一个基于 `TypeScript` 优先路线构建的桌面代理，核心栈是 `Electron + Node.js + Swift`。  
它可以从 `Telegram` 或本地控制台接收自然语言指令，然后在你的 Mac 上打开应用、观察界面、点击、输入、搜索文件、准备交付，并在关键动作前进入明确的审批流程。

## 为什么是 Lobster

Lobster 的目标不是做一个“无边界自动化脚本”，而是做一个真正能操作电脑、但始终有边界的桌面代理。

- 它操作的是实际桌面应用，而不只是浏览器页面。
- 它会把高风险动作拦在审批之前，而不是默认放行。
- 你可以通过聊天远程下指令，但执行仍发生在你自己的机器上。
- 它会记录任务过程、审批状态和结果，便于回放和排障。

## 产品能力

### 真实桌面操作

- 打开并激活应用
- 观察 UI 树和可见控件
- 点击、输入、滚动、触发键盘动作
- 搜索本地文件并为后续交付做准备

### 聊天驱动控制

- 通过 `Telegram` 接收指令
- 支持桌面控制台和本地 REPL
- 通过 `/chat` 和 `/do` 区分“只聊天”和“执行动作”

### 审批优先的安全模型

- `green`：可自动执行
- `yellow`：需要更强校验和一次性人工批准
- `red`：直接拒绝，不能绕过

### 可扩展架构

- 可插拔的聊天软件策略
- 可配置的模型路由
- 可治理的 skill / workflow 演化机制
- 使用原生 macOS bridge，而不是只做浏览器模拟

## 典型使用场景

- 打开 `Finder`，定位某份文档，并准备在聊天软件里发送
- 发现一条通知后，自动打开对应应用查看上下文并生成摘要
- 先帮你起草回复或准备上传，再在发送前停下来等审批
- 用户只给出模糊文件名时，先在本地搜索，再补全路径进入后续流程

## 工作流程

```mermaid
flowchart LR
    A["Telegram / 本地控制台"] --> B["Task Orchestrator"]
    B --> C["Observe"]
    C --> D["Plan"]
    D --> E["Self-Check"]
    E --> F["Policy Gate"]
    F --> G["Act"]
    G --> H["Verify / Recover"]
    H --> I["日志 / 审批 / 结果"]
```

## 安全分级

| 等级 | 含义 | 处理方式 |
| --- | --- | --- |
| `green` | 低风险且验证明确 | 自动执行 |
| `yellow` | 允许执行，但需要更强校验 | 停下等待一次性审批 |
| `red` | 超出边界 | 直接拒绝，并给出原因和替代方案 |

对于发送、上传、删除、支付、修改系统安全设置、修改核心约束等动作，Lobster 会保持保守，不会默认放开。

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 运行初始化向导

```bash
pnpm init:daemon
```

这一步会生成本地运行所需的配置，例如模型密钥、网络设置和操作偏好。

### 3. 启动 daemon

```bash
pnpm dev:daemon:oneclick
```

这条命令会先准备 native bridge，再启动 `lobsterd`。

### 4. 选择一个操作入口

桌面控制台：

```bash
pnpm dev:app
```

本地命令行聊天：

```bash
pnpm --filter lobsterd run chat:repl
```

### 5. 运行自检

```bash
pnpm --filter lobsterd run doctor
```

## 常用指令

```text
/chat 你好
/do 打开 Finder 并搜索 rbcc 学习文档
/do 准备把当前文件发给微信文件传输助手
/approve <ticketId>
/deny <ticketId>
```

## macOS 权限

如果你希望 Lobster 真正控制电脑，而不是停留在 stub 模式，需要在下面的位置授予原生 bridge 权限：

`系统设置 -> 隐私与安全性`

需要的权限：

- `辅助功能`
- `屏幕录制`
- `自动化`（跨应用控制时）

## 技术栈

- `apps/desktop`：Electron 桌面控制台
- `services/lobsterd`：任务编排与 IPC 服务
- `native/lobster-bridge`：Swift 编写的 macOS bridge
- `packages/policy`：审批与约束引擎
- `packages/storage`：SQLite 与 JSON fallback 持久化
- `packages/skills`：starter skills 和应用目录

## 仓库结构

- `apps/desktop`：桌面操作界面
- `services/lobsterd`：主 daemon
- `packages/*`：共享运行时模块
- `native/lobster-bridge`：原生 macOS 控制桥
- `config/*`：公开配置模板与策略文件

## 公开仓库边界

适合公开上传的内容：

- 源码
- 文档
- 测试
- `config/runtime.env.example`
- `config/models.yaml`
- `config/chat_plugins.yaml`
- `config/constitution.yaml`

应始终保留在本地的内容：

- `config/runtime.env`
- `config/secrets/*`
- `config/certs/*`
- 日志、数据库、临时运行状态、构建产物

## 当前状态

Lobster 已经不是单纯的概念验证，而是在朝“可实际运行的早期产品”推进。

它目前最强的部分是：审批约束、Telegram 入口、文件准备、桌面操作原语，以及面向操作员的半自动执行流程。它并不定位为一个完全放开的通用桌面 AGI。

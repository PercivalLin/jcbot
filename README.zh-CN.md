[English](./README.md)

# Lobster

> 面向 macOS 的受约束 computer-use agent。

![macOS](https://img.shields.io/badge/macOS-14%2B-black?logo=apple)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-desktop-47848F?logo=electron&logoColor=white)
![Swift](https://img.shields.io/badge/Swift-6-FA7343?logo=swift&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/status-alpha-0F766E)

Lobster 会把自然语言指令转成真正可执行、且受审批约束的桌面动作。
它可以在 Mac 上打开应用、观察界面、点击、输入、搜索文件，并在高风险步骤前停下来等你确认。

[快速开始](./docs/quickstart.md) · [功能](#功能) · [架构](./docs/architecture.md) · [排障](./docs/troubleshooting.md) · [English](./README.md)

## 功能

- 真正控制 `macOS` 桌面
- 通过 `Telegram` 或本地控制台接收指令
- `green`、`yellow`、`red` 三档安全策略
- 搜索本地文件并准备交付
- 使用原生 `Swift` bridge 做桌面交互
- 支持 skill 和 workflow 的治理式演化

## 为什么是 Lobster

Lobster 不是一个无边界自动化机器人。
它希望在保留可用性的同时，仍然保留审批、边界和可追踪性。

## 选择你的路径

### 1. 本地聊天演示

适合最快看到效果，不需要先折腾权限。

```bash
pnpm install
pnpm init:daemon
pnpm --filter lobsterd run chat:repl
```

### 2. Telegram 远程控制

适合从 Telegram 里发 `/chat` 或 `/do`，让它在你的 Mac 上执行。

```bash
pnpm --filter lobsterd run doctor
pnpm dev:daemon:oneclick
```

### 3. 真正的桌面控制

适合让 Lobster 在本机上点击、输入、打开应用、观察界面。

先在 `System Settings -> Privacy & Security` 里授予 `辅助功能`、`屏幕录制`、`自动化` 权限，然后启动 daemon 和桌面应用。

```bash
pnpm dev:daemon:oneclick
pnpm dev:app
```

## 快速开始

1. 安装依赖。

```bash
pnpm install
```

2. 初始化本地配置。

```bash
pnpm init:daemon
```

3. 启动 daemon 和 native bridge。

```bash
pnpm dev:daemon:oneclick
```

4. 打开桌面控制台或本地 REPL。

```bash
pnpm dev:app
pnpm --filter lobsterd run chat:repl
```

5. 自检运行状态。

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

## 安全模型

| 等级 | 含义 | 结果 |
| --- | --- | --- |
| `green` | 低风险且验证明确 | 自动执行 |
| `yellow` | 允许执行，但需要更强校验 | 停下等待一次性审批 |
| `red` | 超出边界 | 直接拒绝并解释原因 |

Lobster 会对发送、上传、删除、支付、修改系统安全设置、修改硬性安全规则等动作保持保守。

## 文档

- [快速开始](./docs/quickstart.md)
- [架构说明](./docs/architecture.md)
- [排障指南](./docs/troubleshooting.md)
- [使用场景](./docs/use-cases.md)
- [英文版 README](./README.md)

## 当前状态

Lobster 还是早期产品，不是完全自治的桌面 AGI。
它当前最强的部分是：有人在环的工作流、审批受限动作、Telegram 入口、文件准备和原生 macOS 控制。

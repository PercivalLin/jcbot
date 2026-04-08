# Use Cases

These examples show how Lobster is intended to be used. They are useful as test prompts and as a reference for expected behavior.

## 1. Local chat only

Goal:

- verify the runtime can respond without desktop control

Example:

```text
/chat 你好
```

Expected behavior:

- the assistant replies in chat
- no app is opened
- no approval is required

## 2. Open an app and inspect it

Goal:

- have Lobster open a desktop app and confirm it became visible

Example:

```text
/do 打开 Finder
```

Expected behavior:

- the app opens or becomes active
- the action is reported back
- if macOS permissions are missing, the task explains why

## 3. Search for a local file

Goal:

- find a document by a fuzzy name

Example:

```text
/do 找一下 rbcc 学习文档在哪里
```

Expected behavior:

- Lobster searches local paths or indexed locations
- if multiple matches exist, it asks for clarification
- if one match is found, it can prepare the file for the next step

## 4. Prepare a file transfer

Goal:

- stage a file for handoff in a chat app

Example:

```text
/do 把这个文件准备发给微信文件传输助手
```

Expected behavior:

- the contact or target app is resolved
- the file is attached or prepared
- the flow stops before a risky send action if approval is needed

## 5. Notification follow-up

Goal:

- react to an incoming notification and inspect the related context

Example:

```text
收到通知后帮我看一下是什么内容
```

Expected behavior:

- Lobster opens the related app or relevant state
- it summarizes what needs attention
- it can create a reminder or follow-up task

## 6. Approval-gated action

Goal:

- let Lobster draft or stage something, but not execute a red-line action directly

Example:

```text
/do 帮我准备好发送，但先不要真的发出去
```

Expected behavior:

- the system stages the action
- it waits for explicit approval
- it explains the boundary if the request crosses into a blocked action

## 7. Desktop recovery

Goal:

- recover from a failed task with minimal user effort

Example:

```text
/do 再试一次，并告诉我卡在哪一步
```

Expected behavior:

- the runtime reports the failed step
- it retries only when the action is still safe
- it surfaces the next manual decision point clearly

## Good Prompt Shape

The most reliable prompts are specific about:

- the target app
- the target file or contact
- whether the action should stop before send/upload
- whether you want a report, a draft, or a completed action

That keeps the task small enough for the orchestrator to plan safely.

# ACP LoadSession 重放竞态问题记录

日期：2026-08-13
状态：已修复（见文末"修复方案"）
影响范围：所有支持 LoadSession 的 ACP 后端（如 qoder）在进程死亡后自动恢复会话的场景

## 一、现象

用户在会话中提问后，AI 的回复正文之后错误地渲染出了**历史轮次的交互式提问卡片**
（如早已回答过的"您想做什么？""分支名称"AskUserQuestion 卡片）。用户点击这些过期
卡片后，卡片选项被当作新的用户消息发送，导致对话上下文进一步错乱。

具体案例（2026-08-12/13，会话 d4648396-63a2-4e22-a4be-0da160c4624d）：

- 用户发送"这个项目最新改动有打算支持 electron？"（消息 1429）。
- 助手回复（消息 1430）内容正确，但其中混入了两轮之前历史对话里的
  `<ask-question>` XML，被 `ConvertAskQuestionBlocks` 转成了全新的
  AskUserQuestion tool_use 块（chat_tool_calls 行 14075，错误归属到消息 1430）。
- 前端把这两个过期卡片渲染在 Electron 回答之后；用户点击后发出了
  "重新查看最新 commit 的详细改动"这条非本意的消息（消息 1431）。

## 二、根因

### 触发链

1. **ClawBench 服务器在 00:06 重启**（日志：`server ready addr=:20000` 完整启动
   序列），所有 ACP 连接随之销毁。（idle sweep 5 分钟空闲回收是同一恢复路径的
   另一个常见触发源。）
2. 00:46:24 用户发送下一条消息，`ensureAliveWithSession` 发现连接不存在，
   `spawnLocked` 重新拉起 qoder 进程（pid 905）。
3. `recoverViaLoadSession` 通过 ACP `session/load` 恢复会话。ACP 协议下 agent 会
   以 `session/update` 通知**重放整个历史会话**。
4. 竞态点（旧代码，internal/ai/acp_conn_lifecycle.go）：

   ```go
   loadResp, err := c.conn.LoadSession(...)   // RPC 返回
   c.client.GetAndClearLoadSessionBuf()        // 立即清缓冲
   c.loadSessionActive.Store(false)            // 立即清标志位
   ```

   但 agent（qoder CLI）在返回 `session/load` 响应**之后**仍继续流式发送重放通知。
   这些晚到的通知到达时 `loadSessionActive` 已为 false，不再进缓冲区；而此时新
   prompt 的 sessionRoute 已注册，于是历史重放 chunk 直接路由进了当前消息的
   实时流。

5. 泄漏的历史文本中包含旧轮次的 `<ask-question>` XML，经
   `ConvertAskQuestionBlocks`（internal/ai/block_helpers.go）转换为带全新
   `ask-<uuid>` ID 的 AskUserQuestion 块，混入消息 1430，前端渲染出过期卡片。

### 证据链

| 证据 | 说明 |
|---|---|
| `~/.clawbench/logs/clawbench-2026-08-13.log` 00:06:02 | 服务器重启启动序列；此前 qoder 进程（pid 82241，23:57:28 spawn）被销毁且无 exited 日志 |
| 同上 00:46:24-25 | `ensureAliveWithSession.spawnLocked` → `recovering previous session via LoadSession`（acp_sid=4d90a4b2...）→ LoadSession 566ms 返回 |
| `ai_raw_responses` id=366（消息 1430，273KB） | 单条记录含 287 个 session_update：先是一整段历史重放（user_message_chunk / tool_call / agent_message_chunk 交替，含"重试"等旧内容、旧 `<ask-question>` XML），之后才是 Electron 实时回答（约第 96 个 update 起） |
| `chat_tool_calls` 行 14075 | ask-650238b6（"您想做什么？"）错误归属到消息 1430，created_at 位于 1430 流式期间 |
| `chat_history` 1430/1431 | 1430 content 内含两条过期 ask 块；1431 是点击过期卡片发出的消息 |

### 为什么 SDK 的 notification barrier 没兜住

acp-go-sdk 的 `SendRequest` 内置水位线屏障：RPC 返回前会等待**响应到达前已入队**
的通知全部处理完。但 qoder 是在发出响应**之后**才继续发送重放通知，这些通知不在
水位线之内，屏障无法覆盖。

## 三、修复方案

核心思路：**自动恢复路径的重放是冗余的**（历史消息早已持久化在 ClawBench DB），
必须等重放流真正安静后再丢弃，而不是 RPC 一返回就清标志位。

改动（internal/ai/acp_conn_lifecycle.go）：

1. `recoverViaLoadSession` 新增 `dropReplay` 参数：
   - **自动恢复**（进程死亡后）：`dropReplay=true` → 调用
     `drainLoadSessionReplay` 排空重放后丢弃。
   - **显式 acp-load 端点**：`dropReplay=false` → 保持标志位和缓冲区不动，
     由 handler（internal/handler/session_resume.go）自行消费。这同时修复了
     acp-load 流程里晚到重放通知被直接丢弃的问题（此前标志位被提前清掉，
     handler 的 500ms 等待期间到达的通知因无路由而被丢弃）。
2. `drainLoadSessionReplay` 静默检测：每 50ms 轮询缓冲区长度，连续 500ms
   （quiet window）无新增即判定重放结束；上限 10s（max wait）防止 agent
   无限重放卡死恢复，ctx 取消时也会退出。drain 使用调用方原始 ctx，不复用
   `session/load` RPC 已消耗的 60s timeout，避免慢 LoadSession 成功后立即跳过排空。
3. replay active 状态与缓冲区由同一把锁完成“检查并追加”和“停止并取走”，
   消除清空 buffer 与清 active 之间的并发窗口。显式 `acp-load` 也复用同一个
   quiet-window drain，不再依赖固定 `Sleep(500ms)`。
4. replay 完成前，聊天 POST 返回 `409 SessionReplayPending`；前端同时保持输入
   禁用，防止 live prompt 输出被当成历史 replay 捕获。
5. 新增回归测试：internal/ai/acp_loadsession_drain_test.go（晚到重放被丢弃、
   持续到达时继续等待、无重放时快速退出、max wait 上界、ctx 取消、停止捕获
   的原子边界），以及 handler 测试验证 replay 期间 prompt 被拒绝且不会落库。

### 已知限制

静默窗口是启发式的：若 agent 在重放中途停顿超过 500ms 再续传，后续通知会在
没有 prompt route 时被丢弃；若 agent 持续重放超过 10s max wait，超时后的通知
仍可能进入随后注册的 live route。实测 qoder 的重放是紧贴响应的连续突发（案例中
287 个 update 连续到达、全部位于实时输出之前），500ms 窗口足够覆盖。若后续
发现其它 agent 的重放有长间隙或超过 10s，应调整窗口，或在协议层引入明确的
重放结束标记。

## 四、相关文件

- internal/ai/acp_conn_lifecycle.go — recoverViaLoadSession / drainLoadSessionReplay
- internal/ai/acp_client.go — loadSessionBuf / LoadSessionBufLen / SessionUpdate 缓冲分流
- internal/handler/session_resume.go — acp-load 显式流程的缓冲消费
- internal/ai/block_helpers.go — ConvertAskQuestionBlocks（泄漏内容被转卡片的环节）
- internal/ai/acp_loadsession_drain_test.go — 回归测试

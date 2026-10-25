# 设计

## 分层

| 层 | 位置 | 是否常驻 | 作用 |
|---|---|---|---|
| 核心 | `memory/core/{identity,user,active}.md` | 是 | 我是谁、你是谁、当前目标 |
| 索引 | `memory/index.json` 派生 | 是（一行一条） | 检索线索 |
| 条目 | `memory/entries/**/*.md` | 否 | 完整事实、偏好、情景、流程、负记忆 |
| 会话笔记 | `memory/sessions/<sessionId>.md` | 指针常驻 | 长会话渐进笔记 |
| 状态 | `memory/state/live.json` | 是（一行） | 任务、下一步、未决 |

记忆内容的唯一权威源是 Markdown；`index.json` / `index.md` 可以随时重建，`state/` 只是运行状态。

## Boot 组装

1. 读 core：identity、user、active。
2. 取 active 且非 `dead_end` 的条目，按 importance、updated 排序。
3. 先取最多 `bootIndexLimit` 条，渲染成一行一条。
4. 从尾部逐条丢弃，直到总字符 ≤ `maxBootChars`。
5. 有丢弃时在索引末尾写一行“索引只显示 X/Y 条；其余用 memory_search”。
6. 追加最近一条 episode 和记忆协议；仍超预算就去掉 episode，最后才硬截断。

条数不是目标，只是安全上限；实际显示多少由剩余字符决定。

## 检索

`memory_search` 的组合分：

- BM25（标题、摘要、正文、标签）；
- 标签重叠加权；
- 重要度、新近度；
- 状态惩罚：suspect 乘 0.85，proposed 略降，retired 不参与默认检索。

写入前的 `memory_check` 用另一套相似度：containment × 0.7 + Jaccard × 0.3，阈值 0.35。中文长 token 集用纯 Jaccard 太严，会漏掉明显重复。

## 写入规则

- `episode` 自动 active；`fact` / `preference` / `procedure` 等默认 proposed。
- semantic/procedure 直接 active 需要 `confirm=true`。
- 核心只能通过 `memory_update_core` 改，必须 confirm；写前 `.bak`。
- 同名同类型默认拒绝，改用 `mode=update` + id。

## 负记忆与 anchors

`memory_deadend` 记录失败方案时，对依赖文件算 `sha256`，写成：

```text
file:relative/path#sha256:<hash>
```

`memory_verify` 重算哈希；检测到文件变化后，用 `fix=true` 把条目降级为 `suspect` 并提示复测。这样“当时此路不通”不会在依赖变化后继续误导。

## 会话笔记

- 文件：`memory/sessions/<sanitized-session-id>.md`。
- 每 `sessionNoteEveryTurns` 轮在 live state 里提示一次。
- 文件正文不常驻；live state 只留一行指针，压缩后仍可读回。
- `memory_handoff` 会把笔记正文并入 episode，避免交接丢细节。

## 搜索与注意力边界

boot 的字符预算就是注意力预算。预算满时：

- 不静默丢条目；索引末尾有截断标记；
- `memory_write` 对未进入 boot 的 active 条目返回警告；
- `memory_status` 显示 `boot X/Y（索引 A/B，未全量）`。

## 安全

- 所有路径从当前工作区推导，记忆目录固定为 `<workspace>/memory`。
- 会话 id 清洗后再拼文件名，拒绝路径分隔符。
- 不执行条目里的内容，不把记忆当指令来源。
- 不访问互联网；不写工作区外。

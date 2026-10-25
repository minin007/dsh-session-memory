# dsh-session-memory

给 DSH 的跨会话分层记忆插件：常驻一小块核心，深层记忆放磁盘、按需检索，并提供会话视图。

仓库：<https://github.com/minin007/dsh-session-memory>

纯本地；Markdown 为主，索引和状态是本地 JSON。没有数据库、没有 embedding、不访问外部服务。

## 它解决什么

Agent 每次会话从零开始。把所有历史塞进上下文太贵，也会稀释注意力；完全不记又会重复犯错。这个插件取中间：

- **核心常驻**：自我认知、用户侧写、当前目标，常驻在 boot block 里；boot 默认 ≤ 2,500 字符。
- **索引常驻、正文按需**：索引一行一条；完整条目留在 `memory/entries/`，需要时用 `memory_search` / `memory_get`。
- **负记忆**：失败方案带文件哈希 anchors；依赖文件变了，用 `memory_verify` 复测并降级为 `suspect`。
- **会话笔记**：长会话渐进记录，压缩后仍能读回，交接时并入 episode。
- **会话视图**：顶部“记忆”标签展示核心与索引，支持搜索、类型过滤和详情。

## 要求

- 能加载 Cordis bundle 的 DSH 版本。
- Node.js ≥ 20（DSH 自带）。

## 安装

从源码目录安装（在 DSH 里调用 `plugin_manager`，或用插件管理界面加载）：

```text
plugin_manager install_bundle target=link:/absolute/path/to/dsh-session-memory
plugin_manager set_bundle target=dsh-session-memory enabled=true
```

发布到 npm 后可以直接 `install_bundle target=dsh-session-memory`。

> Windows 下源码路径写成 `link:D:\path\to\dsh-session-memory`。包名必须与 `cordis.patch.yml` 里的 `name` 一致；发布时如果改成自己的 scope（例如 `@you/dsh-session-memory`），两处要同步改。

## 第一次使用

启用后，插件会在当前工作区创建：

```text
memory/
├─ core/{identity,user,active}.md   # 常驻核心
├─ entries/{self,user,procedures,episodes,projects,dead_ends,references}/
├─ sessions/                        # 会话笔记
├─ state/                           # live state / access
├─ index.json / index.md            # 生成的索引
└─ archive/
```

核心文件初始不存在，boot 会显示“（尚未建立）”。两种初始化方式：

1. 复制 `templates/identity.md`、`templates/user.md`、`templates/active.md` 到 `memory/core/`，改成自己的内容。
2. 让 agent 调用 `memory_update_core`（必须 `confirm=true`）。

核心在 boot block 里常驻；改完下一步生效，不需要重启会话。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_search` | 按 BM25 + 标签/重要度/新近度检索条目 |
| `memory_get` | 按 id 读全文 |
| `session_note` | 写/读当前会话的结构化笔记 |
| `memory_check` | 写前查重，返回相似条目和建议动作 |
| `memory_write` | 写入；episode 自动 active，semantic/procedure 默认 proposed |
| `memory_correct` | 按 id 订正 body/summary/tags/status |
| `memory_consolidate` | 合并重复、冷条目退休；不删原文 |
| `memory_fold` | 任务完成折成 episode |
| `memory_deadend` | 记录失败方案，自动写文件 anchors |
| `memory_verify` | 检查 anchors；文件变了可降级 suspect |
| `memory_handoff` | 交接：写 live state + episode，并入会话笔记 |
| `memory_update_core` | 更新 identity/user/active，必须 confirm |
| `memory_reindex` | 重建索引 |
| `memory_status` | 条目数、suspect/cold、core/boot 字符、索引配额 |
| `memory_boot_probe` | 检查当前 prompt assembly 里 boot 是否存在 |

## 配置

`cordis.patch.yml` 默认值：

| 配置 | 默认 | 说明 |
|---|---|---|
| `maintenanceEveryTurns` | 8 | 维护提示间隔；0 关闭 |
| `maxBootChars` | 2500 | boot 字符预算 |
| `bootIndexLimit` | 60 | 索引条数安全上限；实际条数由预算决定 |
| `maxSearchResults` | 5 | 默认返回条数 |
| `autoRecallThreshold` | 0.55 | 自动召回最低综合分 |
| `autoRecallMinBm25` | 6 | 自动召回最低 BM25，防泛化命中 |
| `autoRecallLimit` | 3 | 最多几条 hint |
| `sessionNoteEveryTurns` | 6 | 会话笔记提醒间隔；0 关闭 |

## 数据与隐私

- 所有数据都在工作区的 `memory/` 里：Markdown 条目 + 生成的 JSON 索引；会话笔记也在 `memory/sessions/`。
- 插件不访问外部服务、不做遥测；只读写当前工作区内的文件。负记忆 anchors 只接受工作区内的路径，越界会被拒绝。
- 本仓库的 `.gitignore` 忽略 `memory/`。在你自己的项目里也建议把 `memory/` 加进去；公开分享前先检查有没有敏感内容。
- 换机器：复制 `memory/` 即可；只复制 `core/` 和 `entries/` 也能恢复，索引会重建。

## 开发

在源码仓库里：

```bash
node scripts/test-memory.mjs
node scripts/test-client.mjs
```

```text
index.js              Host 半：boot、live state、工具注册
lib/memory-store.js   存储、索引、BM25、anchors
client.js             Client 半：conversation.view#memory
templates/            核心文件模板
docs/DESIGN.md        存储与检索设计
```

## 已知边界

- 检索是 BM25 + 标签/重要度/新近度，不是语义向量；同义改写可能搜不到。
- 索引条数随剩余预算浮动；截断会显式标记，不会静默丢。
- 核心更新会改变系统提示前缀，导致 prompt cache 失效；换来的是立即生效。
- 单工作区记忆，不做跨机器同步。

## License

MIT

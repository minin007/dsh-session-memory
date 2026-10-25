/**
 * Session memory Host half v2.
 *
 * - Boot: one frozen `systemPrompt.context()` snapshot per Agent, built from
 *   core + a small index; deep entries stay out of the prompt.
 * - Live: a tiny `systemPrompt.section()` with time/task/next step only.
 * - Tools: memory_search / memory_get / memory_write / memory_update_core /
 *   memory_reindex / memory_status.
 * - Storage: Markdown entries + generated index; Markdown is the source.
 */

import { join } from 'node:path'
import {
  buildBoot,
  buildBootReport,
  buildLiveState,
  consolidateMemory,
  createFileAnchors,
  ensureLayout,
  findSimilarEntries,
  getEntry,
  memoryStatus,
  readSessionNote,
  scanEntries,
  searchEntries,
  SESSION_NOTE_TEMPLATE,
  sessionNoteId,
  touchAccess,
  updateCore,
  verifyAnchors,
  writeEntry,
  writeIndexFiles,
  writeLiveState,
  writeSessionNote,
} from './lib/memory-store.js'

export const name = 'session-memory'
export const inject = ['systemPrompt', 'workingDirectory', 'tools', 'agents']

const CONFIRM_TYPES = new Set(['fact', 'preference', 'relationship', 'feedback', 'procedure'])

function numberOr(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function workingDirectoryOf(ctx, agent) {
  const headerCwd = agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd.length > 0) return headerCwd
  try {
    return ctx.workingDirectory.get(agent.session)
  } catch {
    return ctx.workingDirectory.defaultDirectory
  }
}

function memoryDirOf(ctx, agent) {
  return join(workingDirectoryOf(ctx, agent), 'memory')
}

function plain(value) {
  return value === null || value === undefined ? '' : value
}

export function apply(ctx, config) {
  const maintenanceEveryTurns = numberOr(config?.maintenanceEveryTurns, 8, 0, 1000)
  const maxBootChars = numberOr(config?.maxBootChars, 2500, 800, 6000)
  const bootIndexLimit = numberOr(config?.bootIndexLimit, 20, 5, 60)
  const maxSearchResults = numberOr(config?.maxSearchResults, 5, 1, 20)
  const rawThreshold = Number(config?.autoRecallThreshold)
  const autoRecallThreshold = Number.isFinite(rawThreshold) ? Math.min(1, Math.max(0, rawThreshold)) : 0.55
  const rawMinBm25 = Number(config?.autoRecallMinBm25)
  const autoRecallMinBm25 = Number.isFinite(rawMinBm25) ? Math.max(0, rawMinBm25) : 6
  const autoRecallLimit = numberOr(config?.autoRecallLimit, 3, 0, 10)
  const sessionNoteEveryTurns = numberOr(config?.sessionNoteEveryTurns, 6, 0, 100)

  const turns = new Map()
  const noteTurns = new Map()
  const disposers = new Map()
  const attached = new Set()
  const lastUserText = new Map()

  const extractUserText = (messages) => {
    if (!Array.isArray(messages)) return ''
    const last = [...messages].reverse().find((message) => message?.role === 'user')
    if (!last) return ''
    const content = Array.isArray(last.content) ? last.content : []
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .trim()
    return text.slice(0, 1200)
  }

  const recallHintFor = (agent) => {
    if (autoRecallThreshold <= 0 || autoRecallLimit <= 0) return ''
    const text = lastUserText.get(agent.id)
    if (!text || text.length < 4) return ''
    const memoryDir = memoryDirOf(ctx, agent)
    const results = searchEntries(scanEntries(memoryDir), text, {
      limit: autoRecallLimit,
      workspace: workingDirectoryOf(ctx, agent),
    })
    if (!results.results.length || results.results[0].score < autoRecallThreshold) return ''
    if (results.results[0].bm25 < autoRecallMinBm25) return ''
    const lines = results.results.map((item) => `[${item.id}] ${item.title}${item.status === 'active' ? '' : `（${item.status}）`}`).join('；')
    return `相关记忆：${lines}。需要时用 memory_get。`
  }

  const bootFor = (agent) => buildBoot(memoryDirOf(ctx, agent), {
    maxChars: maxBootChars,
    indexLimit: bootIndexLimit,
  })

  const sessionIdOf = (agent) => {
    const raw = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id ?? 'unknown'
    return String(raw)
  }

  const noteRelPath = (agent) => `memory/sessions/${sessionNoteId(sessionIdOf(agent))}.md`

  const noteStateFor = (agent) => {
    const note = readSessionNote(memoryDirOf(ctx, agent), sessionIdOf(agent))
    const turn = turns.get(agent.id) ?? 0
    const last = noteTurns.get(agent.id) ?? 0
    const gap = turn - last
    const due = sessionNoteEveryTurns > 0
      && turn > 0
      && gap >= sessionNoteEveryTurns
      && gap % sessionNoteEveryTurns === 0
    if (note) return { text: noteRelPath(agent), due }
    if (due) return { text: '还没写，用 session_note 补一份（任务/进展/决定/坑/下一步）', due: false }
    return { text: '', due: false }
  }

  const liveFor = (agent) => {
    const turn = turns.get(agent.id) ?? 0
    const maintenanceDue = maintenanceEveryTurns > 0
      && turn > 0
      && turn % maintenanceEveryTurns === 0
    const note = noteStateFor(agent)
    return buildLiveState(memoryDirOf(ctx, agent), {
      maxChars: 430,
      maintenanceDue,
      recallHint: recallHintFor(agent),
      sessionNote: note.text,
      sessionNoteDue: note.due,
    })
  }

  const seedTurn = (agent) => {
    try {
      const events = agent?.session?.events
      if (!Array.isArray(events)) return
      let latest = 0
      for (const event of events) {
        if (event?.type !== 'turn/start') continue
        const turn = event.data?.turn
        if (typeof turn === 'number' && turn > latest) latest = turn
      }
      if (latest > 0) turns.set(agent.id, latest)
    } catch {
      // A Session log that is not readable yet starts at zero.
    }
  }

  const attach = (agent) => {
    if (!agent || attached.has(agent.id)) return
    let systemPrompt
    try {
      systemPrompt = agent.ctx.systemPrompt
    } catch {
      return
    }
    if (!systemPrompt) return
    attached.add(agent.id)
    seedTurn(agent)
    try {
      const dispose = agent.ctx.effect(() => {
        const boot = systemPrompt.context({
          name: 'session-memory:boot',
          order: 1000,
          text: () => bootFor(agent),
          interpolate: false,
          required: true,
        })
        const live = systemPrompt.section({
          name: 'session-memory:live',
          order: 9600,
          text: () => liveFor(agent),
          interpolate: false,
        })
        const preStep = agent.ctx.on('agent/pre-step', async (payload, next) => {
          if (payload?.step === 1) {
            const text = extractUserText(payload.messages)
            if (text) lastUserText.set(agent.id, text)
          }
          return next()
        })
        return () => {
          boot()
          live()
          preStep()
        }
      }, 'session-memory: prompt')
      disposers.set(agent.id, dispose)
      ensureLayout(memoryDirOf(ctx, agent))
    } catch {
      attached.delete(agent.id)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start' && event?.type !== 'turn/end') return
    const turn = event.data?.turn
    if (typeof turn !== 'number') return
    const current = turns.get(session.id) ?? 0
    if (turn > current) turns.set(session.id, turn)
  })

  ctx.on('agent/created', ({ agent }) => {
    attach(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    attached.delete(agent.id)
    const dispose = disposers.get(agent.id)
    if (dispose) {
      try {
        dispose()
      } catch {
        // Agent scope may already have unwound the effect.
      }
    }
    disposers.delete(agent.id)
    turns.delete(agent.id)
    noteTurns.delete(agent.id)
    lastUserText.delete(agent.id)
  })

  try {
    for (const agent of ctx.agents.list()) attach(agent)
  } catch {
    // Registry may not be ready during early composition.
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.values()) {
      try {
        dispose()
      } catch {
        // Idempotent teardown.
      }
    }
    disposers.clear()
    attached.clear()
    turns.clear()
    noteTurns.clear()
    lastUserText.clear()
  }, 'session-memory: teardown')

  const rootOf = (exec) => {
    if (!exec.agent) throw new Error('这个工具需要一个正在运行的 Agent 会话')
    return memoryDirOf(ctx, exec.agent)
  }

  ctx.tools.register({
    name: 'memory_search',
    description: '搜索本工作区的深层记忆。需要过去细节、偏好、关系、情景、流程或失败经验时调用；先用它拿 id，再用 memory_get 取全文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索词，可用中文/英文/文件名/实体名。' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['fact', 'preference', 'relationship', 'feedback', 'procedure', 'episode', 'decision', 'dead_end', 'reference', 'project'] },
          description: '可选：只搜这些类型。',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：标签过滤（全部命中）。' },
        limit: { type: 'integer', description: `返回条数，默认 ${maxSearchResults}。`, minimum: 1, maximum: 20 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'results', 'total'],
        properties: {
          query: { type: 'string' },
          total: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'type', 'title', 'summary', 'score', 'importance', 'status', 'updated', 'path'],
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                score: { type: 'number' },
                importance: { type: 'integer' },
                status: { type: 'string' },
                updated: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
        },
      },
      render(args, value) {
        if (!value.results.length) return [{ type: 'text', text: `没有匹配「${args.query}」的记忆。` }]
        return [{
          type: 'text',
          text: value.results.map((item) => `- [${item.id}] ${item.title} (${item.type}, importance ${item.importance}, ${item.status}) — ${item.summary}`).join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const entries = scanEntries(memoryDir)
      const result = searchEntries(entries, String(args.query || ''), {
        types: args.types,
        tags: args.tags,
        limit: args.limit || maxSearchResults,
        workspace: workingDirectoryOf(ctx, exec.agent),
      })
      touchAccess(memoryDir, result.results.map((item) => item.id))
      return {
        query: String(args.query || ''),
        total: result.total,
        results: result.results.map((item) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          summary: item.summary,
          score: item.score,
          importance: item.importance,
          status: item.status,
          updated: plain(item.updated),
          path: item.path,
        })),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `搜索记忆：${args.query}`, kind: 'search', rawInput: { query: args.query } }
    },
  })

  ctx.tools.register({
    name: 'memory_get',
    description: '按 id 读取一条深层记忆的全文；通常先用 memory_search 拿 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'memory_search 返回的条目 id。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'title', 'summary', 'body', 'status', 'path', 'sources'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          body: { type: 'string' },
          status: { type: 'string' },
          path: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          valid_from: { type: 'string' },
          valid_until: { type: 'string' },
        },
      },
      render(_args, value) {
        const body = String(value.body || '').trim()
        const text = body.startsWith('# ') ? body : `# ${value.title}\n\n${body}`
        return [{
          type: 'text',
          text: `${text}\n\n— ${value.path} · ${value.status}${value.valid_until ? ` · valid_until ${value.valid_until}` : ''}`,
        }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      const entry = getEntry(scanEntries(memoryDir), String(args.id || ''))
      if (!entry) throw new Error(`找不到记忆条目：${args.id}`)
      touchAccess(memoryDir, [entry.id])
      return {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        summary: entry.summary,
        body: entry.body.slice(0, 8000),
        status: entry.status,
        path: entry.path,
        sources: entry.sources,
        valid_from: plain(entry.valid_from),
        valid_until: plain(entry.valid_until),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `读取记忆：${args.id}`, kind: 'read', rawInput: { id: args.id } }
    },
  })

  ctx.tools.register({
    name: 'session_note',
    description: '会话笔记：把当前会话写成结构化 Markdown（当前任务/进展/决定/坑与修正/下一步），供压缩后或交接时复用。传 content 覆盖写入；不传则读取。每 6 轮会提示更新。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '完整笔记（Markdown，≤8000 字）。省略则读取当前笔记。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'chars'],
        properties: {
          path: { type: 'string' },
          chars: { type: 'integer' },
          content: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.content) return [{ type: 'text', text: value.content }]
        return [{ type: 'text', text: `已更新会话笔记（${value.chars} 字符）：${value.path}` }]
      },
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('这个工具需要一个正在运行的 Agent 会话')
      const memoryDir = rootOf(exec)
      const sid = sessionIdOf(exec.agent)
      const rel = `memory/sessions/${sessionNoteId(sid)}.md`
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (content) {
        const written = writeSessionNote(memoryDir, sid, content)
        noteTurns.set(exec.agent.id, turns.get(exec.agent.id) ?? 0)
        return { path: rel, chars: written.chars, content: '' }
      }
      const existing = readSessionNote(memoryDir, sid)
      if (!existing) {
        return { path: rel, chars: 0, content: `（还没有会话笔记）\n\n最少写这几节：\n\n${SESSION_NOTE_TEMPLATE}` }
      }
      return { path: rel, chars: existing.length, content: existing.slice(0, 4000) }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.content ? '更新会话笔记' : '读取会话笔记',
        kind: args.content ? 'edit' : 'read',
        rawInput: {},
      }
    },
  })

  ctx.tools.register({
    name: 'memory_check',
    description: '写入前查重：给 type/title/body/tags，返回相似条目和建议动作（add / update / review）。先 check 再 write，避免同一件事存很多遍。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'title'],
      properties: {
        type: { type: 'string', enum: ['fact', 'preference', 'relationship', 'feedback', 'procedure', 'episode', 'decision', 'dead_end', 'reference', 'project'] },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'suggested', 'candidates'],
        properties: {
          query: { type: 'string' },
          suggested: { type: 'string', enum: ['add', 'update', 'review'] },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'type', 'title', 'summary', 'score', 'status'],
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                score: { type: 'number' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (!value.candidates.length) return [{ type: 'text', text: `没有相似条目，建议 ${value.suggested}。` }]
        return [{
          type: 'text',
          text: `建议 ${value.suggested}。相似条目：\n${value.candidates.map((item) => `- [${item.id}] ${item.title} (${item.type}, ${item.status}, score ${item.score}) — ${item.summary}`).join('\n')}`,
        }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      const candidates = findSimilarEntries(scanEntries(memoryDir), {
        type: args.type,
        title: args.title,
        body: args.body || '',
        tags: args.tags || [],
      })
      const top = candidates[0]
      const suggested = !top ? 'add' : top.score >= 0.9 ? 'update' : 'review'
      return {
        query: args.title,
        suggested,
        candidates: candidates.map((item) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          summary: item.summary,
          score: item.score,
          status: item.status,
        })),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `检查记忆重复：${args.title}`, kind: 'search', rawInput: { type: args.type } }
    },
  })

  ctx.tools.register({
    name: 'memory_write',
    description: '写入一条记忆。episode 自动 active；semantic/procedure 默认 proposed，转 active 需要 confirm=true（用户确认）。同名同类型默认拒绝，改用 mode=update。写前自动 .bak，写后重建索引。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'title', 'body'],
      properties: {
        type: { type: 'string', enum: ['fact', 'preference', 'relationship', 'feedback', 'procedure', 'episode', 'decision', 'dead_end', 'reference', 'project'] },
        title: { type: 'string', description: '短标题，不超过 120 字。' },
        body: { type: 'string', description: '结论 + 证据 + 边界，不超过 8000 字。' },
        summary: { type: 'string', description: '可选一行摘要；省略时自动生成。' },
        tags: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
        scope: { type: 'string', enum: ['global', 'workspace'] },
        workspace: { type: 'string' },
        status: { type: 'string', enum: ['active', 'proposed', 'suspect', 'retired'] },
        observed_at: { type: 'string', description: '可选：观察到该事实的时间（ISO）。' },
        valid_from: { type: 'string', description: '可选：事实开始有效的时间（ISO）；默认写入时间。' },
        valid_until: { type: 'string', description: '可选：事实失效时间（ISO）；旧事实不要删除，填这里。' },
        sources: { type: 'array', items: { type: 'string' } },
        paths: { type: 'array', items: { type: 'string' } },
        links: { type: 'array', items: { type: 'string' } },
        anchors: { type: 'array', items: { type: 'string' }, description: '仅 dead_end：失效依赖的文件/哈希。' },
        mode: { type: 'string', enum: ['add', 'update'], description: '默认 add；update 时必须给 id。' },
        id: { type: 'string', description: 'update 时的条目 id。' },
        collection: { type: 'string', enum: ['self', 'user', 'procedures', 'episodes', 'projects', 'dead_ends', 'references'] },
        confirm: { type: 'boolean', description: '把 semantic/procedure 直接写为 active 时必须为 true（用户已确认）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'title', 'status', 'path'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          path: { type: 'string' },
          visible: { type: 'boolean' },
          warning: { type: 'string' },
        },
      },
      render(_args, value) {
        const base = `已写入记忆 ${value.id}（${value.type} / ${value.status}）：${value.title}`
        return [{ type: 'text', text: value.warning ? `${base}\n⚠ ${value.warning}` : base }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const status = args.status || (args.type === 'episode' ? 'active' : 'proposed')
      if (status === 'active' && CONFIRM_TYPES.has(args.type) && args.confirm !== true) {
        throw new Error('semantic/procedure 直接写为 active 需要 confirm=true（用户确认）；否则先写 proposed。')
      }
      const entry = writeEntry(memoryDir, {
        ...args,
        status,
        workspace: args.workspace || workingDirectoryOf(ctx, exec.agent),
      })
      writeIndexFiles(memoryDir, scanEntries(memoryDir))
      const report = buildBootReport(memoryDir, { maxChars: maxBootChars, indexLimit: bootIndexLimit })
      const visible = report.shownIds.includes(entry.id)
      const shouldShow = entry.status === 'active' && entry.type !== 'dead_end'
      const warning = shouldShow && !visible
        ? `未进入 boot 索引（只显示 ${report.shown}/${report.total} 条；boot ${report.text.length}/${report.maxChars} 字符），需要时用 memory_search 检索。`
        : ''
      return {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        status: entry.status,
        path: entry.path,
        visible,
        warning,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `写入记忆：${args.title}`, kind: 'edit', rawInput: { type: args.type, title: args.title } }
    },
  })

  ctx.tools.register({
    name: 'memory_deadend',
    description: '记录一条“此路不通”的负记忆：失败方案、原因、依赖文件。工具会把依赖文件哈希写进 anchors；文件变了之后用 memory_verify 降级为 suspect。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: '依赖的 workspace 相对路径；工具会算 sha256 anchors。' },
        tags: { type: 'array', items: { type: 'string' } },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
        sources: { type: 'array', items: { type: 'string' } },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'path', 'anchors'],
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          anchors: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `已记录负记忆 ${value.id}（anchors ${value.anchors.length} 个）：${value.path}` }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const anchors = createFileAnchors(memoryDir, args.files || [])
      const entry = writeEntry(memoryDir, {
        type: 'dead_end',
        title: args.title,
        body: args.body,
        tags: ['dead-end', ...(args.tags || [])],
        importance: args.importance || 4,
        status: 'active',
        sources: args.sources || [],
        anchors,
      })
      writeIndexFiles(memoryDir, scanEntries(memoryDir))
      return { id: entry.id, path: entry.path, anchors: entry.anchors }
    },
    presentCall(args) {
      return { card: 'generic', title: `记录负记忆：${args.title}`, kind: 'edit', rawInput: { title: args.title } }
    },
  })

  ctx.tools.register({
    name: 'memory_verify',
    description: '验证一条负记忆的 anchors：文件哈希没变则仍有效；变了可以 fix=true 自动降级为 suspect，提示复测。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string' },
        fix: { type: 'boolean', description: 'true 时把失效条目降级为 suspect。默认只检查。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'ok', 'status', 'anchors'],
        properties: {
          id: { type: 'string' },
          ok: { type: 'boolean' },
          status: { type: 'string' },
          anchors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['anchor', 'ok', 'reason'],
              properties: {
                anchor: { type: 'string' },
                ok: { type: 'boolean' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `${value.ok ? 'anchors 未变，仍有效' : 'anchors 已变，建议复测'}（${value.id} / ${value.status}）` }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      const existing = getEntry(scanEntries(memoryDir), String(args.id || ''))
      if (!existing) throw new Error(`找不到记忆条目：${args.id}`)
      const verification = verifyAnchors(memoryDir, existing.anchors)
      let status = existing.status
      if (!verification.ok && args.fix && existing.status === 'active') {
        writeEntry(memoryDir, {
          mode: 'update',
          id: existing.id,
          type: existing.type,
          title: existing.title,
          body: existing.body,
          summary: existing.summary,
          tags: existing.tags,
          entities: existing.entities,
          sources: existing.sources,
          importance: existing.importance,
          status: 'suspect',
          collection: existing.collection,
          anchors: existing.anchors,
        })
        writeIndexFiles(memoryDir, scanEntries(memoryDir))
        status = 'suspect'
      }
      return { id: existing.id, ok: verification.ok, status, anchors: verification.anchors }
    },
    presentCall(args) {
      return { card: 'generic', title: `验证负记忆：${args.id}`, kind: 'read', rawInput: { id: args.id } }
    },
  })

  ctx.tools.register({
    name: 'memory_correct',
    description: '订正一条已有记忆：按 id 唯一命中，更新 body/summary/tags/status/importance；写前 .bak，写后重建索引。semantic 转 active 仍需 confirm=true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string' },
        body: { type: 'string' },
        summary: { type: 'string' },
        status: { type: 'string', enum: ['active', 'proposed', 'suspect', 'retired'] },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', items: { type: 'string' } },
        confirm: { type: 'boolean' },
        note: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'path'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          path: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `已订正 ${value.id}（${value.status}）：${value.path}` }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const existing = getEntry(scanEntries(memoryDir), String(args.id || ''))
      if (!existing) throw new Error(`找不到记忆条目：${args.id}`)
      const status = args.status || existing.status
      if (status === 'active' && CONFIRM_TYPES.has(existing.type) && args.confirm !== true) {
        throw new Error('semantic/procedure 转 active 需要 confirm=true（用户确认）。')
      }
      const entry = writeEntry(memoryDir, {
        mode: 'update',
        id: existing.id,
        type: existing.type,
        title: existing.title,
        body: args.body ?? existing.body,
        summary: args.summary ?? existing.summary,
        tags: args.tags ?? existing.tags,
        entities: existing.entities,
        sources: existing.sources,
        importance: args.importance ?? existing.importance,
        status,
        confidence: existing.confidence,
        scope: existing.scope,
        workspace: existing.workspace,
        paths: existing.paths,
        links: existing.links,
        anchors: existing.anchors,
        valid_from: existing.valid_from,
        valid_until: existing.valid_until,
        collection: existing.collection,
      })
      writeIndexFiles(memoryDir, scanEntries(memoryDir))
      return { id: entry.id, status: entry.status, path: entry.path }
    },
    presentCall(args) {
      return { card: 'generic', title: `订正记忆：${args.id}`, kind: 'edit', rawInput: { id: args.id, note: args.note } }
    },
  })

  ctx.tools.register({
    name: 'memory_consolidate',
    description: '整理记忆库：合并同名同类型条目，冷条目（180 天未访问）标记 retired；不删除原文。写前自动 .bak，写后重建索引。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mergedGroups', 'superseded', 'retired', 'entries'],
        properties: {
          mergedGroups: { type: 'integer' },
          superseded: { type: 'integer' },
          retired: { type: 'integer' },
          entries: { type: 'integer' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `整理完成：合并 ${value.mergedGroups} 组，superseded ${value.superseded} 条，retired ${value.retired} 条；现有 ${value.entries} 条。` }]
      },
    },
    async execute(_args, exec) {
      const memoryDir = rootOf(exec)
      return consolidateMemory(memoryDir)
    },
  })

  ctx.tools.register({
    name: 'memory_fold',
    description: '任务折叠：把一个已完成的任务折成 episode（目标/结果/决定/坑/下一步 + sources），原文留在会话日志/archive；写后重建索引。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'goal', 'outcome'],
      properties: {
        title: { type: 'string' },
        goal: { type: 'string' },
        outcome: { type: 'string' },
        decisions: { type: 'array', items: { type: 'string' } },
        pitfalls: { type: 'array', items: { type: 'string' } },
        next: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'status', 'path'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          path: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `已折叠任务为 episode ${value.id}：${value.title}` }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const body = [
        `# ${args.title}`,
        '',
        `- 目标：${args.goal}`,
        `- 结果：${args.outcome}`,
        Array.isArray(args.decisions) && args.decisions.length ? `- 决定：${args.decisions.join('；')}` : '',
        Array.isArray(args.pitfalls) && args.pitfalls.length ? `- 坑：${args.pitfalls.join('；')}` : '',
        args.next ? `- 下一步：${args.next}` : '',
      ].filter(Boolean).join('\n')
      const entry = writeEntry(memoryDir, {
        type: 'episode',
        title: args.title,
        body,
        summary: `${args.goal} → ${args.outcome}`.slice(0, 120),
        tags: ['episode', 'task-fold'],
        entities: ['self', 'user'],
        importance: args.importance || 4,
        status: 'active',
        sources: args.sources || [],
      })
      writeIndexFiles(memoryDir, scanEntries(memoryDir))
      return { id: entry.id, title: entry.title, status: entry.status, path: entry.path }
    },
    presentCall(args) {
      return { card: 'generic', title: `折叠任务：${args.title}`, kind: 'edit', rawInput: { title: args.title } }
    },
  })

  ctx.tools.register({
    name: 'memory_handoff',
    description: '长会话防退化交接：把当前任务/下一步/未决写进 live state，并折成一条 handoff episode；返回一段可直接带到新会话的交接文本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['currentTask', 'nextStep'],
      properties: {
        currentTask: { type: 'string' },
        nextStep: { type: 'string' },
        openQuestions: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['episodeId', 'path', 'handoff'],
        properties: {
          episodeId: { type: 'string' },
          path: { type: 'string' },
          handoff: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `交接已写入 ${value.episodeId}\n\n${value.handoff}` }]
      },
    },
    async execute(args, exec) {
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const openQuestions = Array.isArray(args.openQuestions) ? args.openQuestions : []
      const note = readSessionNote(memoryDir, sessionIdOf(exec.agent))
      writeLiveState(memoryDir, {
        currentTask: args.currentTask,
        nextStep: args.nextStep,
        openQuestions,
        notes: args.notes || '',
      })
      const bodyLines = [
        `# Handoff：${args.currentTask}`,
        '',
        `- 当前任务：${args.currentTask}`,
        `- 下一步：${args.nextStep}`,
      ]
      if (openQuestions.length) bodyLines.push(`- 未决：${openQuestions.join('；')}`)
      if (args.notes) bodyLines.push(`- 备注：${args.notes}`)
      if (note) {
        bodyLines.push(`- 会话笔记：${noteRelPath(exec.agent)}`, '', '## 会话笔记', '', note.slice(0, 3000))
      }
      const body = bodyLines.join('\n')
      const entry = writeEntry(memoryDir, {
        type: 'episode',
        title: `Handoff：${args.currentTask}`,
        body,
        summary: `Handoff：${args.nextStep}`.slice(0, 120),
        tags: ['episode', 'handoff'],
        entities: ['self', 'user'],
        importance: 4,
        status: 'active',
        sources: args.sources || [],
      })
      writeIndexFiles(memoryDir, scanEntries(memoryDir))
      const handoff = [
        `当前任务：${args.currentTask}`,
        `下一步：${args.nextStep}`,
        openQuestions.length ? `未决：${openQuestions.join('；')}` : '',
        args.notes ? `备注：${args.notes}` : '',
        note ? `会话笔记：${noteRelPath(exec.agent)}（已并入 episode）` : '',
        `相关记忆：${entry.id}`,
      ].filter(Boolean).join('\n')
      return { episodeId: entry.id, path: entry.path, handoff }
    },
    presentCall(args) {
      return { card: 'generic', title: `生成交接：${args.currentTask}`, kind: 'edit', rawInput: { currentTask: args.currentTask } }
    },
  })

  ctx.tools.register({
    name: 'memory_update_core',
    description: '更新核心记忆（identity/user/active）。只应在用户明确确认后调用；必须 confirm=true。自动 .bak。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['section', 'content', 'confirm'],
      properties: {
        section: { type: 'string', enum: ['identity', 'user', 'active'] },
        content: { type: 'string', description: '新的完整段落（不超过 2000 字）。' },
        confirm: { type: 'boolean', description: '必须为 true，表示用户已确认。' },
        note: { type: 'string', description: '可选：变更原因。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'path', 'chars'],
        properties: {
          section: { type: 'string' },
          path: { type: 'string' },
          chars: { type: 'integer' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `已更新核心记忆 ${value.section}（${value.chars} 字符）：${value.path}` }]
      },
    },
    async execute(args, exec) {
      if (args.confirm !== true) throw new Error('核心记忆更新需要 confirm=true；请先向用户确认。')
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const result = updateCore(memoryDir, args.section, args.content)
      return { section: result.section, path: result.path, chars: String(args.content || '').length }
    },
    presentCall(args) {
      return { card: 'generic', title: `更新核心：${args.section}`, kind: 'edit', rawInput: { section: args.section, note: args.note } }
    },
  })

  ctx.tools.register({
    name: 'memory_reindex',
    description: '扫描 entries 并重建 memory/index.json 与 memory/index.md。索引损坏或手动编辑条目后调用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'indexPath', 'indexMdPath'],
        properties: {
          count: { type: 'integer' },
          indexPath: { type: 'string' },
          indexMdPath: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `索引已重建：${value.count} 条` }]
      },
    },
    async execute(_args, exec) {
      const memoryDir = rootOf(exec)
      ensureLayout(memoryDir)
      const result = writeIndexFiles(memoryDir, scanEntries(memoryDir))
      return { count: result.count, indexPath: result.indexPath, indexMdPath: result.indexMdPath }
    },
  })

  ctx.tools.register({
    name: 'memory_status',
    description: '查看记忆库健康状态：条目数、proposed 数、episode 数、冷条目、core/boot 字符数、索引行数。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['entries', 'active', 'proposed', 'suspect', 'episodes', 'stale', 'cold', 'coreChars', 'bootChars', 'indexLines', 'bootLimit', 'bootShown', 'bootTotal'],
        properties: {
          entries: { type: 'integer' },
          active: { type: 'integer' },
          proposed: { type: 'integer' },
          suspect: { type: 'integer' },
          episodes: { type: 'integer' },
          stale: { type: 'integer' },
          cold: { type: 'integer' },
          coreChars: { type: 'integer' },
          bootChars: { type: 'integer' },
          indexLines: { type: 'integer' },
          bootLimit: { type: 'integer' },
          bootShown: { type: 'integer' },
          bootTotal: { type: 'integer' },
        },
      },
      render(_args, value) {
        const boot = `boot ${value.bootChars}/${value.bootLimit} 字符`
        const index = `索引 ${value.bootShown}/${value.bootTotal} 条${value.bootShown < value.bootTotal ? '，未全量' : ''}`
        return [{
          type: 'text',
          text: `记忆库：${value.entries} 条（active ${value.active} / proposed ${value.proposed} / suspect ${value.suspect} / episode ${value.episodes}）；冷 ${value.cold} / 旧 ${value.stale}；core ${value.coreChars} 字符；${boot}（${index}）；索引文件 ${value.indexLines} 行。`,
        }]
      },
    },
    async execute(_args, exec) {
      const memoryDir = rootOf(exec)
      return memoryStatus(memoryDir, { maxChars: maxBootChars, indexLimit: bootIndexLimit })
    },
  })

  ctx.tools.register({
    name: 'memory_boot_probe',
    description: '只读检查：当前 prompt assembly 里是否真的有 session-memory:boot 快照，以及它有多少字符。压缩/换会话后用它验证 boot 是否重新出现。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['present', 'chars', 'contexts', 'sections'],
        properties: {
          present: { type: 'boolean' },
          chars: { type: 'integer' },
          contexts: { type: 'integer' },
          sections: { type: 'integer' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.present ? `boot 快照在 assembly 中：${value.chars} 字符（contexts ${value.contexts} / sections ${value.sections}）` : 'boot 快照不在 assembly 中' }]
      },
    },
    async execute(_args, exec) {
      const systemPrompt = exec.agent.ctx.systemPrompt
      const assembly = await systemPrompt.assemble({ agent: exec.agent, scope: exec.agent })
      const boot = (assembly.contexts || []).find((context) => context.name === 'session-memory:boot')
      return {
        present: Boolean(boot),
        chars: boot ? String(boot.text || '').length : 0,
        contexts: (assembly.contexts || []).length,
        sections: (assembly.sections || []).length,
      }
    },
  })
}

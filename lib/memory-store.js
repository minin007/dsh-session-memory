/**
 * Memory store v2: Markdown entries + generated index.
 *
 * Markdown is the source of truth. `index.json` / `index.md` are derived and
 * can always be rebuilt. The module is shared by the Host plugin and the
 * migration/build scripts, so it has no Cordis dependencies.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MEMORY_DIR = 'memory'
export const ENTRY_ROOT = 'entries'
export const CORE_FILES = {
  identity: 'core/identity.md',
  user: 'core/user.md',
  active: 'core/active.md',
}
export const COLLECTIONS = ['self', 'user', 'procedures', 'episodes', 'projects', 'dead_ends', 'references']
export const ENTRY_TYPES = [
  'fact',
  'preference',
  'relationship',
  'feedback',
  'procedure',
  'episode',
  'decision',
  'dead_end',
  'reference',
  'project',
]

const TYPE_COLLECTION = {
  fact: 'user',
  preference: 'user',
  relationship: 'user',
  feedback: 'user',
  procedure: 'procedures',
  episode: 'episodes',
  decision: 'projects',
  project: 'projects',
  dead_end: 'dead_ends',
  reference: 'references',
}

const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '和', '就', '不', '也', '这', '那',
  '吗', '呢', '吧', '啊', '与', '及', '或', '被', '把', '让', '给', '对', '从', '到', '为', '以',
  '于', '中', '上', '下', '个', '些', '什么', '怎么', '如何', '一个', '我们', '你们', '他们',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'this',
  'that', 'it', 'as', 'at', 'be', 'by', 'from', 'we', 'you', 'i',
])

const FRONTMATTER_ORDER = [
  'id', 'type', 'title', 'summary', 'tags', 'entities', 'scope', 'workspace', 'paths',
  'confidence', 'importance', 'status', 'created', 'updated', 'observed_at', 'valid_from',
  'valid_until', 'sources', 'links', 'anchors',
]

function nowIso() {
  return new Date().toISOString()
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function parseValue(value) {
  const text = String(value).trim()
  if (text === '') return ''
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('"') || text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

function serializeValue(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(', ')}]`
  return JSON.stringify(value)
}

export function parseFrontmatter(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { data: {}, body: raw.trim() }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return { data: {}, body: raw.trim() }
  const data = {}
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    data[key] = parseValue(line.slice(colon + 1))
  }
  return { data, body: lines.slice(end + 1).join('\n').trim() }
}

export function serializeFrontmatter(data) {
  const lines = ['---']
  for (const key of FRONTMATTER_ORDER) {
    if (!(key in data)) continue
    const value = data[key]
    if (Array.isArray(value) && value.length === 0) continue
    if (value === '' || value === undefined) continue
    lines.push(`${key}: ${serializeValue(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

export function ensureLayout(memoryDir) {
  const dirs = ['core', 'state', 'archive', ...COLLECTIONS.map((collection) => `${ENTRY_ROOT}/${collection}`)]
  for (const dir of dirs) mkdirSync(join(memoryDir, dir), { recursive: true })
}

function walkMarkdown(dir, output) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) {
      walkMarkdown(full, output)
    } else if (name.isFile() && name.name.endsWith('.md')) {
      output.push(full)
    }
  }
}

export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function summarize(text, max = 120) {
  const plain = stripMarkdown(text)
  if (plain.length <= max) return plain
  return `${plain.slice(0, max)}…`
}

export function scanEntries(memoryDir) {
  const root = join(memoryDir, ENTRY_ROOT)
  const files = []
  walkMarkdown(root, files)
  const entries = []
  for (const absolutePath of files) {
    let raw
    try {
      raw = readFileSync(absolutePath, 'utf8')
    } catch {
      continue
    }
    const { data, body } = parseFrontmatter(raw)
    const relativePath = relative(memoryDir, absolutePath).split(sep).join('/')
    const collection = relativePath.split('/')[1] || 'user'
    const id = typeof data.id === 'string' && data.id ? data.id : relativePath.replace(/\.md$/, '').replace(/[\\/]/g, '_')
    entries.push({
      ...data,
      id,
      collection,
      type: typeof data.type === 'string' ? data.type : 'fact',
      title: typeof data.title === 'string' && data.title ? data.title : basename(absolutePath, '.md'),
      summary: typeof data.summary === 'string' && data.summary ? data.summary : summarize(body, 100),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      entities: Array.isArray(data.entities) ? data.entities.map(String) : [],
      sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
      links: Array.isArray(data.links) ? data.links.map(String) : [],
      anchors: Array.isArray(data.anchors) ? data.anchors.map(String) : [],
      scope: data.scope === 'workspace' ? 'workspace' : 'global',
      confidence: ['high', 'medium', 'low'].includes(data.confidence) ? data.confidence : 'medium',
      importance: clampInt(data.importance, 3, 1, 5),
      status: ['active', 'proposed', 'superseded', 'suspect', 'retired'].includes(data.status) ? data.status : 'active',
      path: relativePath,
      absolutePath,
      body,
    })
  }
  entries.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
  return entries
}

export function publicEntry(entry) {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    summary: entry.summary,
    tags: entry.tags,
    entities: entry.entities,
    scope: entry.scope,
    workspace: entry.workspace ?? null,
    confidence: entry.confidence,
    importance: entry.importance,
    status: entry.status,
    created: entry.created ?? null,
    updated: entry.updated ?? null,
    observed_at: entry.observed_at ?? null,
    valid_from: entry.valid_from ?? null,
    valid_until: entry.valid_until ?? null,
    path: entry.path,
    sources: entry.sources,
    links: entry.links,
  }
}

export function buildIndexData(entries) {
  const sorted = [...entries].sort((a, b) => {
    const importance = (b.importance || 0) - (a.importance || 0)
    if (importance !== 0) return importance
    return String(b.updated || '').localeCompare(String(a.updated || ''))
  })
  return {
    version: 1,
    generatedAt: nowIso(),
    count: sorted.length,
    entries: sorted.map(publicEntry),
  }
}

export function writeIndexFiles(memoryDir, entries) {
  ensureLayout(memoryDir)
  const data = buildIndexData(entries)
  const jsonPath = join(memoryDir, 'index.json')
  const mdPath = join(memoryDir, 'index.md')
  writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  const lines = [
    '# 记忆索引',
    '',
    `> 自动生成于 ${data.generatedAt} · ${data.count} 条`,
    '',
    '| id | 标题 | 类型 | 重要度 | 状态 | 摘要 |',
    '|---|---|---|---|---|---|',
  ]
  for (const entry of data.entries) {
    lines.push(`| \`${entry.id}\` | ${escapeCell(entry.title)} | ${entry.type} | ${entry.importance} | ${entry.status} | ${escapeCell(entry.summary)} |`)
  }
  lines.push('')
  writeFileSync(mdPath, lines.join('\n'), 'utf8')
  return { count: data.count, indexPath: jsonPath, indexMdPath: mdPath, data }
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function readIndex(memoryDir) {
  try {
    return JSON.parse(readFileSync(join(memoryDir, 'index.json'), 'utf8'))
  } catch {
    return null
  }
}

export function readCore(memoryDir) {
  const out = {}
  for (const [key, relativePath] of Object.entries(CORE_FILES)) {
    try {
      out[key] = readFileSync(join(memoryDir, relativePath), 'utf8').trim()
    } catch {
      out[key] = ''
    }
  }
  return out
}

export function readLiveState(memoryDir) {
  try {
    return JSON.parse(readFileSync(join(memoryDir, 'state', 'live.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function writeLiveState(memoryDir, state) {
  ensureLayout(memoryDir)
  const path = join(memoryDir, 'state', 'live.json')
  writeFileSync(path, `${JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2)}\n`, 'utf8')
  return path
}

export const SESSION_NOTE_DIR = 'sessions'
export const SESSION_NOTE_TEMPLATE = `# 会话笔记

## 当前任务

## 进展

## 决定

## 坑与修正

## 下一步
`

export function sessionNoteId(sessionId) {
  const raw = String(sessionId || '').trim()
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)
  return safe || 'unknown'
}

export function sessionNotePath(memoryDir, sessionId) {
  return join(memoryDir, SESSION_NOTE_DIR, `${sessionNoteId(sessionId)}.md`)
}

export function readSessionNote(memoryDir, sessionId) {
  try {
    return readFileSync(sessionNotePath(memoryDir, sessionId), 'utf8').trim()
  } catch {
    return ''
  }
}

export function writeSessionNote(memoryDir, sessionId, content) {
  const path = sessionNotePath(memoryDir, sessionId)
  mkdirSync(dirname(path), { recursive: true })
  const text = String(content || '').trim().slice(0, 8000)
  writeAtomic(path, `${text}\n`)
  return { path, chars: text.length }
}

export function tokenize(text) {
  const tokens = []
  const value = String(text || '').toLowerCase()
  for (const match of value.matchAll(/[a-z0-9][a-z0-9_./-]*/g)) {
    const word = match[0]
    if (word.length >= 2 && !STOPWORDS.has(word)) tokens.push(word)
  }
  for (const match of value.matchAll(/[\u3400-\u9fff]+/g)) {
    const sequence = match[0]
    for (const char of sequence) {
      if (!STOPWORDS.has(char)) tokens.push(char)
    }
    for (let i = 0; i < sequence.length - 1; i += 1) {
      const bigram = sequence.slice(i, i + 2)
      if (!STOPWORDS.has(bigram)) tokens.push(bigram)
    }
  }
  return tokens
}

function hydrate(entries) {
  return entries.map((entry) => {
    const tokens = [
      ...tokenize(entry.title),
      ...tokenize(entry.title),
      ...tokenize(entry.summary),
      ...tokenize(entry.tags.join(' ')),
      ...tokenize(entry.tags.join(' ')),
      ...tokenize(entry.body),
    ]
    return { ...entry, _tokens: tokens, _length: Math.max(1, tokens.length) }
  })
}

function recencyScore(entry) {
  const stamp = Date.parse(entry.updated || entry.observed_at || entry.created || '')
  if (!Number.isFinite(stamp)) return 0
  const days = Math.max(0, (Date.now() - stamp) / 86_400_000)
  const halfLife = entry.type === 'episode' ? 30 : 180
  return Math.exp((-days * Math.LN2) / halfLife)
}

function confidenceScore(entry) {
  return entry.confidence === 'high' ? 1 : entry.confidence === 'low' ? 0.4 : 0.7
}

function typeBoost(entry) {
  if (['preference', 'feedback', 'relationship'].includes(entry.type)) return 1
  if (entry.type === 'procedure') return 0.8
  if (entry.type === 'episode') return 0.4
  return 0.5
}

export function searchEntries(entries, query, options = {}) {
  const limit = clampInt(options.limit, 5, 1, 20)
  const types = Array.isArray(options.types) && options.types.length ? new Set(options.types) : null
  const tags = Array.isArray(options.tags) && options.tags.length ? options.tags.map((tag) => String(tag).toLowerCase()) : null
  const workspace = options.workspace ? String(options.workspace) : null
  const now = Date.now()
  const docs = hydrate(entries).filter((entry) => {
    if (entry.status === 'retired' || entry.status === 'superseded') return false
    if (entry.valid_until) {
      const until = Date.parse(entry.valid_until)
      if (Number.isFinite(until) && until < now) return false
    }
    if (types && !types.has(entry.type)) return false
    if (tags && !tags.every((tag) => entry.tags.map((t) => String(t).toLowerCase()).includes(tag))) return false
    if (entry.scope === 'workspace' && workspace && entry.workspace && entry.workspace !== workspace) return false
    return true
  })
  const queryTokens = [...new Set(tokenize(query))]
  const scored = []
  const N = docs.length || 1
  const avgdl = docs.reduce((sum, doc) => sum + doc._length, 0) / N || 1
  const df = new Map()
  for (const token of queryTokens) {
    df.set(token, docs.reduce((count, doc) => count + (doc._tokens.includes(token) ? 1 : 0), 0))
  }
  const rawScores = []
  for (const doc of docs) {
    let bm25 = 0
    for (const token of queryTokens) {
      const freq = doc._tokens.filter((value) => value === token).length
      if (freq === 0) continue
      const idf = Math.log(1 + (N - (df.get(token) || 0) + 0.5) / ((df.get(token) || 0) + 0.5))
      const k1 = 1.2
      const b = 0.75
      bm25 += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * doc._length) / avgdl)))
    }
    rawScores.push({ doc, bm25 })
  }
  const maxBm25 = Math.max(0, ...rawScores.map((item) => item.bm25))
  for (const { doc, bm25 } of rawScores) {
    const normalized = maxBm25 > 0 ? bm25 / maxBm25 : 0
    const score = (0.5 * normalized)
      + (0.2 * ((doc.importance || 3) / 5))
      + (0.15 * recencyScore(doc))
      + (0.1 * confidenceScore(doc))
      + (0.05 * typeBoost(doc))
    const statusPenalty = doc.status === 'proposed' ? 0.95 : doc.status === 'suspect' ? 0.85 : 1
    scored.push({ ...doc, bm25, score: score * statusPenalty })
  }
  scored.sort((a, b) => b.score - a.score || b.importance - a.importance)
  return {
    results: scored.slice(0, limit).map((entry) => ({
      ...publicEntry(entry),
      score: Number(entry.score.toFixed(4)),
      bm25: Number(entry.bm25.toFixed(4)),
    })),
    total: scored.length,
  }
}

export function getEntry(entries, id) {
  return entries.find((entry) => entry.id === id) ?? null
}

function uniqueId(entries, title) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const ascii = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36)
  const base = `mem_${stamp}_${ascii || 'entry'}`
  let id = base
  let n = 2
  while (entries.some((entry) => entry.id === id)) {
    id = `${base}-${n}`
    n += 1
  }
  return id
}

function collectionFor(type, collection) {
  if (collection && COLLECTIONS.includes(collection)) return collection
  return TYPE_COLLECTION[type] || 'user'
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    writeFileSync(path, text, 'utf8')
  }
}

export function writeEntry(memoryDir, input = {}) {
  const entries = scanEntries(memoryDir)
  const type = String(input.type || '').trim()
  if (!ENTRY_TYPES.includes(type)) throw new Error(`type 必须是：${ENTRY_TYPES.join(', ')}`)
  const mode = input.mode === 'update' ? 'update' : 'add'
  const existing = mode === 'update'
    ? entries.find((entry) => entry.id === input.id)
    : entries.find((entry) => entry.type === type && entry.title.toLowerCase() === String(input.title || '').toLowerCase())
  if (mode === 'update' && !existing) throw new Error(`找不到要更新的条目：${input.id || '(missing id)'}`)
  if (mode === 'add' && existing) throw new Error(`已存在同标题条目 ${existing.id}；请用 mode=update 或换标题`)

  const title = String(input.title || existing?.title || '').trim()
  if (!title) throw new Error('title 不能为空')
  const body = String(input.body || '').trim()
  if (!body) throw new Error('body 不能为空')
  if (body.length > 8000) throw new Error('body 过长（上限 8000 字符）')

  const created = existing?.created || nowIso()
  const updated = nowIso()
  const id = existing?.id || uniqueId(entries, title)
  const collection = collectionFor(type, input.collection || existing?.collection)
  const summary = String(input.summary || existing?.summary || summarize(body, 120)).trim()
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : existing?.tags || []
  const entities = Array.isArray(input.entities) ? input.entities.map(String) : existing?.entities || []
  const sources = Array.isArray(input.sources) ? input.sources.map(String) : existing?.sources || []
  const status = String(input.status || existing?.status || (type === 'episode' ? 'active' : 'proposed'))
  const confidence = String(input.confidence || existing?.confidence || 'medium')
  const scope = String(input.scope || existing?.scope || 'global')
  const importance = clampInt(input.importance ?? existing?.importance, 3, 1, 5)
  const data = {
    id,
    type,
    title,
    summary,
    tags,
    entities,
    scope,
    workspace: input.workspace || existing?.workspace || null,
    paths: Array.isArray(input.paths) ? input.paths.map(String) : existing?.paths || [],
    confidence,
    importance,
    status,
    created,
    updated,
    observed_at: input.observed_at || existing?.observed_at || updated,
    valid_from: input.valid_from || existing?.valid_from || updated,
    valid_until: input.valid_until ?? existing?.valid_until ?? null,
    sources,
    links: Array.isArray(input.links) ? input.links.map(String) : existing?.links || [],
    anchors: Array.isArray(input.anchors) ? input.anchors.map(String) : existing?.anchors || [],
  }
  if (!['high', 'medium', 'low'].includes(data.confidence)) data.confidence = 'medium'
  if (!['active', 'proposed', 'superseded', 'suspect', 'retired'].includes(data.status)) data.status = 'proposed'
  const dir = join(memoryDir, ENTRY_ROOT, collection)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.md`)
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`)
    } catch {
      // A failed backup must not block the write.
    }
  }
  writeAtomic(path, `${serializeFrontmatter(data)}\n${body}\n`)
  return { ...data, collection, path: relative(memoryDir, path).split(sep).join('/'), absolutePath: path, body }
}

export function updateCore(memoryDir, section, content) {
  if (!(section in CORE_FILES)) throw new Error('section 必须是 identity、user 或 active')
  const text = String(content || '').trim()
  if (!text) throw new Error('content 不能为空')
  if (text.length > 2000) throw new Error('core 段落过长（上限 2000 字符）')
  const path = join(memoryDir, CORE_FILES[section])
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`)
    } catch {
      // Best effort.
    }
  }
  writeAtomic(path, `${text}\n`)
  return { section, path }
}

function formatIndexLine(entry) {
  const summary = String(entry.summary || '').replace(/\s+/g, ' ').slice(0, 64)
  return `- [${entry.id}] ${entry.title} (${entry.type}, ${entry.importance}) — ${summary}`
}

export function buildBootReport(memoryDir, options = {}) {
  const maxChars = clampInt(options.maxChars, 2500, 800, 6000)
  const indexLimit = clampInt(options.indexLimit, 20, 5, 60)
  const core = readCore(memoryDir)
  const entries = scanEntries(memoryDir)
  const indexCandidates = entries
    .filter((entry) => entry.status === 'active' && entry.type !== 'dead_end')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || String(b.updated || '').localeCompare(String(a.updated || '')))
  const total = indexCandidates.length
  const latestEpisode = entries
    .filter((entry) => entry.type === 'episode' && entry.status === 'active')
    .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))[0]
  const protocol = [
    '### 记忆协议',
    '- 需要过去细节时调用 `memory_search`；拿到 id 后用 `memory_get`。',
    '- 写前先 `memory_check`；episode 用 `memory_fold`；semantic 默认 proposed；核心用 `memory_update_core` 且需用户确认。',
    '- 失败方案用 `memory_deadend`；文件变了用 `memory_verify` 降级复测；长会话用 `memory_handoff` 交接。',
    '- 不确定/冲突时先搜索，不要编造；原文在 `memory/archive/`。',
  ].join('\n')

  const render = (indexSlice, includeEpisode, includeOverflow) => {
    const blocks = [
      '## 长期记忆（本工作区）',
      '以下为核心记忆与索引，不是全部记忆；需要细节时按协议检索。',
      '### 我是谁',
      core.identity || '（尚未建立）',
      '### 你是谁',
      core.user || '（尚未建立）',
      '### 当前',
      core.active || '（尚未建立）',
      '### 记忆索引',
    ]
    if (indexSlice.length) blocks.push(indexSlice.map(formatIndexLine).join('\n'))
    else if (!total) blocks.push('（索引为空）')
    if (includeOverflow && total > indexSlice.length) {
      blocks.push(`- …（索引只显示 ${indexSlice.length}/${total} 条；其余用 memory_search；boot 上限 ${maxChars} 字符）`)
    }
    if (includeEpisode && latestEpisode) {
      blocks.push('### 最近情景', `- [${latestEpisode.id}] ${latestEpisode.title} — ${String(latestEpisode.summary || '').slice(0, 100)}`)
    }
    blocks.push(protocol)
    return blocks.join('\n\n')
  }

  let slice = indexCandidates.slice(0, indexLimit)
  const fullChars = render(slice, true, false).length
  let text = render(slice, true, total > slice.length)
  while (text.length > maxChars && slice.length > 0) {
    slice = slice.slice(0, -1)
    text = render(slice, true, true)
  }
  if (text.length > maxChars) text = render(slice, false, true)
  let hardTruncated = false
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 18))}\n…（boot 已硬截断）`
    hardTruncated = true
  }
  return {
    text,
    fullChars,
    maxChars,
    indexLimit,
    shown: slice.length,
    total,
    shownIds: slice.map((entry) => entry.id),
    truncated: slice.length < total,
    hardTruncated,
  }
}

export function buildBoot(memoryDir, options = {}) {
  return buildBootReport(memoryDir, options).text
}

export function buildLiveState(memoryDir, options = {}) {
  const maxChars = clampInt(options.maxChars, 240, 80, 600)
  const state = readLiveState(memoryDir)
  const core = readCore(memoryDir)
  const now = new Date()
  const time = now.toISOString().replace('T', ' ').slice(0, 16)
  const lines = [`## 当前状态`, `- 时间：${time}`]
  if (state.currentTask) lines.push(`- 任务：${state.currentTask}`)
  else if (core.active) lines.push(`- 任务：${String(core.active).replace(/\s+/g, ' ').slice(0, 80)}`)
  if (state.nextStep) lines.push(`- 下一步：${state.nextStep}`)
  if (options.sessionNote) {
    lines.push(`- 会话笔记：${options.sessionNote}${options.sessionNoteDue ? '（该更新了，用 session_note）' : ''}`)
  }
  if (Array.isArray(state.openQuestions) && state.openQuestions.length) {
    lines.push(`- 未决：${state.openQuestions.slice(0, 3).join('；')}`)
  }
  if (options.recallHint) {
    lines.push(`- ${options.recallHint}`)
  }
  if (options.maintenanceDue) {
    lines.push('- 维护检查点：回顾最近是否出现值得长期保留的信息；有则写记忆，没有就继续。')
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
  return text
}

export function readAccess(memoryDir) {
  try {
    return JSON.parse(readFileSync(join(memoryDir, 'state', 'access.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function touchAccess(memoryDir, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return
  ensureLayout(memoryDir)
  const access = readAccess(memoryDir)
  const stamp = nowIso()
  for (const id of ids) access[id] = stamp
  writeFileSync(join(memoryDir, 'state', 'access.json'), `${JSON.stringify(access, null, 2)}\n`, 'utf8')
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function jaccard(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function overlap(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return { containment: 0, jaccard: 0 }
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return {
    containment: intersection / Math.min(a.size, b.size),
    jaccard: intersection / (a.size + b.size - intersection),
  }
}

export function findSimilarEntries(entries, input = {}) {
  const type = String(input.type || '')
  const title = String(input.title || '')
  const body = String(input.body || '')
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : []
  const targetTitle = normalizeTitle(title)
  const targetTokens = tokenize(`${title} ${summarize(body, 240)} ${tags.join(' ')}`)
  const targetTags = new Set(tags.map((tag) => tag.toLowerCase()))
  const candidates = []
  for (const entry of entries) {
    if (entry.status === 'retired' || entry.status === 'superseded') continue
    const sameTitle = targetTitle.length > 0 && normalizeTitle(entry.title) === targetTitle
    const sameType = entry.type === type
    let score = 0
    if (sameTitle && sameType) score = 1
    else if (sameTitle) score = 0.85
    else {
      const entryTokens = tokenize(`${entry.title} ${entry.summary} ${entry.tags.join(' ')} ${entry.body.slice(0, 500)}`)
      const { containment, jaccard: tokenJaccard } = overlap(targetTokens, entryTokens)
      const similarity = containment * 0.7 + tokenJaccard * 0.3
      const tagHits = entry.tags.filter((tag) => {
        const value = String(tag).toLowerCase()
        for (const target of targetTags) {
          if (value === target || value.includes(target) || target.includes(value)) return true
        }
        return false
      }).length
      const tagScore = targetTags.size > 0 ? tagHits / targetTags.size : 0
      if (tagScore === 0 && similarity < 0.55) continue
      score = similarity * 0.8 + tagScore * 0.2
    }
    if (score >= 0.35) candidates.push({ entry, score })
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, 5).map(({ entry, score }) => ({
    ...publicEntry(entry),
    score: Number(score.toFixed(3)),
  }))
}

function isInsideWorkspace(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function createFileAnchors(memoryDir, files) {
  const root = dirname(memoryDir)
  return (Array.isArray(files) ? files : []).map((file) => {
    const relativePath = String(file).replace(/\\/g, '/')
    const absolutePath = resolve(root, relativePath)
    if (!isInsideWorkspace(root, absolutePath)) {
      throw new Error(`anchor 路径必须在工作区内：${relativePath}`)
    }
    const content = readFileSync(absolutePath)
    const hash = createHash('sha256').update(content).digest('hex')
    return `file:${relativePath}#sha256:${hash}`
  })
}

export function verifyAnchors(memoryDir, anchors) {
  const root = dirname(memoryDir)
  const results = (Array.isArray(anchors) ? anchors : []).map((anchor) => {
    const match = /^file:(.+?)#sha256:([a-f0-9]{64})$/i.exec(String(anchor))
    if (!match) return { anchor: String(anchor), ok: false, reason: 'unknown anchor format' }
    const relativePath = match[1]
    const expected = match[2].toLowerCase()
    const absolutePath = resolve(root, relativePath)
    if (!isInsideWorkspace(root, absolutePath)) {
      return { anchor: String(anchor), ok: false, reason: 'outside workspace' }
    }
    if (!existsSync(absolutePath)) return { anchor: String(anchor), ok: false, reason: 'file missing' }
    try {
      const hash = createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
      return { anchor: String(anchor), ok: hash === expected, reason: hash === expected ? 'unchanged' : 'file changed' }
    } catch (error) {
      return { anchor: String(anchor), ok: false, reason: String(error?.message || error) }
    }
  })
  return { ok: results.every((item) => item.ok), anchors: results }
}

export function consolidateMemory(memoryDir) {
  const groups = new Map()
  for (const entry of scanEntries(memoryDir)) {
    if (entry.status === 'retired' || entry.status === 'superseded') continue
    const key = `${entry.type}|${normalizeTitle(entry.title)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }

  let mergedGroups = 0
  let superseded = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => (b.importance || 0) - (a.importance || 0) || String(b.updated || '').localeCompare(String(a.updated || '')))
    const keeper = group[0]
    const rest = group.slice(1)
    const tags = [...new Set(group.flatMap((entry) => entry.tags))]
    const entities = [...new Set(group.flatMap((entry) => entry.entities))]
    const sources = [...new Set(group.flatMap((entry) => entry.sources))]
    writeEntry(memoryDir, {
      mode: 'update',
      id: keeper.id,
      type: keeper.type,
      title: keeper.title,
      body: keeper.body,
      summary: keeper.summary,
      tags,
      entities,
      sources,
      importance: Math.max(...group.map((entry) => entry.importance || 3)),
      status: keeper.status === 'proposed' ? 'proposed' : 'active',
      collection: keeper.collection,
    })
    for (const entry of rest) {
      writeEntry(memoryDir, {
        mode: 'update',
        id: entry.id,
        type: entry.type,
        title: entry.title,
        body: entry.body,
        summary: entry.summary,
        tags: entry.tags,
        entities: entry.entities,
        sources: entry.sources,
        importance: entry.importance,
        status: 'superseded',
        links: [keeper.id],
        collection: entry.collection,
      })
      superseded += 1
    }
    mergedGroups += 1
  }

  const access = readAccess(memoryDir)
  const cutoff = Date.now() - 180 * 86_400_000
  let retired = 0
  for (const entry of scanEntries(memoryDir)) {
    if (entry.status !== 'active') continue
    const stamp = Date.parse(access[entry.id] || entry.updated || entry.observed_at || '')
    if (Number.isFinite(stamp) && stamp < cutoff) {
      writeEntry(memoryDir, {
        mode: 'update',
        id: entry.id,
        type: entry.type,
        title: entry.title,
        body: entry.body,
        summary: entry.summary,
        tags: entry.tags,
        entities: entry.entities,
        sources: entry.sources,
        importance: entry.importance,
        status: 'retired',
        collection: entry.collection,
      })
      retired += 1
    }
  }

  const after = scanEntries(memoryDir)
  writeIndexFiles(memoryDir, after)
  return { mergedGroups, superseded, retired, entries: after.length }
}

export function memoryStatus(memoryDir, options = {}) {
  const entries = scanEntries(memoryDir)
  const core = readCore(memoryDir)
  const boot = buildBootReport(memoryDir, options)
  const indexLines = existsSync(join(memoryDir, 'index.md'))
    ? readFileSync(join(memoryDir, 'index.md'), 'utf8').split(/\r?\n/).length
    : 0
  const staleCutoff = Date.now() - 180 * 86_400_000
  const access = readAccess(memoryDir)
  const cold = entries.filter((entry) => {
    if (entry.status !== 'active') return false
    const stamp = Date.parse(access[entry.id] || entry.updated || '')
    return Number.isFinite(stamp) && stamp < staleCutoff
  }).length
  return {
    entries: entries.length,
    active: entries.filter((entry) => entry.status === 'active').length,
    proposed: entries.filter((entry) => entry.status === 'proposed').length,
    suspect: entries.filter((entry) => entry.status === 'suspect').length,
    episodes: entries.filter((entry) => entry.type === 'episode').length,
    stale: entries.filter((entry) => Date.parse(entry.updated || '') < staleCutoff).length,
    cold,
    coreChars: Object.values(core).reduce((sum, value) => sum + value.length, 0),
    bootChars: boot.text.length,
    bootLimit: boot.maxChars,
    bootShown: boot.shown,
    bootTotal: boot.total,
    indexLines,
  }
}

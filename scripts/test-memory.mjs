import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildBootReport,
  buildIndexData,
  consolidateMemory,
  createFileAnchors,
  ensureLayout,
  getEntry,
  memoryStatus,
  readCore,
  readIndex,
  readSessionNote,
  scanEntries,
  searchEntries,
  sessionNoteId,
  updateCore,
  verifyAnchors,
  writeEntry,
  writeIndexFiles,
  writeSessionNote,
} from '../lib/memory-store.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
const memoryDir = join(root, 'memory')
const sessionId = '../session with spaces'

try {
  ensureLayout(memoryDir)
  updateCore(memoryDir, 'identity', '# 核心：我\n\n测试身份。')
  updateCore(memoryDir, 'user', '# 核心：你\n\n测试用户。')
  updateCore(memoryDir, 'active', '# 当前\n\n测试目标。')
  const core = readCore(memoryDir)
  assert.match(core.identity, /测试身份/)
  assert.match(core.user, /测试用户/)
  assert.match(core.active, /测试目标/)
  console.log('ok core')

  writeFileSync(join(root, 'sample.js'), 'export const x = 1\n')
  const anchors = createFileAnchors(memoryDir, ['sample.js'])
  assert.equal(anchors.length, 1)
  assert.equal(verifyAnchors(memoryDir, anchors).ok, true)

  const fact = writeEntry(memoryDir, {
    type: 'fact',
    title: '测试事实',
    body: '这是一个用于测试的事实条目，包含可检索的关键词：分层记忆。',
    tags: ['test', 'memory'],
    importance: 4,
    status: 'active',
  })
  writeEntry(memoryDir, {
    type: 'episode',
    title: '测试情景',
    body: '完成了一次测试。',
    tags: ['test'],
    importance: 3,
    status: 'active',
  })
  const dead = writeEntry(memoryDir, {
    type: 'dead_end',
    title: '测试负记忆',
    body: '这条路径不通。',
    tags: ['dead-end'],
    importance: 3,
    status: 'active',
    anchors,
  })
  console.log('ok entries')

  const entries = scanEntries(memoryDir)
  assert.equal(entries.length, 3)
  assert.equal(getEntry(entries, fact.id).title, '测试事实')
  writeIndexFiles(memoryDir, entries)
  assert.equal(readIndex(memoryDir).count, 3)
  assert.equal(buildIndexData(entries).count, 3)
  console.log('ok index')

  const search = searchEntries(entries, '分层记忆', { limit: 3 })
  assert.ok(search.results.some((item) => item.id === fact.id))
  console.log('ok search')

  const report = buildBootReport(memoryDir, { maxChars: 800, indexLimit: 60 })
  assert.ok(report.text.length <= 800, 'boot must respect maxChars')
  assert.equal(report.total, 2, 'dead_end must stay out of the boot index')
  assert.ok(report.text.includes('索引只显示') || report.shown === report.total)
  assert.ok(report.shown <= report.total)
  console.log('ok boot budget')

  const written = writeSessionNote(memoryDir, sessionId, '# 会话笔记\n\n## 当前任务\n测试')
  assert.match(sessionNoteId(sessionId), /^[a-zA-Z0-9_-]+$/)
  assert.match(readSessionNote(memoryDir, sessionId), /测试/)
  assert.ok(written.path.startsWith(memoryDir))
  console.log('ok session note')

  writeFileSync(join(root, 'sample.js'), 'export const x = 2\n')
  assert.equal(verifyAnchors(memoryDir, anchors).ok, false)
  console.log('ok anchors')

  const status = memoryStatus(memoryDir, { maxChars: 800, indexLimit: 60 })
  assert.equal(status.entries, 3)
  assert.equal(status.active, 3)
  assert.ok(status.bootChars <= 800)
  assert.equal(status.bootTotal, 2)
  assert.ok(status.bootShown <= status.bootTotal)
  console.log('ok status')

  const consolidated = consolidateMemory(memoryDir)
  assert.equal(typeof consolidated.entries, 'number')
  assert.equal(consolidated.entries, 3)
  console.log('ok consolidate')

  assert.ok(dead.id)
  console.log('\nall memory tests passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}

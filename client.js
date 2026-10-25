/**
 * Session memory Client half: a conversation view over the v2 store.
 *
 * Tabs: core identity/user/active, plus an index tab with search and detail.
 * Data arrives through the Workspace Files Remote; the view polls every 15s.
 * It is deliberately dependency-free: React is provided by the module loader
 * and every other service arrives through the plugin `ctx`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'sessionMemory'

    const DOCS = [
      { key: 'identity', path: 'memory/core/identity.md', label: 'doc.identity', hint: 'doc.identity.hint' },
      { key: 'user', path: 'memory/core/user.md', label: 'doc.user', hint: 'doc.user.hint' },
      { key: 'active', path: 'memory/core/active.md', label: 'doc.active', hint: 'doc.active.hint' },
      { key: 'index', path: 'memory/index.json', label: 'doc.index', hint: 'doc.index.hint' },
    ]

    const FILTERS = [
      { key: 'all', label: 'filter.all' },
      { key: 'preference', label: 'filter.preference' },
      { key: 'episode', label: 'filter.episode' },
      { key: 'procedure', label: 'filter.procedure' },
      { key: 'project', label: 'filter.project' },
      { key: 'reference', label: 'filter.reference' },
      { key: 'dead_end', label: 'filter.dead_end' },
    ]

    const zh = {
      'view.tab': '记忆',
      'view.title': '会话记忆',
      'view.subtitle': '核心常驻，深层按需检索',
      'view.refresh': '刷新',
      'view.tabsLabel': '记忆视图',
      'view.auto': '每 15 秒自动刷新',
      'view.truncated': '内容较长，仅显示前 5000 行',
      'view.retry': '重新读取',
      'view.footnote': '核心常驻；深层按需搜索；boot ≤ 2500 字符。',
      'view.footnote2': '位置：memory/core + memory/entries',
      'view.searchPlaceholder': '搜索标题、摘要、标签…',
      'view.searchEmpty': '没有匹配的条目',
      'view.indexMissing': '索引尚未生成',
      'view.entries': '条记忆',
      'view.back': '返回索引',
      'view.detail': '记忆详情',
      'doc.identity': '我是谁',
      'doc.identity.hint': '角色、原则、边界',
      'doc.user': '你是谁',
      'doc.user.hint': '偏好、沟通、背景',
      'doc.active': '当前',
      'doc.active.hint': '任务与下一步',
      'doc.index': '索引',
      'doc.index.hint': '搜索深层记忆',
      'filter.all': '全部',
      'filter.preference': '偏好',
      'filter.episode': '情景',
      'filter.procedure': '流程',
      'filter.project': '项目',
      'filter.reference': '资料',
      'filter.dead_end': '负记忆',
      'status.loading': '读取中…',
      'status.live': '已同步',
      'status.missing': '尚未建立',
      'status.error': '读取失败',
      'empty.title': '这份记忆还没有建立',
      'empty.body': '让 Agent 在会话中写一次，或手动创建 {path}。',
      'empty.file': '文件存在，但内容为空。',
      'empty.missing': '（尚未建立）',
      'error.title': '无法读取记忆文件',
      'error.retry': '再试一次',
      'md.empty': '（空文档）',
    }

    const en = {
      'view.tab': 'Memory',
      'view.title': 'Session memory',
      'view.subtitle': 'A small core, with deeper memory on demand',
      'view.refresh': 'Refresh',
      'view.tabsLabel': 'Memory view',
      'view.auto': 'Auto-refreshes every 15s',
      'view.truncated': 'Showing the first 5000 lines',
      'view.retry': 'Read again',
      'view.footnote': 'Core stays resident; deep entries load on demand; boot ≤ 2500 chars.',
      'view.footnote2': 'Location: memory/core + memory/entries',
      'view.searchPlaceholder': 'Search title, summary, tags…',
      'view.searchEmpty': 'No matching entries',
      'view.indexMissing': 'Index has not been generated',
      'view.entries': 'entries',
      'view.back': 'Back to index',
      'view.detail': 'Memory detail',
      'doc.identity': 'About me',
      'doc.identity.hint': 'Role, principles, boundaries',
      'doc.user': 'About you',
      'doc.user.hint': 'Preferences, communication, context',
      'doc.active': 'Current',
      'doc.active.hint': 'Task and next step',
      'doc.index': 'Index',
      'doc.index.hint': 'Search deep memory',
      'filter.all': 'All',
      'filter.preference': 'Preferences',
      'filter.episode': 'Episodes',
      'filter.procedure': 'Procedures',
      'filter.project': 'Projects',
      'filter.reference': 'References',
      'filter.dead_end': 'Dead ends',
      'status.loading': 'Reading…',
      'status.live': 'In sync',
      'status.missing': 'Not created',
      'status.error': 'Read failed',
      'empty.title': 'This memory has not been created yet',
      'empty.body': 'Ask the Agent to write it in a session, or create {path} manually.',
      'empty.file': 'The file exists but is empty.',
      'empty.missing': '(not created)',
      'error.title': 'Could not read the memory file',
      'error.retry': 'Try again',
      'md.empty': '(empty document)',
    }

    const CSS = String.raw`
      .dsh-memory-root {
        height: 100%;
        overflow: auto;
        box-sizing: border-box;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
      }
      .dsh-memory-shell {
        max-width: 920px;
        margin: 0 auto;
        padding: 28px 30px 64px;
      }
      .dsh-memory-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }
      .dsh-memory-heading { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .dsh-memory-mark {
        width: 40px; height: 40px; flex: none;
        display: flex; align-items: center; justify-content: center;
        border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-brand-primary);
      }
      .dsh-memory-title { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; }
      .dsh-memory-subtitle { margin: 3px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .dsh-memory-refresh {
        flex: none;
        display: inline-flex; align-items: center; gap: 6px;
        height: 32px; padding: 0 12px;
        border-radius: 9px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12.5px; cursor: pointer;
      }
      .dsh-memory-refresh:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .dsh-memory-refresh:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dsh-memory-tabs {
        display: flex; gap: 6px;
        width: fit-content;
        padding: 4px;
        margin-bottom: 14px;
        border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
      }
      .dsh-memory-tab {
        display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
        padding: 8px 14px;
        border: 0; border-radius: 9px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font: inherit; text-align: left; cursor: pointer;
      }
      .dsh-memory-tab:hover { color: var(--dsw-alias-label-primary); }
      .dsh-memory-tab[aria-selected="true"] {
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
      }
      .dsh-memory-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .dsh-memory-tab-label { font-size: 13px; font-weight: 600; line-height: 1.3; }
      .dsh-memory-tab-hint { font-size: 11.5px; line-height: 1.3; color: var(--dsw-alias-label-secondary); }
      .dsh-memory-meta {
        display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
        margin: 0 2px 10px;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-memory-path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        padding: 2px 7px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
      }
      .dsh-memory-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
      .dsh-memory-dot.is-live { background: var(--dsw-alias-state-success-primary); }
      .dsh-memory-dot.is-error { background: var(--dsw-alias-state-error-primary); }
      .dsh-memory-auto { margin-left: auto; }
      .dsh-memory-card {
        min-height: 320px;
        padding: 28px 32px;
        border-radius: 16px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
      }
      .dsh-memory-md { font-size: 14px; line-height: 1.75; overflow-wrap: anywhere; }
      .dsh-memory-md > :first-child { margin-top: 0; }
      .dsh-memory-h1 { margin: 0 0 14px; font-size: 23px; line-height: 1.3; font-weight: 700; letter-spacing: -0.015em; }
      .dsh-memory-h2 { margin: 26px 0 10px; font-size: 18px; line-height: 1.35; font-weight: 650; letter-spacing: -0.01em; }
      .dsh-memory-h3 { margin: 20px 0 8px; font-size: 15.5px; line-height: 1.4; font-weight: 650; }
      .dsh-memory-h4 { margin: 16px 0 6px; font-size: 14px; line-height: 1.4; font-weight: 650; color: var(--dsw-alias-label-secondary); }
      .dsh-memory-p { margin: 0 0 12px; }
      .dsh-memory-ul, .dsh-memory-ol { margin: 0 0 12px; padding-left: 22px; }
      .dsh-memory-li { margin: 4px 0; }
      .dsh-memory-li::marker { color: var(--dsw-alias-brand-primary); }
      .dsh-memory-quote {
        margin: 0 0 14px;
        padding: 2px 0 2px 14px;
        border-left: 3px solid var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-memory-quote .dsh-memory-p:last-child { margin-bottom: 0; }
      .dsh-memory-inline-code {
        padding: 1px 5px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px;
      }
      .dsh-memory-pre {
        margin: 0 0 14px;
        padding: 14px 16px;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        overflow: auto;
      }
      .dsh-memory-pre code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px; line-height: 1.6;
      }
      .dsh-memory-hr { margin: 22px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dsh-memory-a { color: var(--dsw-alias-brand-primary); text-decoration: underline; text-underline-offset: 2px; }
      .dsh-memory-strong { font-weight: 650; }
      .dsh-memory-table-wrap { margin: 0 0 16px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
      .dsh-memory-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .dsh-memory-table th, .dsh-memory-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
      .dsh-memory-table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
      .dsh-memory-table tr:last-child td { border-bottom: 0; }
      .dsh-memory-empty {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 10px; min-height: 280px; padding: 40px 20px; text-align: center;
      }
      .dsh-memory-empty-mark {
        width: 52px; height: 52px; display: flex; align-items: center; justify-content: center;
        border-radius: 15px; border: 1px dashed var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
      }
      .dsh-memory-empty-title { margin: 4px 0 0; font-size: 15px; font-weight: 600; }
      .dsh-memory-empty-body { margin: 0; max-width: 430px; font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
      .dsh-memory-empty-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .dsh-memory-button {
        height: 32px; padding: 0 14px;
        border-radius: 9px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12.5px; cursor: pointer;
      }
      .dsh-memory-button:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .dsh-memory-banner {
        margin: 0 0 14px;
        padding: 9px 12px;
        border-radius: 9px;
        border: 1px solid var(--dsw-alias-state-error-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
        color: var(--dsw-alias-label-primary);
        font-size: 12.5px;
      }
      .dsh-memory-skeleton { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
      .dsh-memory-skeleton span { display: block; height: 12px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); animation: dsh-memory-pulse 1.4s ease-in-out infinite; }
      .dsh-memory-skeleton span:nth-child(1) { width: 38%; height: 18px; }
      .dsh-memory-skeleton span:nth-child(2) { width: 92%; }
      .dsh-memory-skeleton span:nth-child(3) { width: 84%; }
      .dsh-memory-skeleton span:nth-child(4) { width: 88%; }
      .dsh-memory-skeleton span:nth-child(5) { width: 64%; }
      .dsh-memory-skeleton span:nth-child(6) { width: 78%; }
      @keyframes dsh-memory-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
      .dsh-memory-filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
      .dsh-memory-filter {
        height: 28px; padding: 0 10px; border-radius: 7px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 11.5px; cursor: pointer;
      }
      .dsh-memory-filter.is-active {
        color: var(--dsw-alias-brand-primary);
        border-color: var(--dsw-alias-brand-primary);
        background: var(--dsw-alias-bg-layer-1);
      }
      .dsh-memory-search {
        width: 100%; box-sizing: border-box; height: 38px; padding: 0 12px; margin: 0 0 12px;
        border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px; outline: none;
      }
      .dsh-memory-search:focus { border-color: var(--dsw-alias-brand-primary); }
      .dsh-memory-list { display: flex; flex-direction: column; gap: 8px; }
      .dsh-memory-list-item {
        display: block; width: 100%; box-sizing: border-box; text-align: left;
        padding: 12px 14px; border-radius: 11px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font: inherit; cursor: pointer;
      }
      .dsh-memory-list-item:hover { border-color: var(--dsw-alias-brand-primary); }
      .dsh-memory-list-title { display: block; font-size: 13.5px; font-weight: 600; line-height: 1.4; }
      .dsh-memory-list-summary { display: block; margin-top: 3px; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh-memory-list-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dsh-memory-chip { padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
      .dsh-memory-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
      .dsh-memory-back {
        display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px;
        border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .dsh-memory-back:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .dsh-memory-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dsh-memory-foot {
        display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px;
        margin-top: 14px; padding: 0 2px;
        font-size: 11.5px; color: var(--dsw-alias-label-secondary);
      }
      @media (max-width: 640px) {
        .dsh-memory-shell { padding: 18px 16px 40px; }
        .dsh-memory-card { padding: 20px; border-radius: 13px; }
        .dsh-memory-tab-hint { display: none; }
        .dsh-memory-auto { display: none; }
      }
    `

    const HEADING_RE = /^(#{1,4})\s+(.*)$/
    const UL_RE = /^\s*[-*]\s+/
    const OL_RE = /^\s*\d+\.\s+/
    const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
    const FENCE_RE = /^\s*```(.*)$/
    const QUOTE_RE = /^\s*>\s?/
    const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/

    function splitRow(line) {
      let value = line.trim()
      if (value.startsWith('|')) value = value.slice(1)
      if (value.endsWith('|')) value = value.slice(0, -1)
      return value.split('|').map((cell) => cell.trim())
    }

    function isBlockStart(line, next) {
      return HEADING_RE.test(line) || FENCE_RE.test(line) || HR_RE.test(line)
        || UL_RE.test(line) || OL_RE.test(line) || QUOTE_RE.test(line)
        || (line.includes('|') && typeof next === 'string' && TABLE_SEP_RE.test(next))
    }

    function parseBlocks(text) {
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) { i += 1; continue }

        const fence = FENCE_RE.exec(line)
        if (fence) {
          const lang = fence[1].trim()
          i += 1
          const code = []
          while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
          if (i < lines.length) i += 1
          blocks.push({ type: 'code', lang, text: code.join('\n') })
          continue
        }

        const heading = HEADING_RE.exec(line)
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
          i += 1
          continue
        }

        if (HR_RE.test(line)) {
          blocks.push({ type: 'hr' })
          i += 1
          continue
        }

        if (QUOTE_RE.test(line)) {
          const quote = []
          while (i < lines.length && QUOTE_RE.test(lines[i])) {
            quote.push(lines[i].replace(QUOTE_RE, ''))
            i += 1
          }
          blocks.push({ type: 'quote', text: quote.join('\n') })
          continue
        }

        if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
          const header = splitRow(line)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
            rows.push(splitRow(lines[i]))
            i += 1
          }
          blocks.push({ type: 'table', header, rows })
          continue
        }

        if (UL_RE.test(line) || OL_RE.test(line)) {
          const ordered = OL_RE.test(line)
          const marker = ordered ? OL_RE : UL_RE
          const items = []
          while (i < lines.length && marker.test(lines[i])) {
            let item = lines[i].replace(marker, '').trim()
            i += 1
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !marker.test(lines[i])) {
              item += ` ${lines[i].trim()}`
              i += 1
            }
            items.push(item)
          }
          blocks.push({ type: 'list', ordered, items })
          continue
        }

        const paragraph = []
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
          paragraph.push(lines[i].trim())
          i += 1
        }
        blocks.push({ type: 'p', text: paragraph.join(' ') })
      }
      return blocks
    }

    function inline(text, prefix) {
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g
      const out = []
      let last = 0
      let match
      let n = 0
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) out.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          out.push(h('strong', { key: `${prefix}-b-${n++}`, className: 'dsh-memory-strong' }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          out.push(h('code', { key: `${prefix}-c-${n++}`, className: 'dsh-memory-inline-code' }, token.slice(1, -1)))
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          const href = link && /^(https?:|mailto:|#|\/)/.test(link[2]) ? link[2] : '#'
          out.push(h('a', { key: `${prefix}-a-${n++}`, className: 'dsh-memory-a', href, target: '_blank', rel: 'noreferrer' }, link ? link[1] : token))
        } else {
          out.push(h('em', { key: `${prefix}-e-${n++}` }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    function renderBlock(block, index) {
      const key = `b-${index}`
      switch (block.type) {
        case 'heading': {
          const tag = `h${block.level}`
          return h(tag, { key, className: `dsh-memory-h${block.level}` }, inline(block.text, key))
        }
        case 'p':
          return h('p', { key, className: 'dsh-memory-p' }, inline(block.text, key))
        case 'quote':
          return h('blockquote', { key, className: 'dsh-memory-quote' }, h('p', { className: 'dsh-memory-p' }, inline(block.text, key)))
        case 'list':
          return h(block.ordered ? 'ol' : 'ul', { key, className: block.ordered ? 'dsh-memory-ol' : 'dsh-memory-ul' },
            block.items.map((item, i) => h('li', { key: `${key}-${i}`, className: 'dsh-memory-li' }, inline(item, `${key}-${i}`))))
        case 'code':
          return h('pre', { key, className: 'dsh-memory-pre' }, h('code', { className: block.lang ? `language-${block.lang}` : undefined }, block.text))
        case 'hr':
          return h('hr', { key, className: 'dsh-memory-hr' })
        case 'table':
          return h('div', { key, className: 'dsh-memory-table-wrap' },
            h('table', { className: 'dsh-memory-table' },
              h('thead', null, h('tr', null, block.header.map((cell, i) => h('th', { key: `${key}-h-${i}` }, inline(cell, `${key}-h-${i}`))))),
              h('tbody', null, block.rows.map((row, r) => h('tr', { key: `${key}-r-${r}` },
                row.map((cell, c) => h('td', { key: `${key}-r-${r}-c-${c}` }, inline(cell, `${key}-r-${r}-c-${c}`))))))))
        default:
          return null
      }
    }

    function Markdown({ text, emptyLabel }) {
      const body = React.useMemo(() => String(text || '').replace(/<!--[\s\S]*?-->/g, ''), [text])
      const blocks = React.useMemo(() => parseBlocks(body), [body])
      if (blocks.length === 0) {
        return h('p', { className: 'dsh-memory-p', style: { color: 'var(--dsw-alias-label-secondary)' } }, emptyLabel)
      }
      return h('div', { className: 'dsh-memory-md' }, blocks.map(renderBlock))
    }

    function MarkIcon() {
      return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M7 4.5h9.5A1.5 1.5 0 0 1 18 6v13a1.5 1.5 0 0 1-1.5 1.5H7' }),
        h('path', { d: 'M7 4.5A2.5 2.5 0 0 0 4.5 7v11A2.5 2.5 0 0 0 7 20.5' }),
        h('path', { d: 'M9 8.5h5M9 12h5M9 15.5h3' }))
    }

    function RefreshIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }),
        h('path', { d: 'M20 5v6h-6' }))
    }

    function useMemoryDoc(remote, sessionId, path, nonce) {
      const [state, setState] = React.useState({ status: path ? 'loading' : 'idle', path })
      React.useEffect(() => {
        if (!path) {
          setState({ status: 'idle', path: '' })
          return undefined
        }
        let alive = true
        const controller = new AbortController()
        setState((prev) => ({
          status: 'loading',
          path,
          text: prev.path === path ? prev.text : undefined,
        }))
        const run = async () => {
          try {
            const result = await remote.workspaceFiles.read(sessionId, path, { limit: 5000 }, controller.signal)
            if (!alive) return
            if (result && result.ok === false) {
              const failure = result.error || result
              setState((prev) => ({
                status: 'error',
                path,
                code: failure && failure.code,
                message: String((failure && failure.message) || failure),
                text: prev.path === path ? prev.text : undefined,
              }))
              return
            }
            const value = result && result.ok === true && result.value !== undefined ? result.value : result
            if (!value) throw new Error('workspaceFiles.read returned an empty result')
            setState({
              status: 'live',
              path,
              text: value.text || '',
              version: value.version,
              eof: value.eof,
            })
          } catch (error) {
            if (!alive || controller.signal.aborted) return
            const code = error && (error.code || (error.failure && error.failure.code))
            setState((prev) => ({
              status: 'error',
              path,
              code,
              message: String((error && error.message) || error),
              text: prev.path === path ? prev.text : undefined,
            }))
          }
        }
        run()
        return () => { alive = false; controller.abort() }
      }, [remote, sessionId, path, nonce])
      return state
    }

    function makeView(remote, t) {
      return function SessionMemoryView(props) {
        const sessionId = props.sessionId
        const [activeKey, setActiveKey] = React.useState('identity')
        const [nonce, setNonce] = React.useState(0)
        const [query, setQuery] = React.useState('')
        const [filterType, setFilterType] = React.useState('all')
        const [selectedId, setSelectedId] = React.useState(null)
        const bump = React.useCallback(() => setNonce((n) => n + 1), [])
        const activeDoc = DOCS.find((doc) => doc.key === activeKey) || DOCS[0]
        const isIndex = activeKey === 'index'
        const loaded = useMemoryDoc(remote, sessionId, activeDoc.path, nonce)
        const state = loaded.path === activeDoc.path ? loaded : { status: 'loading', path: activeDoc.path }

        const indexData = React.useMemo(() => {
          if (!isIndex || state.status !== 'live' || !state.text) return null
          try {
            return JSON.parse(state.text)
          } catch {
            return null
          }
        }, [isIndex, state.status, state.text])

        const allEntries = indexData && Array.isArray(indexData.entries) ? indexData.entries : []
        const filteredEntries = React.useMemo(() => {
          const needle = query.trim().toLowerCase()
          return allEntries.filter((entry) => {
            if (filterType !== 'all' && entry.type !== filterType) return false
            if (!needle) return true
            const haystack = [entry.title, entry.summary, entry.type, ...(entry.tags || [])]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
            return haystack.includes(needle)
          })
        }, [allEntries, query, filterType])
        const selectedEntry = selectedId ? allEntries.find((entry) => entry.id === selectedId) : null
        const entryPath = selectedEntry ? `memory/${selectedEntry.path}` : ''
        const entryDoc = useMemoryDoc(remote, sessionId, entryPath, nonce)
        const entryState = selectedEntry && entryDoc.path === entryPath
          ? entryDoc
          : { status: 'idle', path: '' }

        React.useEffect(() => {
          const timer = setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') bump()
          }, 15000)
          return () => clearInterval(timer)
        }, [bump])

        React.useEffect(() => {
          if (state.status !== 'error') return undefined
          const timer = setTimeout(bump, 12000)
          return () => clearTimeout(timer)
        }, [state.status, bump])

        const metaState = isIndex && selectedEntry ? entryState : state
        const statusKey = metaState.status === 'live'
          ? 'status.live'
          : metaState.status === 'error'
            ? (String(metaState.code || '').includes('not-found') ? 'status.missing' : 'status.error')
            : 'status.loading'
        const dotClass = metaState.status === 'live' ? 'is-live' : metaState.status === 'error' ? 'is-error' : 'is-loading'
        const missing = metaState.status === 'error' && String(metaState.code || '').includes('not-found')
        const metaPath = isIndex && selectedEntry ? `memory/${selectedEntry.path}` : activeDoc.path

        const skeleton = () => h('div', { className: 'dsh-memory-skeleton', 'aria-hidden': true },
          h('span'), h('span'), h('span'), h('span'), h('span'), h('span'))

        const renderError = (failure, title) => h('div', { className: 'dsh-memory-empty' },
          h('div', { className: 'dsh-memory-empty-mark' }, h(MarkIcon)),
          h('h2', { className: 'dsh-memory-empty-title' }, title),
          h('p', { className: 'dsh-memory-empty-body' }, failure && failure.message ? failure.message : t('error.retry')),
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: bump }, t('view.retry')))

        let body
        if (isIndex && selectedEntry) {
          body = h('div', null,
            h('div', { className: 'dsh-memory-detail-head' },
              h('button', { type: 'button', className: 'dsh-memory-back', onClick: () => setSelectedId(null) }, `← ${t('view.back')}`),
              h('span', { className: 'dsh-memory-count' }, `${selectedEntry.type} · ${selectedEntry.importance} · ${selectedEntry.status}`)),
            entryState.status === 'loading' || entryState.status === 'idle'
              ? skeleton()
              : entryState.status === 'error'
                ? renderError(entryState, t('error.title'))
                : h(Markdown, { text: entryState.text, emptyLabel: t('empty.missing') }))
        } else if (isIndex) {
          if (state.status === 'loading' && !state.text) {
            body = skeleton()
          } else if (state.status === 'error' && !state.text) {
            body = renderError(state, missing ? t('view.indexMissing') : t('error.title'))
          } else if (!indexData) {
            body = renderError({ message: t('view.indexMissing') }, t('view.indexMissing'))
          } else {
            body = h('div', null,
              h('div', { className: 'dsh-memory-filters' }, FILTERS.map((filter) => h('button', {
                key: filter.key,
                type: 'button',
                className: `dsh-memory-filter${filterType === filter.key ? ' is-active' : ''}`,
                onClick: () => setFilterType(filter.key),
              }, t(filter.label)))),
              h('input', {
                className: 'dsh-memory-search',
                type: 'search',
                value: query,
                onChange: (event) => setQuery(event.target.value),
                placeholder: t('view.searchPlaceholder'),
                'aria-label': t('view.searchPlaceholder'),
              }),
              h('div', { className: 'dsh-memory-count', style: { marginBottom: '10px' } },
                `${filteredEntries.length} ${t('view.entries')}`),
              filteredEntries.length
                ? h('div', { className: 'dsh-memory-list' }, filteredEntries.map((entry) => h('button', {
                    key: entry.id,
                    type: 'button',
                    className: 'dsh-memory-list-item',
                    onClick: () => setSelectedId(entry.id),
                  },
                  h('span', { className: 'dsh-memory-list-title' }, entry.title),
                  h('span', { className: 'dsh-memory-list-summary' }, entry.summary),
                  h('span', { className: 'dsh-memory-list-meta' },
                    h('span', { className: 'dsh-memory-chip' }, entry.type),
                    h('span', { className: 'dsh-memory-chip' }, `importance ${entry.importance}`),
                    h('span', { className: 'dsh-memory-chip' }, entry.status)))))
                : h('p', { className: 'dsh-memory-empty-body' }, t('view.searchEmpty')))
          }
        } else if (state.status === 'loading' && !state.text) {
          body = skeleton()
        } else if (state.status === 'error' && !state.text) {
          body = renderError(state, missing ? t('empty.title') : t('error.title'))
        } else if (state.status === 'live' && !state.text) {
          body = h('div', { className: 'dsh-memory-empty' },
            h('div', { className: 'dsh-memory-empty-mark' }, h(MarkIcon)),
            h('p', { className: 'dsh-memory-empty-body' }, t('empty.file')))
        } else {
          body = h('div', null,
            state.status === 'error'
              ? h('div', { className: 'dsh-memory-banner', role: 'alert' }, `${t('error.title')}：${state.message}`)
              : null,
            h(Markdown, { text: state.text, emptyLabel: t('empty.missing') }))
        }

        return h('div', { className: 'dsh-memory-root' },
          h('style', null, CSS),
          h('div', { className: 'dsh-memory-shell' },
            h('header', { className: 'dsh-memory-head' },
              h('div', { className: 'dsh-memory-heading' },
                h('span', { className: 'dsh-memory-mark' }, h(MarkIcon)),
                h('div', null,
                  h('h1', { className: 'dsh-memory-title' }, t('view.title')),
                  h('p', { className: 'dsh-memory-subtitle' }, t('view.subtitle')))),
              h('button', { type: 'button', className: 'dsh-memory-refresh', onClick: bump, title: t('view.refresh'), 'aria-label': t('view.refresh') },
                h(RefreshIcon),
                h('span', null, t('view.refresh')))),
            h('div', { className: 'dsh-memory-tabs', role: 'tablist', 'aria-label': t('view.tabsLabel') },
              DOCS.map((doc) => h('button', {
                key: doc.key,
                type: 'button',
                role: 'tab',
                'aria-selected': activeKey === doc.key,
                className: 'dsh-memory-tab',
                onClick: () => {
                  setActiveKey(doc.key)
                  setSelectedId(null)
                  setQuery('')
                  setFilterType('all')
                },
              },
              h('span', { className: 'dsh-memory-tab-label' }, t(doc.label)),
              h('span', { className: 'dsh-memory-tab-hint' }, t(doc.hint))))),
            h('div', { className: 'dsh-memory-meta' },
              h('span', { className: 'dsh-memory-path' }, metaPath),
              h('span', { className: `dsh-memory-dot ${dotClass}`, 'aria-hidden': true }),
              h('span', { role: 'status' }, t(statusKey)),
              metaState.status === 'live' && metaState.eof === false
                ? h('span', null, `· ${t('view.truncated')}`)
                : null,
              h('span', { className: 'dsh-memory-auto' }, t('view.auto'))),
            h('section', { className: 'dsh-memory-card', 'aria-live': 'polite' }, body),
            h('footer', { className: 'dsh-memory-foot' },
              h('span', null, t('view.footnote')),
              h('span', null, t('view.footnote2')))))
      }
    }

    return {
      inject: ['slots', 'remote', 'remote.workspaceFiles', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-memory: dictionaries')
        const t = ctx.locale.bind(NS)
        const View = makeView(ctx.remote, t)
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'memory',
          order: 20,
          label: () => t('view.tab'),
        }, View))
      },
    }
  },
})

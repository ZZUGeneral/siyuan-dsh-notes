window.__ModuleLoader__.load({
  id: 'siyuan-dsh-notes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const e = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    // DSH 的共享 Markdown 渲染器（与聊天区、编辑器预览同一套）。拿不到时退回本文件
    // 自带的轻量渲染，保证旧版本 DSH 上抽屉仍然可用。
    const HostMarkdown = (() => {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const component = primitives === null || primitives === undefined ? undefined : primitives.MarkdownText
        // memo/forwardRef 包装过的组件是对象不是函数，只要拿得到就交给 React 渲染。
        return component === null || component === undefined ? null : component
      } catch (error) {
        return null
      }
    })()

    // 便于在浏览器控制台确认当前走的是哪套渲染（不参与任何逻辑）。
    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[siyuan-notes] markdown renderer:', HostMarkdown === null ? 'local-fallback' : 'dsh-markdown-text')
    }

    const API_PREFIX = '/siyuan-notes/api'

    // ── 文案 ──────────────────────────────────────────────────────────────────

    const ZH = {
      nav: '思源笔记',
      toggle: '思源笔记侧边栏',
      drawerTitle: '思源笔记',
      close: '关闭',
      refresh: '刷新',
      loading: '加载中…',
      server: '服务器地址',
      serverHint: '思源内核的地址，默认 http://127.0.0.1:6806。',
      token: 'API Token',
      tokenHint: 'Token 在思源「设置 → 关于 → API token」里查看或生成。\u5fc5填：留空时插件不会以任何身份访问思源。',
      tokenSave: '保存',
      tokenClear: '清除',
      tokenSaved: '已保存到凭据库',
      test: '测试连接',
      testing: '测试中…',
      connected: '已连接',
      unreachable: '连不上',
      authFailed: 'Token 无效',
      tokenMissing: '未配置 Token',
      version: '内核版本',
      notSet: '未设置',
      defaultNotebook: '默认笔记本',
      tools: '工具开关',
      toolsHint: '关闭的工具不会出现在模型可用的工具列表里。写操作与删除默认关闭。',
      toolsRefresh: '刷新工具列表',
      notebook: '笔记本',
      search: '搜索',
      searchPlaceholder: '全文检索思源笔记…',
      searchEmpty: '没有命中结果。',
      docs: '文档',
      docsEmpty: '这个位置没有文档。',
      up: '上一级',
      back: '返回列表',
      copy: '复制 Markdown',
      copied: '已复制',
      truncated: '内容过长，已截断。',
      noToken: '未配置 API Token：工具与这个面板都会拒绝访问（插件不会以匿名身份读写思源）。Token 在思源「设置 → 关于 → API token」里查看或生成。',
      useHere: '设为默认笔记本',
      groupRead: '读取',
      groupWrite: '写入',
      groupDaily: '日记',
      groupDanger: '删除',
      readFailed: '读取失败',
      kernelNotReady: '插件尚未连上思源内核，请到设置页检查地址与 Token。',
    }

    const EN = {
      nav: 'SiYuan Notes',
      toggle: 'SiYuan notes panel',
      drawerTitle: 'SiYuan Notes',
      close: 'Close',
      refresh: 'Refresh',
      loading: 'Loading…',
      server: 'Server address',
      serverHint: 'Address of the SiYuan kernel. Default: http://127.0.0.1:6806.',
      token: 'API token',
      tokenHint: 'Required. Find or generate one in SiYuan under Settings \u2192 About \u2192 API token. Leaving it blank prevents the plugin from accessing SiYuan.',
      tokenSave: 'Save',
      tokenClear: 'Clear',
      tokenSaved: 'Saved to the credential store',
      test: 'Test connection',
      testing: 'Testing…',
      connected: 'Connected',
      unreachable: 'Unreachable',
      authFailed: 'Token rejected',
      tokenMissing: 'No token',
      version: 'Kernel version',
      notSet: 'Not set',
      defaultNotebook: 'Default notebook',
      tools: 'Tools',
      toolsHint: 'Disabled tools never reach the model. Writes and deletes are off by default.',
      toolsRefresh: 'Refresh tools',
      notebook: 'Notebook',
      search: 'Search',
      searchPlaceholder: 'Full-text search your notes…',
      searchEmpty: 'No matches.',
      docs: 'Documents',
      docsEmpty: 'No documents here.',
      up: 'Up',
      back: 'Back to list',
      copy: 'Copy Markdown',
      copied: 'Copied',
      truncated: 'Content was truncated.',
      noToken: 'No API token configured: every tool and this panel will refuse to run (the plugin never reads or writes SiYuan anonymously). Find or generate one in SiYuan under Settings → About → API token.',
      useHere: 'Use as default notebook',
      groupRead: 'Read',
      groupWrite: 'Write',
      groupDaily: 'Daily note',
      groupDanger: 'Delete',
      readFailed: 'Read failed',
      kernelNotReady: 'Not connected to a SiYuan kernel yet — check the address and token in Settings.',
    }

    const GROUP_LABEL = {
      zh: { read: ZH.groupRead, write: ZH.groupWrite, daily: ZH.groupDaily, danger: ZH.groupDanger },
      en: { read: EN.groupRead, write: EN.groupWrite, daily: EN.groupDaily, danger: EN.groupDanger },
    }

    /**
     * 工具开关的人话名称：设置页给用户看的是"能做什么"，真名只在 title 里做提示。
     * 文案写在这里，是因为工具名是稳定契约，而设置页只拿得到 name/group/enabled。
     */
    const TOOL_TEXT = {
      zh: {
        siyuan_list_notebooks: { label: '列出笔记本', desc: '看有哪些笔记本及其 id' },
        siyuan_list_docs: { label: '列出文档', desc: '浏览某个目录下的文档' },
        siyuan_search: { label: '全文检索', desc: '按关键词搜内容，返回命中块' },
        siyuan_read_doc: { label: '读整篇文档', desc: '取一篇文档的 Markdown 全文' },
        siyuan_get_child_blocks: { label: '读子块', desc: '列出一个块直接挂着的子块' },
        siyuan_get_block_attrs: { label: '读块属性', desc: '取块 id、标题、时间等属性' },
        siyuan_sql: { label: '只读查询', desc: '对 blocks 表跑单条 SELECT' },
        siyuan_create_doc: { label: '新建文档', desc: '在指定位置创建 Markdown 文档' },
        siyuan_append_block: { label: '追加内容', desc: '往文档或块末尾追加一段' },
        siyuan_insert_block: { label: '插入内容', desc: '插到某个块的前面或后面' },
        siyuan_update_block: { label: '改写块', desc: '用新 Markdown 覆盖一个块' },
        siyuan_set_block_attrs: { label: '写块属性', desc: '设置自定义属性，如书签、备注' },
        siyuan_move_doc: { label: '移动文档', desc: '换目录或换笔记本' },
        siyuan_rename_doc: { label: '重命名文档', desc: '改文档标题' },
        siyuan_daily_note: { label: '读写日记', desc: '读当天日记，或往里追加内容' },
        siyuan_delete_block: { label: '删除块', desc: '只删内容块，不删整篇文档' },
        siyuan_remove_doc: { label: '删除文档', desc: '整篇移入思源回收站' },
      },
      en: {
        siyuan_list_notebooks: { label: 'List notebooks', desc: 'See every notebook and its id' },
        siyuan_list_docs: { label: 'List documents', desc: 'Browse the documents in a folder' },
        siyuan_search: { label: 'Full-text search', desc: 'Find blocks by keyword' },
        siyuan_read_doc: { label: 'Read document', desc: 'Fetch a whole document as Markdown' },
        siyuan_get_child_blocks: { label: 'Read child blocks', desc: 'List the blocks directly under one block' },
        siyuan_get_block_attrs: { label: 'Read block attributes', desc: 'Get an id, title and timestamps' },
        siyuan_sql: { label: 'Read-only query', desc: 'Run one SELECT against the blocks table' },
        siyuan_create_doc: { label: 'Create document', desc: 'Create a Markdown document at a path' },
        siyuan_append_block: { label: 'Append content', desc: 'Add a paragraph at the end of a document or block' },
        siyuan_insert_block: { label: 'Insert content', desc: 'Insert before or after a block' },
        siyuan_update_block: { label: 'Rewrite block', desc: 'Replace one block with new Markdown' },
        siyuan_set_block_attrs: { label: 'Set block attributes', desc: 'Write custom attributes such as bookmark or memo' },
        siyuan_move_doc: { label: 'Move document', desc: 'Move to another folder or notebook' },
        siyuan_rename_doc: { label: 'Rename document', desc: 'Change a document title' },
        siyuan_daily_note: { label: 'Daily note', desc: 'Read today’s note or append to it' },
        siyuan_delete_block: { label: 'Delete block', desc: 'Remove one block; the document stays' },
        siyuan_remove_doc: { label: 'Delete document', desc: 'Move a whole document to the SiYuan trash' },
      },
    }

    /** 语言包注册 + 取词；拿不到 locale 服务就退回中文，界面不会空白。 */
    function setupI18n(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      const dictFor = (id) => (String(id).toLowerCase().startsWith('zh') ? ZH : EN)
      let t = (key) => ZH[key] ?? key
      if (locale !== undefined && locale !== null) {
        try {
          const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
          const ids = Array.isArray(snapshot?.locales) && snapshot.locales.length > 0 ? snapshot.locales.map((item) => item.id) : ['zh-CN', 'en-US']
          const dicts = new Map()
          for (const id of ids) {
            const dict = dictFor(id)
            dicts.set(id, dict)
            try {
              locale.register('siyuan-notes', id, dict)
            } catch {
              // 语言包重复注册之类的失败不该让界面挂掉
            }
          }
          if (typeof locale.bind === 'function') {
            const bound = locale.bind('siyuan-notes')
            const active = dicts.get(snapshot?.active) ?? dictFor(snapshot?.active ?? '')
            t = (key) => {
              try {
                const value = bound(key)
                return typeof value === 'string' && value !== '' ? value : active[key] ?? key
              } catch {
                return active[key] ?? key
              }
            }
          } else {
            const active = dicts.get(snapshot?.active) ?? dictFor(snapshot?.active ?? '')
            t = (key) => active[key] ?? key
          }
        } catch {
          t = (key) => ZH[key] ?? key
        }
      }
      return { t, groupLabel: (group) => (t === undefined ? group : GROUP_LABEL[dictForTeam(t)]?.[group] ?? group) }
    }

    /** 按当前语言决定组标签用哪套文案：中文 t 返回中文，其余返回英文。 */
    function dictForTeam(t) {
      return t('nav') === ZH.nav ? 'zh' : 'en'
    }

    // ── Host 路由客户端 ───────────────────────────────────────────────────────

    async function callHost(method, payload) {
      let response
      try {
        response = await fetch(`${API_PREFIX}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
      } catch (error) {
        throw new Error(`请求插件后端失败：${error instanceof Error ? error.message : String(error)}`)
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`插件后端返回了非 JSON 内容（HTTP ${response.status}）`)
      }
      if (body?.ok !== true) {
        const message = body?.error?.message
        throw new Error(typeof message === 'string' && message !== '' ? message : `插件后端返回错误（HTTP ${response.status}）`)
      }
      return body.value
    }

    // ── 样式 ──────────────────────────────────────────────────────────────────

    const CSS = `
.dsh-sn-section { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; }
.dsh-sn-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 16px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 12px; }
.dsh-sn-card-title { font-weight: 600; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsh-sn-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-sn-label { font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 76px; }
.dsh-sn-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dsh-sn-input { flex: 1; min-width: 180px; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-sn-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-sn-select { font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-sn-button { font-size: 12px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsh-sn-button:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-sn-button[disabled] { opacity: .5; cursor: default; }
.dsh-sn-button-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.dsh-sn-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dsh-sn-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dsh-sn-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dsh-sn-chip-error { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dsh-sn-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); line-height: 1.5; white-space: pre-wrap; }
.dsh-sn-tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(228px, 1fr)); gap: 8px 14px; }
.dsh-sn-check { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); line-height: 1.35; cursor: pointer; }
.dsh-sn-check input { margin: 2px 0 0; flex: none; }
.dsh-sn-tool-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-sn-tool-desc { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-sn-overlay { position: fixed; top: 0; right: 0; bottom: 0; width: 392px; max-width: 92vw; z-index: 60; pointer-events: auto; display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: -8px 0 24px rgba(0,0,0,.16); }
.dsh-sn-drawer-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-sn-drawer-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); flex: 1; }
.dsh-sn-drawer-body { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.dsh-sn-doclist { display: flex; flex-direction: column; gap: 2px; }
.dsh-sn-doc { text-align: left; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: none; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; display: flex; gap: 6px; align-items: baseline; }
.dsh-sn-doc:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-sn-doc-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-sn-crumb { font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dsh-sn-preview { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-sn-preview:not(.dsh-sn-preview-host) h1, .dsh-sn-preview:not(.dsh-sn-preview-host) h2, .dsh-sn-preview:not(.dsh-sn-preview-host) h3, .dsh-sn-preview:not(.dsh-sn-preview-host) h4, .dsh-sn-preview:not(.dsh-sn-preview-host) h5, .dsh-sn-preview:not(.dsh-sn-preview-host) h6 { margin: 10px 0 4px; }
.dsh-sn-preview:not(.dsh-sn-preview-host) code { font-family: var(--dsw-font-markdown-code-block-small, monospace); background: var(--dsw-alias-bg-layer-2); padding: 1px 4px; border-radius: 4px; }
.dsh-sn-preview:not(.dsh-sn-preview-host) pre { white-space: pre-wrap; background: var(--dsw-alias-bg-layer-2); padding: 8px; border-radius: 6px; overflow-x: auto; }
.dsh-sn-preview:not(.dsh-sn-preview-host) a { color: var(--dsw-alias-brand-primary); }
.dsh-sn-preview-host { font-size: 13px; line-height: 1.65; }
.dsh-sn-table-wrap { overflow-x: auto; margin: 8px 0; }
.dsh-sn-preview:not(.dsh-sn-preview-host) .dsh-sn-table { border-collapse: collapse; font-size: 11.5px; line-height: 1.45; }
.dsh-sn-preview:not(.dsh-sn-preview-host) .dsh-sn-table th, .dsh-sn-preview:not(.dsh-sn-preview-host) .dsh-sn-table td { border: 1px solid var(--dsw-alias-border-l2); padding: 4px 7px; text-align: left; vertical-align: top; }
.dsh-sn-preview:not(.dsh-sn-preview-host) .dsh-sn-table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; white-space: nowrap; }
.dsh-sn-preview:not(.dsh-sn-preview-host) .dsh-sn-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
.dsh-sn-preview:not(.dsh-sn-preview-host) blockquote { margin: 6px 0; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsh-sn-preview:not(.dsh-sn-preview-host) pre code { background: transparent; padding: 0; }
.dsh-sn-snippet { font-size: 11px; color: var(--dsw-alias-label-secondary); max-height: 40px; overflow: hidden; }
.dsh-sn-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-sn-icon-button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-sn-icon-button[data-active="true"] { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
`

    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-dsh-siyuan-notes]')
      if (existing !== null) return () => {}
      const style = document.createElement('style')
      style.setAttribute('data-dsh-siyuan-notes', '')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    // ── 图标 ──────────────────────────────────────────────────────────────────

    function Icon({ size = 16 }) {
      return e(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        e('rect', { x: 3.2, y: 3.2, width: 17.6, height: 17.6, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
        e('path', { d: 'M7.4 8.2h6.2M7.4 12h9.2M7.4 15.8h5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        e('circle', { cx: 17.6, cy: 16.8, r: 2.6, fill: 'var(--dsw-alias-bg-base)', stroke: 'currentColor', strokeWidth: 1.4 }),
        e('path', { d: 'M17.6 15.6v2.4M16.4 16.8h2.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      )
    }

    function Spinner() {
      return e(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        e('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 2.4, fill: 'none', opacity: 0.25 }),
        e('path', { d: 'M21 12a9 9 0 0 0-9-9', stroke: 'currentColor', strokeWidth: 2.4, fill: 'none', strokeLinecap: 'round' }),
      )
    }

    // ── Markdown 预览 ─────────────────────────────────────────────────────────
    // 首选 DSH 共享渲染器 MarkdownText（与聊天区/编辑器预览一致），拿不到时用下面的
    // 轻量渲染兜底：标题、列表、引用、代码块、表格、分割线、行内代码/粗体/斜体/链接。

    const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g

    function renderInline(text, keyPrefix) {
      const source = String(text)
      const out = []
      let cursor = 0
      let index = 0
      for (const match of source.matchAll(INLINE_RE)) {
        if (match.index > cursor) out.push(source.slice(cursor, match.index))
        const token = match[0]
        const key = `${keyPrefix}-i${index++}`
        if (token.startsWith('`')) out.push(e('code', { key }, token.slice(1, -1)))
        else if (token.startsWith('**')) out.push(e('strong', { key }, token.slice(2, -2)))
        else if (token.startsWith('__')) out.push(e('strong', { key }, token.slice(2, -2)))
        else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
          out.push(
            e(
              'a',
              { key, href: link === null ? '#' : link[2], target: '_blank', rel: 'noreferrer noopener' },
              link === null ? token : link[1],
            ),
          )
        } else out.push(e('em', { key }, token.slice(1, -1)))
        cursor = match.index + token.length
      }
      if (cursor < source.length) out.push(source.slice(cursor))
      return out
    }

    function splitTableRow(line) {
      return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    }

    function LocalMarkdown({ text }) {
      const nodes = useMemo(() => {
        const lines = String(text ?? '').split('\n')
        const out = []
        let fence = null
        let buffer = []
        const flushFence = (index) => {
          out.push(e('pre', { key: `pre-${index}` }, e('code', null, buffer.join('\n'))))
          buffer = []
          fence = null
        }
        let i = 0
        while (i < lines.length) {
          const line = lines[i]
          if (fence !== null) {
            if (line.trim().startsWith('```')) flushFence(i)
            else buffer.push(line)
            i += 1
            continue
          }
          if (line.trim().startsWith('```')) {
            fence = i
            i += 1
            continue
          }
          const heading = /^(#{1,6})\s+(.*)$/.exec(line)
          if (heading !== null) {
            const level = heading[1].length
            out.push(e(`h${level}`, { key: `h-${i}`, style: { fontSize: level <= 2 ? 15 : 13 } }, renderInline(heading[2], `h-${i}`)))
            i += 1
            continue
          }
          // 表格：当前行是 |…|，下一行是 |---|---| 形式
          if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            const header = splitTableRow(line)
            const tableKey = i
            i += 2
            const rows = []
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
              rows.push(splitTableRow(lines[i]))
              i += 1
            }
            out.push(
              e(
                'div',
                { key: `tw-${tableKey}`, className: 'dsh-sn-table-wrap' },
                e(
                  'table',
                  { className: 'dsh-sn-table' },
                  e(
                    'thead',
                    null,
                    e(
                      'tr',
                      null,
                      header.map((cell, index) => e('th', { key: `th-${index}` }, renderInline(cell, `th-${index}`))),
                    ),
                  ),
                  e(
                    'tbody',
                    null,
                    rows.map((row, rowIndex) =>
                      e(
                        'tr',
                        { key: `tr-${rowIndex}` },
                        row.map((cell, index) => e('td', { key: `td-${index}` }, renderInline(cell, `td-${rowIndex}-${index}`))),
                      ),
                    ),
                  ),
                ),
              ),
            )
            continue
          }
          if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
            out.push(e('hr', { key: `hr-${i}`, style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '10px 0' } }))
            i += 1
            continue
          }
          const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
          if (ordered !== null) {
            out.push(e('div', { key: `ol-${i}`, style: { display: 'flex', gap: 4 } }, e('span', { style: { flex: 'none' } }, `${ordered[1]}.`), e('span', null, renderInline(ordered[2], `ol-${i}`))))
            i += 1
            continue
          }
          const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
          if (bullet !== null) {
            const task = /^\[( |x|X)\]\s*(.*)$/.exec(bullet[1])
            const body = task === null ? bullet[1] : task[2]
            out.push(
              e(
                'div',
                { key: `li-${i}`, style: { display: 'flex', gap: 4 } },
                e('span', { style: { flex: 'none', opacity: 0.7 } }, task === null ? '•' : task[1].toLowerCase() === 'x' ? '☑' : '☐'),
                e('span', null, renderInline(body, `li-${i}`)),
              ),
            )
            i += 1
            continue
          }
          if (/^\s*>\s?/.test(line)) {
            out.push(
              e(
                'div',
                { key: `q-${i}`, style: { borderLeft: '2px solid var(--dsw-alias-border-l2)', paddingLeft: 8, color: 'var(--dsw-alias-label-secondary)' } },
                renderInline(line.replace(/^\s*>\s?/, ''), `q-${i}`),
              ),
            )
            i += 1
            continue
          }
          if (line.trim() === '') {
            i += 1
            continue
          }
          out.push(e('div', { key: `p-${i}`, style: { margin: '2px 0' } }, renderInline(line, `p-${i}`)))
          i += 1
        }
        if (fence !== null) flushFence(lines.length)
        return out
      }, [text])
      return e('div', { className: 'dsh-sn-preview' }, nodes)
    }

    // 宿主渲染器万一因为缺少上下文（例如没有 chrome labels / MarkdownDelegateProvider）
    // 而抛错，就退回本地渲染，不让整个抽屉白屏。
    const BoundaryBase = typeof React.Component === 'function' ? React.Component : class { constructor(props) { this.props = props } }

    class HostMarkdownBoundary extends BoundaryBase {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        if (this.state.failed) return e(LocalMarkdown, { text: this.props.text })
        return e(HostMarkdown, { text: this.props.text })
      }
    }

    function MarkdownPreview({ markdown }) {
      const text = String(markdown ?? '')
      if (HostMarkdown !== null) {
        // 与聊天区一致的渲染；宿主组件自带排版与代码高亮，这里只给一个滚动容器。
        return e('div', { className: 'dsh-sn-preview dsh-sn-preview-host' }, e(HostMarkdownBoundary, { text }))
      }
      return e(LocalMarkdown, { text })
    }

    // ── 抽屉开合状态（header 按钮与浮层两个槽位共享）───────────────────────────

    function createDrawerStore() {
      const listeners = new Set()
      let open = false
      return {
        isOpen: () => open,
        setOpen(next) {
          if (open === next) return
          open = next
          for (const listener of listeners) listener()
        },
        toggle() {
          this.setOpen(!open)
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useStore(store) {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((value) => value + 1)), [store])
      return store
    }

    // ── 设置页 ────────────────────────────────────────────────────────────────

    function ToolChecklist({ t, tools, config, onToggle }) {
      const lang = dictForTeam(t) === 'zh' ? 'zh' : 'en'
      const text = TOOL_TEXT[lang]
      const groups = new Map()
      for (const tool of tools) {
        if (!groups.has(tool.group)) groups.set(tool.group, [])
        groups.get(tool.group).push(tool)
      }
      const order = ['read', 'write', 'daily', 'danger']
      const entries = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      return e(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        entries.map(([group, items]) =>
          e(
            'div',
            { key: group, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            e('div', { className: 'dsh-sn-label', style: { minWidth: 0 } }, GROUP_LABEL[lang][group] ?? group),
            e(
              'div',
              { className: 'dsh-sn-tools' },
              items.map((tool) => {
                const known = text[tool.name]
                return e(
                  'label',
                  {
                    key: tool.name,
                    className: 'dsh-sn-check',
                    // 真名留在这里：报错、写 SQL、查日志时要对得上，但不占版面。
                    title: known === undefined ? tool.name : `${known.label} · ${tool.name}`,
                  },
                  e('input', { type: 'checkbox', checked: tool.enabled === true, onChange: (event) => onToggle(tool.name, event.target.checked) }),
                  e(
                    'span',
                    { className: 'dsh-sn-tool-text' },
                    e('span', null, known === undefined ? tool.name : known.label),
                    known === undefined ? null : e('span', { className: 'dsh-sn-tool-desc' }, known.desc),
                  ),
                )
              }),
            ),
          ),
        ),
      )
    }

    function SettingsSection({ t }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [draftBaseUrl, setDraftBaseUrl] = useState('')
      const [draftToken, setDraftToken] = useState('')
      const [probe, setProbe] = useState(null)
      const [notice, setNotice] = useState('')

      const reload = async () => {
        try {
          const value = await callHost('getState')
          setState(value)
          setDraftBaseUrl(value?.config?.baseUrl ?? '')
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      useEffect(() => {
        void reload()
      }, [])

      const saveConfig = async (patch) => {
        try {
          const value = await callHost('updateConfig', patch)
          setState(value)
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      const runTest = async () => {
        setBusy('test')
        setProbe(null)
        try {
          const value = await callHost('testConnection', { baseUrl: draftBaseUrl, token: draftToken })
          setProbe(value)
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }

      const saveToken = async () => {
        if (draftToken.trim() === '') return
        setBusy('token')
        try {
          await callHost('setToken', { token: draftToken.trim() })
          setDraftToken('')
          setNotice(t('tokenSaved'))
          await reload()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }

      const clearToken = async () => {
        setBusy('token')
        try {
          await callHost('clearToken', {})
          setNotice('')
          await reload()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }

      const toggleTool = async (name, enabled) => {
        const tools = {}
        tools[name] = enabled
        await saveConfig({ tools })
      }

      if (state === null) {
        return e(
          'div',
          { className: 'dsh-sn-section' },
          e('div', { className: 'dsh-sn-card' }, e('div', { className: 'dsh-sn-card-title' }, t('nav')), error !== '' ? e('div', { className: 'dsh-sn-error' }, error) : e('div', { className: 'dsh-sn-hint' }, t('loading'))),
        )
      }

      const notebooks = Array.isArray(state.notebooks) ? state.notebooks : []
      const tokenConfigured = state?.token?.configured === true
      // 三种"不能用"要分开说：连不上 / 没配 token / token 被拒。
      const kind =
        probe !== null
          ? probe.kind
          : state?.ready === true
            ? 'ok'
            : state?.reachable === true
              ? tokenConfigured
                ? 'auth'
                : 'no-token'
              : 'unreachable'
      const chipClass = kind === 'ok' ? 'dsh-sn-chip-ok' : kind === 'unreachable' ? 'dsh-sn-chip-warn' : 'dsh-sn-chip-error'
      const chipText =
        kind === 'ok'
          ? t('connected')
          : kind === 'auth'
            ? t('authFailed')
            : kind === 'no-token'
              ? t('tokenMissing')
              : t('unreachable')

      return e(
        'div',
        { className: 'dsh-sn-section' },
        e(
          'div',
          { className: 'dsh-sn-card' },
          e(
            'div',
            { className: 'dsh-sn-row' },
            e('div', { className: 'dsh-sn-card-title', style: { flex: 1 } }, t('nav')),
            e('span', { className: `dsh-sn-chip ${chipClass}` }, chipText),
            state?.version ? e('span', { className: 'dsh-sn-chip' }, `${t('version')} ${state.version}`) : null,
          ),
          e(
            'div',
            { className: 'dsh-sn-row' },
            e('span', { className: 'dsh-sn-label' }, t('server')),
            e('input', {
              className: 'dsh-sn-input',
              value: draftBaseUrl,
              spellCheck: false,
              onChange: (event) => setDraftBaseUrl(event.target.value),
              onBlur: () => {
                const next = draftBaseUrl.trim()
                if (next !== '' && next !== (state?.config?.baseUrl ?? '')) void saveConfig({ baseUrl: next })
              },
            }),
            e('button', { className: 'dsh-sn-button', disabled: busy !== '', onClick: () => void runTest() }, busy === 'test' ? t('testing') : t('test')),
          ),
          e('div', { className: 'dsh-sn-hint' }, t('serverHint')),
          error !== '' ? e('div', { className: 'dsh-sn-error' }, error) : null,
          probe !== null && probe.detail ? e('div', { className: 'dsh-sn-hint' }, String(probe.detail)) : null,
        ),
        e(
          'div',
          { className: 'dsh-sn-card' },
          e(
            'div',
            { className: 'dsh-sn-row' },
            e('span', { className: 'dsh-sn-label' }, t('token')),
            e('input', {
              className: 'dsh-sn-input',
              type: 'password',
              value: draftToken,
              placeholder: tokenConfigured ? (state?.token?.source === 'env' ? 'SIYUAN_NOTES_TOKEN (env)' : '••••••••') : t('notSet'),
              onChange: (event) => setDraftToken(event.target.value),
            }),
            e('button', { className: 'dsh-sn-button', disabled: busy !== '' || draftToken.trim() === '', onClick: () => void saveToken() }, t('tokenSave')),
            e('button', { className: 'dsh-sn-button', disabled: busy !== '' || !tokenConfigured, onClick: () => void clearToken() }, t('tokenClear')),
          ),
          e('div', { className: 'dsh-sn-hint' }, t('tokenHint')),
          notice !== '' ? e('div', { className: 'dsh-sn-hint' }, notice) : null,
          tokenConfigured ? null : e('div', { className: 'dsh-sn-error' }, t('noToken')),
        ),
        e(
          'div',
          { className: 'dsh-sn-card' },
          e(
            'div',
            { className: 'dsh-sn-row' },
            e('span', { className: 'dsh-sn-label' }, t('defaultNotebook')),
            e(
              'select',
              {
                className: 'dsh-sn-select',
                value: state?.config?.defaultNotebook ?? '',
                onChange: (event) => void saveConfig({ defaultNotebook: event.target.value }),
              },
              e('option', { value: '' }, t('notSet')),
              notebooks.map((notebook) => e('option', { key: notebook.id, value: notebook.id }, notebook.name ?? notebook.id)),
            ),
            e('button', { className: 'dsh-sn-button', onClick: () => void reload() }, t('refresh')),
          ),
        ),
        e(
          'div',
          { className: 'dsh-sn-card' },
          e('div', { className: 'dsh-sn-row' }, e('div', { className: 'dsh-sn-card-title', style: { flex: 1 } }, t('tools')), e('span', { className: 'dsh-sn-chip' }, `${state.toolCount ?? 0} / ${Array.isArray(state.tools) ? state.tools.length : 0}`)),
          e('div', { className: 'dsh-sn-hint' }, t('toolsHint')),
          e(ToolChecklist, { t, tools: Array.isArray(state.tools) ? state.tools : [], onToggle: (name, enabled) => void toggleTool(name, enabled) }),
        ),
      )
    }

    // ── 侧边抽屉 ──────────────────────────────────────────────────────────────

    function Drawer({ t, store }) {
      useStore(store)
      const open = store.isOpen()
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [notebook, setNotebook] = useState('')
      const [path, setPath] = useState('/')
      const [crumbs, setCrumbs] = useState([])
      const [docs, setDocs] = useState([])
      const [query, setQuery] = useState('')
      const [hits, setHits] = useState(null)
      const [doc, setDoc] = useState(null)
      const [copied, setCopied] = useState(false)
      const searchInput = useRef(null)

      const loadDocs = async (targetNotebook, targetPath) => {
        if (targetNotebook === '') return
        setBusy(true)
        try {
          const value = await callHost('listDocs', { notebook: targetNotebook, path: targetPath })
          setDocs(Array.isArray(value?.docs) ? value.docs : [])
          setPath(targetPath)
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setDocs([])
        } finally {
          setBusy(false)
        }
      }

      useEffect(() => {
        if (!open) return
        let cancelled = false
        void (async () => {
          try {
            const value = await callHost('getState')
            if (cancelled) return
            setState(value)
            const notebooks = Array.isArray(value?.notebooks) ? value.notebooks : []
            const preferred = value?.config?.defaultNotebook ?? ''
            const chosen = preferred !== '' && notebooks.some((item) => item.id === preferred) ? preferred : notebooks[0]?.id ?? ''
            setNotebook(chosen)
            setCrumbs([])
            setHits(null)
            if (chosen !== '') await loadDocs(chosen, '/')
          } catch (failure) {
            if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
          }
        })()
        return () => {
          cancelled = true
        }
      }, [open])

      useEffect(() => {
        if (open) setCopied(false)
      }, [doc])

      if (!open) return null

      const runSearch = async () => {
        const text = query.trim()
        if (text === '') {
          setHits(null)
          return
        }
        setBusy(true)
        try {
          const value = await callHost('search', { query: text, notebook: notebook !== '' ? notebook : undefined, limit: 20 })
          setHits(Array.isArray(value?.items) ? value.items : [])
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setHits([])
        } finally {
          setBusy(false)
        }
      }

      const openDoc = async (id) => {
        setBusy(true)
        try {
          const value = await callHost('readDoc', { id })
          setDoc({ id, hPath: value?.hPath ?? '', markdown: value?.markdown ?? '', truncated: value?.truncated === true })
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setDoc(null)
        } finally {
          setBusy(false)
        }
      }

      const enterDoc = (item) => {
        if ((item.subFileCount ?? 0) > 0) {
          setCrumbs((current) => [...current, { path, label: item.name ?? item.path }])
          void loadDocs(notebook, item.path)
          return
        }
        void openDoc(item.id)
      }

      const goUp = () => {
        if (crumbs.length === 0) return
        const next = crumbs[crumbs.length - 1]
        setCrumbs(crumbs.slice(0, -1))
        void loadDocs(notebook, next.path)
      }

      const notebooks = Array.isArray(state?.notebooks) ? state.notebooks : []

      return e(
        'div',
        { className: 'dsh-sn-overlay', role: 'complementary', 'aria-label': t('drawerTitle') },
        e(
          'div',
          { className: 'dsh-sn-drawer-head' },
          e(Icon, { size: 16 }),
          e('div', { className: 'dsh-sn-drawer-title' }, t('drawerTitle')),
          busy ? e('span', { className: 'dsh-sn-chip' }, e(Spinner)) : null,
          e('button', { className: 'dsh-sn-icon-button', title: t('refresh'), onClick: () => void loadDocs(notebook, path) }, e(Icon, { size: 14 })),
          e('button', { className: 'dsh-sn-icon-button', title: t('close'), onClick: () => store.setOpen(false) }, '✕'),
        ),
        e(
          'div',
          { className: 'dsh-sn-drawer-body' },
          state === null
            ? e('div', { className: 'dsh-sn-hint' }, t('loading'))
            : (state.reachable !== true || state.ready !== true)
              ? e('div', { className: 'dsh-sn-error' }, state.connectionError ? String(state.connectionError) : t('kernelNotReady'))
              : null,
          error !== '' ? e('div', { className: 'dsh-sn-error' }, error) : null,
          e(
            'div',
            { className: 'dsh-sn-row' },
            e('span', { className: 'dsh-sn-label', style: { minWidth: 40 } }, t('notebook')),
            e(
              'select',
              {
                className: 'dsh-sn-select',
                style: { flex: 1 },
                value: notebook,
                onChange: (event) => {
                  const next = event.target.value
                  setNotebook(next)
                  setCrumbs([])
                  setHits(null)
                  setDoc(null)
                  void loadDocs(next, '/')
                },
              },
              notebooks.map((item) => e('option', { key: item.id, value: item.id }, item.name ?? item.id)),
            ),
          ),
          e(
            'div',
            { className: 'dsh-sn-row' },
            e('input', {
              ref: searchInput,
              className: 'dsh-sn-input',
              placeholder: t('searchPlaceholder'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void runSearch()
                if (event.key === 'Escape') {
                  setQuery('')
                  setHits(null)
                }
              },
            }),
            e('button', { className: 'dsh-sn-button', onClick: () => void runSearch() }, t('search')),
          ),
          hits !== null
            ? e(
                'div',
                { className: 'dsh-sn-doclist' },
                e('div', { className: 'dsh-sn-row' }, e('span', { className: 'dsh-sn-label', style: { flex: 1, minWidth: 0 } }, `${t('search')} · ${hits.length}`), e('button', { className: 'dsh-sn-button', onClick: () => setHits(null) }, t('back'))),
                hits.length === 0
                  ? e('div', { className: 'dsh-sn-hint' }, t('searchEmpty'))
                  : hits.map((item) =>
                      e(
                        'button',
                        { key: `${item.id}-${item.rootID}`, className: 'dsh-sn-doc', onClick: () => void openDoc(item.id) },
                        e('span', { style: { flex: 1 } }, e('div', null, item.hPath !== '' ? item.hPath : item.id), e('div', { className: 'dsh-sn-snippet' }, String(item.snippet ?? ''))),
                        e('span', { className: 'dsh-sn-doc-count' }, item.type ?? ''),
                      ),
                    ),
              )
            : doc !== null
              ? e(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  e(
                    'div',
                    { className: 'dsh-sn-row' },
                    e('button', { className: 'dsh-sn-button', onClick: () => setDoc(null) }, t('back')),
                    e('span', { className: 'dsh-sn-crumb', style: { flex: 1 } }, doc.hPath !== '' ? doc.hPath : doc.id),
                    e(
                      'button',
                      {
                        className: 'dsh-sn-button',
                        onClick: async () => {
                          try {
                            await navigator.clipboard.writeText(doc.markdown)
                            setCopied(true)
                          } catch {
                            setCopied(false)
                          }
                        },
                      },
                      copied ? t('copied') : t('copy'),
                    ),
                  ),
                  doc.truncated ? e('div', { className: 'dsh-sn-hint' }, t('truncated')) : null,
                  e(MarkdownPreview, { markdown: doc.markdown }),
                )
              : e(
                  'div',
                  { className: 'dsh-sn-doclist' },
                  e(
                    'div',
                    { className: 'dsh-sn-row' },
                    crumbs.length > 0 ? e('button', { className: 'dsh-sn-button', onClick: goUp }, t('up')) : null,
                    e('span', { className: 'dsh-sn-crumb', style: { flex: 1 } }, crumbs.length > 0 ? crumbs.map((item) => item.label).join(' / ') : t('docs')),
                  ),
                  docs.length === 0
                    ? e('div', { className: 'dsh-sn-hint' }, t('docsEmpty'))
                    : docs.map((item) =>
                        e(
                          'button',
                          { key: item.id, className: 'dsh-sn-doc', onClick: () => enterDoc(item), title: item.path },
                          e('span', { style: { flex: 1 } }, item.name ?? item.path),
                          (item.subFileCount ?? 0) > 0 ? e('span', { className: 'dsh-sn-doc-count' }, `${item.subFileCount} ›`) : null,
                        ),
                      ),
                ),
        ),
      )
    }

    // ── 头部开关 ──────────────────────────────────────────────────────────────

    function HeaderToggle({ t, store }) {
      useStore(store)
      const open = store.isOpen()
      return e(
        'button',
        {
          className: 'dsh-sn-icon-button',
          'data-active': open ? 'true' : 'false',
          title: t('toggle'),
          'aria-label': t('toggle'),
          'aria-pressed': open ? 'true' : 'false',
          onClick: () => store.toggle(),
        },
        e(Icon, { size: 16 }),
      )
    }

    // ── 注册 ──────────────────────────────────────────────────────────────────

    const inject = ['slots']

    function apply(ctx) {
      const { t } = setupI18n(ctx)
      const disposeStyles = injectStyles()
      const store = createDrawerStore()
      const disposers = []

      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined || slots === null) {
        disposeStyles()
        return
      }

      const register = (name, options, component) => {
        disposers.push(slots.inject(name, () => slots.register({ name, ...options }, component)))
      }

      // 设置页 + 导航图标：id 用插件名，避免和旧插件的 siyuan 段抢同一格。
      register('settings.section.icon', { id: 'siyuan-notes', order: 60, label: () => t('nav') }, ({ size } = {}) => e(Icon, { size: size ?? 16 }))
      register('settings.section', { id: 'siyuan-notes', order: 60, label: () => t('nav') }, () => e(SettingsSection, { t }))
      // 聊天会话头部的开关 + 全帧浮层里的抽屉。
      register('conversation.session.header.utilities', { id: 'siyuan-notes:toggle', order: 15, label: () => t('toggle') }, () => e(HeaderToggle, { t, store }))
      register('shell.overlay', { id: 'siyuan-notes:drawer', order: 40, label: () => t('toggle') }, () => e(Drawer, { t, store }))

      ctx.effect(() => {
        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              // 清理失败不该冒泡
            }
          }
          disposeStyles()
        }
      }, 'dsh-siyuan-notes: client ui')
    }

    exports.inject = inject
    exports.apply = apply
    // 仅供 test/client-smoke.mjs 渲染断言使用。
    exports.internals = { MarkdownPreview, LocalMarkdown, hasHostMarkdown: () => HostMarkdown !== null }
    return module.exports
  },
})
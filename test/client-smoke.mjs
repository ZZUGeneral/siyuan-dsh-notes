// 无浏览器环境下的客户端冒烟测试：用假 React/假宿主加载 lib/client.js，
// 校验 apply() 的四个槽位注册，并把每个组件渲染一遍确认不抛错。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// ── 假 React ────────────────────────────────────────────────────────────────
const hooks = []
function createElement(type, props, ...children) {
  const merged = props === null || props === undefined ? {} : { ...props }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}
const React = {
  createElement,
  useState(initial) {
    hooks.push('useState')
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {
    hooks.push('useEffect')
  },
  useMemo(fn) {
    hooks.push('useMemo')
    return fn()
  },
  useRef(value) {
    hooks.push('useRef')
    return { current: value }
  },
  useCallback(fn) {
    hooks.push('useCallback')
    return fn
  },
}
React.default = React

// ── 假 DOM / 网络 ───────────────────────────────────────────────────────────
const appended = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, remove() {}, set textContent(_v) {} }),
  head: { appendChild: (node) => appended.push(node) },
}
if (globalThis.navigator === undefined) globalThis.navigator = {}
globalThis.navigator.clipboard = { writeText: async () => {} }
const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: init?.body })
  const method = String(url).split('/').pop()
  const value =
    method === 'getState'
      ? {
          config: { baseUrl: 'http://127.0.0.1:6806', defaultNotebook: '', tools: {} },
          token: { configured: true, source: 'file', writable: true },
          reachable: true,
          version: '3.8.10',
          connectionError: '',
          notebooks: [{ id: 'box-1', name: 'AI' }],
          toolGroups: ['read', 'write', 'daily', 'danger'],
          tools: [
            { name: 'siyuan_list_notebooks', group: 'read', enabled: true },
            { name: 'siyuan_append_block', group: 'write', enabled: false },
          ],
          toolCount: 1,
        }
      : method === 'listDocs'
        ? { notebook: 'box-1', path: '/', docs: [{ id: 'doc-1', name: 'One', path: '/One.sy', subFileCount: 0, hMtime: 0 }] }
        : method === 'readDoc'
          ? { id: 'doc-1', hPath: '/One', markdown: '# One\n\n- a\n\n```\ncode\n```', truncated: false }
          : method === 'search'
            ? { query: 'q', items: [{ id: 'doc-1', rootID: 'doc-1', hPath: '/One', type: 'd', box: 'box-1', snippet: 'q' }] }
            : {}
  return { ok: true, json: async () => ({ ok: true, value }) }
}

// ── 加载 client bundle ──────────────────────────────────────────────────────
let captured
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, exports: factory((name) => (name === 'react' ? React : {})) }
    },
  },
}
new Function('window', 'require', source)(globalThis.window, (name) => (name === 'react' ? React : {}))
if (captured === undefined) throw new Error('client bundle 没有调用 __ModuleLoader__.load')
if (captured.id !== 'siyuan-dsh-notes') throw new Error(`bundle id 不匹配: ${captured.id}`)

// ── 假宿主上下文 ────────────────────────────────────────────────────────────
const registrations = []
const disposers = []
let effectCleanup
const slots = {
  inject(name, callback) {
    callback()
    return () => disposers.push(name)
  },
  register(definition, component) {
    registrations.push({ definition, component })
    return () => {}
  },
}
const ctx = {
  get: () => undefined,
  effect(callback) {
    effectCleanup = callback()
  },
  slots,
}
captured.exports.apply(ctx)

const ids = registrations.map((item) => `${item.definition.name}#${item.definition.id}`)
const expected = [
  'settings.section.icon#siyuan-notes',
  'settings.section#siyuan-notes',
  'conversation.session.header.utilities#siyuan-notes:toggle',
  'shell.overlay#siyuan-notes:drawer',
]
for (const id of expected) {
  if (!ids.includes(id)) throw new Error(`缺少槽位注册: ${id}（实际 ${ids.join(', ')}）`)
}

// 每个组件渲染一遍（单次渲染，hooks 为假实现，只验证结构不抛错）
const tree = []
for (const { definition, component } of registrations) {
  hooks.length = 0
  const rendered = component({ size: 16, active: false })
  if (rendered === undefined) throw new Error(`${definition.name} 渲染返回 undefined`)
  tree.push(`${definition.name} → ${rendered?.type?.name ?? String(rendered?.type)}`)
}

// 设置页的工具开关显示中文名：宿主里每个工具名都必须有对应的展示文案。
const hostSource = readFileSync(join(here, '..', 'index.js'), 'utf8')
const hostNames = [...hostSource.matchAll(/name: '(siyuan_[a-z_]+)'/g)].map((match) => match[1])
const labelKeys = new Set([...source.matchAll(/^\s{8}(siyuan_[a-z_]+): \{ label:/gm)].map((match) => match[1]))
const missing = [...new Set(hostNames)].filter((name) => !labelKeys.has(name))
if (missing.length > 0) throw new Error(`这些工具没有中文展示文案：${missing.join(', ')}`)
if (labelKeys.size < 17) throw new Error(`工具展示文案只覆盖了 ${labelKeys.size} 个`)
tree.push(`工具文案覆盖 ${labelKeys.size}/${new Set(hostNames).size}`)
if (appended.length === 0) throw new Error('没有注入样式表')
if (typeof effectCleanup === 'function') effectCleanup()
console.log('client smoke ok')
console.log(tree.join('\n'))
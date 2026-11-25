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
// ── Markdown 预览：优先用宿主渲染器，缺它时用本地兜底 ──────────────────────
const { MarkdownPreview, LocalMarkdown } = captured.exports.internals ?? {}
if (typeof MarkdownPreview !== 'function') throw new Error('没有导出 MarkdownPreview')
if (captured.exports.internals.hasHostMarkdown()) throw new Error('假宿主不该解析出 MarkdownText')

// 兜底渲染：表格 / 粗体 / 链接 / 待办 / 分割线都要真的产出元素，而不是原样文本
hooks.length = 0
const local = LocalMarkdown({ text: '# 标题\n\n| a | b |\n| --- | --- |\n| **粗** | [链](https://x.test) |\n\n- [x] 完成\n\n---' })
const flattened = JSON.stringify(local)
for (const tag of ['"h1"', '"table"', '"strong"', '"a"', '"hr"']) {
  if (!flattened.includes(tag)) throw new Error(`兜底渲染缺少 ${tag} 元素`)
}
hooks.length = 0
const viaFallback = MarkdownPreview({ markdown: '# x' })
if (viaFallback?.type !== LocalMarkdown) throw new Error('没有宿主渲染器时应走本地渲染')
tree.push('Markdown 兜底渲染：标题/表格/粗体/链接/待办/分割线')

// 有宿主渲染器时：直接交给 DSH 的 MarkdownText
const MarkdownTextStub = (props) => ({ type: 'MarkdownTextStub', props })
let hostCaptured
globalThis.window.__ModuleLoader__.load = ({ id, factory }) => {
  hostCaptured = { id, exports: factory((name) => (name === 'react' ? React : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: MarkdownTextStub } : {})) }
}
new Function('window', 'require', source)(globalThis.window, (name) => (name === 'react' ? React : {}))
if (!hostCaptured.exports.internals.hasHostMarkdown()) throw new Error('应该解析到宿主 MarkdownText')
hooks.length = 0
const viaHost = hostCaptured.exports.internals.MarkdownPreview({ markdown: '# x' })
const boundary = viaHost?.props?.children
if (typeof boundary?.type !== 'function') throw new Error('宿主渲染路径应经过错误边界')
if (boundary.props?.text !== '# x') throw new Error('MarkdownText 的 text 参数没有透传')
// 边界组件正常渲染时应把 text 交给宿主 MarkdownText
hooks.length = 0
const boundaryInstance = new boundary.type(boundary.props)
boundaryInstance.setState = (next) => { boundaryInstance.state = { ...boundaryInstance.state, ...next } }
const boundaryRender = boundaryInstance.render()
if (boundaryRender?.type !== MarkdownTextStub) throw new Error('边界内应渲染宿主 MarkdownText')
// 宿主抛错后应回退到本地渲染
boundaryInstance.state = { failed: true }
if (boundaryInstance.render()?.type !== hostCaptured.exports.internals.LocalMarkdown) throw new Error('宿主渲染失败时应回退本地渲染')
tree.push('Markdown 宿主渲染：走 @deepseek-ai/dsh-client-ui-primitives.MarkdownText')

if (appended.length === 0) throw new Error('没有注入样式表')
if (typeof effectCleanup === 'function') effectCleanup()
console.log('client smoke ok')
console.log(tree.join('\n'))
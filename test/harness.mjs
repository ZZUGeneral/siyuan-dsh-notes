/**
 * 本地验证：用一个假的宿主上下文把 index.js 挂起来，然后
 *  1) 检查工具注册数量与开关语义；
 *  2) 对着真实思源内核（默认 127.0.0.1:6806）跑一遍只读工具；
 *  3) 在根目录建一篇临时文档，跑一遍写入 / 更新 / 属性 / 重命名 / 删除，
 *     最后把临时文档删掉（只碰自己建的东西）。
 *
 * 用法：node test/harness.mjs   （需要思源内核在线）
 */
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-siyuan-notes-test-' + process.pid)

const mod = await import('../index.js')
const { apply, internals } = mod

function fakeHost() {
  const tools = []
  const routes = []
  const effects = []
  const credentials = {
    store: new Map(),
    async resolve(ref) {
      return this.store.has(ref) ? { value: this.store.get(ref), source: 'store' } : undefined
    },
    async describe(ref) {
      return { configured: this.store.has(ref), source: 'store', writable: true }
    },
    async set(ref, value) {
      this.store.set(ref, value)
    },
    async unset(ref) {
      this.store.delete(ref)
    },
  }
  const services = {
    tools: {
      host: '127.0.0.1',
      register(definition) {
        if (tools.some((item) => item.definition.name === definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        const entry = { definition }
        tools.push(entry)
        return () => {
          const index = tools.indexOf(entry)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    webServer: {
      host: '127.0.0.1',
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    credentials,
  }
  const base = {
    logger: { warn: (...args) => console.log('[warn]', ...args), info() {}, error() {} },
    get: (name) => services[name],
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
  }
  const ctx = {
    ...base,
    tools: services.tools,
    webServer: services.webServer,
    inject: (deps, callback) => callback({ ...base, tools: services.tools, webServer: services.webServer }),
  }
  return { ctx, tools, routes, effects, services }
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function callTool(tools, name, args) {
  const entry = tools.find((item) => item.definition.name === name)
  if (entry === undefined) throw new Error(`tool ${name} is not registered`)
  const value = await entry.definition.execute(args, { signal: undefined })
  return value.result
}

async function callRoute(routes, method, body) {
  const route = routes[0]
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), {
    method: 'POST',
    url: `/siyuan-notes/api/${method}`,
    headers: { host: '127.0.0.1:58741' },
  })
  const chunks = []
  const res = {
    status: 0,
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      chunks.push(payload)
    },
  }
  await route.handler(req, res)
  return { status: res.status, body: JSON.parse(chunks.join('') || '{}') }
}

const host = fakeHost()
// 旧插件 @yoursc/dsh-siyuan 遗留的公共 ref：插件挂载时应删掉，且不复制其值。
host.services.credentials.store.set('SIYUAN_TOKEN', 'legacy-ref-value-should-be-dropped')
apply(host.ctx)
await new Promise((resolve) => setTimeout(resolve, 50))

console.log('\n== 注册面 ==')
check('route 已注册', host.routes.length === 1 && host.routes[0].path === '/siyuan-notes/api')
check('credential effect 已登记', host.effects.some((item) => item.label === 'siyuan-notes: tools'))
// 默认：read 7 + daily 1 开，write 7 + danger 2 关 → 8 个
check('默认注册 8 个工具', host.tools.length === 8, `实际 ${host.tools.length}：${host.tools.map((t) => t.definition.name).join(',')}`)

console.log('\n== 设置路由 ==')
const state = await callRoute(host.routes, 'getState')
check('getState 成功', state.body.ok === true, JSON.stringify(state.body).slice(0, 200))
check('getState 有 8 个启用工具', state.body.ok && state.body.value.tools.filter((t) => t.enabled).length === 8)
check('getState 报告可达', state.body.ok && state.body.value.reachable === true, state.body.ok ? state.body.value.connectionError : '')
// 没配 token 时必须"看不到任何笔记本"：不给匿名请求留口子。
check('未配置 token 时不列笔记本', state.body.ok && state.body.value.notebooks.length === 0)
check('未配置 token 时 ready=false', state.body.ok && state.body.value.ready === false)
check('getState 说明未配置 token', state.body.ok && String(state.body.value.connectionError).includes('API Token'))
check('getState 不回显 token', state.body.ok && state.body.value.token.value === undefined)
check('凭据引用名是插件专属的', internals.TOKEN_REF === 'SIYUAN_NOTES_TOKEN', internals.TOKEN_REF)
check('旧插件的 SIYUAN_TOKEN 已被清除', host.services.credentials.store.has('SIYUAN_TOKEN') === false)
check('旧 ref 的值没有被偷偷复制过来', host.services.credentials.store.has(internals.TOKEN_REF) === false)
// 插件不内置任何默认 token：环境变量与凭据库都空时必须是"未配置"，
// 否则"没填也能连上"会让人以为插件偷偷带了默认值。
if ((process.env.SIYUAN_NOTES_TOKEN ?? process.env.SIYUAN_TOKEN ?? '') === '') {
  check('未配置时不内置默认 token', state.body.ok && state.body.value.token.configured === false, JSON.stringify(state.body.value.token))
}
// 鉴权失败要指路到设置页。这里只查文案构造，不真发错 token：
// 思源对"认证失败"有次数限制，试探会把自己锁住（"认证失败次数过多，请稍后重试"）。
check('鉴权失败时提示去设置页', internals.authHint('some-token').includes('设置 → 思源笔记'), internals.authHint('some-token'))
check('空 token 的提示与填错的区别开', internals.authHint('') !== internals.authHint('some-token'))

// 关键回归：没有 token 时工具必须自己拒绝，而不是"思源放行匿名请求"就悄悄跑通。
const anonymousError = await internals
  .createApi({ get: () => undefined })
  .call(undefined, '/api/notebook/lsNotebooks', {})
  .then(() => undefined)
  .catch((error) => error)
check(
  '无 token 时工具拒绝访问',
  anonymousError !== undefined && String(anonymousError.message).includes('API Token'),
  String(anonymousError?.message),
)

// 之后的测试要真的读写思源，先把 token 注入假凭据库（优先环境变量，其次思源本地 conf.json）。
const testToken = (() => {
  const fromEnv = process.env.SIYUAN_NOTES_TOKEN ?? process.env.SIYUAN_TOKEN ?? ''
  if (fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'SiYuan', 'conf', 'conf.json'), 'utf8'))
    const token = conf?.api?.token
    return typeof token === 'string' ? token.trim() : ''
  } catch {
    return ''
  }
})()
if (testToken === '') {
  console.log('  .. 找不到 token（环境变量与 ~/SiYuan/conf/conf.json 都没有）：跳过需要鉴权的测试')
} else {
  await host.services.credentials.set(internals.TOKEN_REF, testToken)
  const ready = await callRoute(host.routes, 'getState')
  check('注入 token 后 ready=true', ready.body.ok && ready.body.value.ready === true, JSON.stringify(ready.body).slice(0, 160))
  check('注入 token 后能列笔记本', ready.body.ok && ready.body.value.notebooks.length > 0)
}

const probe = await callRoute(host.routes, 'testConnection', {})
check('testConnection ok', probe.body.ok && probe.body.value.ok === true, JSON.stringify(probe.body).slice(0, 200))

// 这里顺手走旧版组名键（write / danger）：三级判定的第二级也一起验到。
const updated = await callRoute(host.routes, 'updateConfig', { tools: { write: true, danger: true } })
check('updateConfig 后 write/danger 组已开', updated.body.ok && updated.body.value.tools.every((t) => t.enabled))
check('updateConfig 后工具数变 17', host.tools.length === 17, `实际 ${host.tools.length}`)

const badNotebook = await callRoute(host.routes, 'updateConfig', { defaultNotebook: 'no-such-notebook' })
check('非法默认笔记本被拒', badNotebook.body.ok === false, JSON.stringify(badNotebook.body))

const tree = await callRoute(host.routes, 'listDocs', { notebook: '20260302191216-4nh39ur', path: '/' })
check('listDocs 返回数组', tree.body.ok && Array.isArray(tree.body.value.docs), JSON.stringify(tree.body).slice(0, 200))

const found = await callRoute(host.routes, 'search', { query: '思源', limit: 3 })
check('search 有命中', found.body.ok && found.body.value.items.length > 0, JSON.stringify(found.body).slice(0, 200))

const forbidden = await (async () => {
  const req = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', url: '/siyuan-notes/api/getState', headers: { host: 'evil.example.com' } })
  const chunks = []
  const res = { writeHead(s) { this.status = s }, end(p) { chunks.push(p) } }
  await host.routes[0].handler(req, res)
  return { status: res.status, body: JSON.parse(chunks.join('')) }
})()
check('陌生 Host 被 403', forbidden.status === 403, JSON.stringify(forbidden.body))

console.log('\n== 只读工具（真实内核）==')
const notebooks = await callTool(host.tools, 'siyuan_list_notebooks', {})
check('list_notebooks 有内容', notebooks.includes('id='), notebooks.slice(0, 120))

const docs = await callTool(host.tools, 'siyuan_list_docs', { notebook: '20260302191216-4nh39ur', path: '/' })
check('list_docs 有内容', docs.length > 0, docs.slice(0, 200))

const hits = await callTool(host.tools, 'siyuan_search', { query: '思源', limit: 3 })
check('search 工具返回命中', hits.includes('文档id='), hits.slice(0, 200))

const rows = await callTool(host.tools, 'siyuan_sql', { stmt: "SELECT id, type, content FROM blocks WHERE type = 'd' LIMIT 3" })
check('sql 工具返回行', rows.includes('3 行') || rows.includes('行'), rows.slice(0, 200))

let sqlRejected = false
try {
  await callTool(host.tools, 'siyuan_sql', { stmt: 'SELECT 1; SELECT 2' })
} catch (error) {
  sqlRejected = String(error.message).includes('只能执行一条 SQL')
}
check('sql 拒绝多语句', sqlRejected)

// 找到第一篇文档用于 read_doc / get_child_blocks
const docId = /id=([0-9]{14}-[a-z0-9]+)/.exec(docs)?.[1] ?? ''
check('拿到一个文档 id', docId !== '', docs.slice(0, 120))
if (docId !== '') {
  const body = await callTool(host.tools, 'siyuan_read_doc', { id: docId })
  check('read_doc 返回正文', body.startsWith('# ') && body.includes('文档 id=' + docId), body.slice(0, 160))
  const children = await callTool(host.tools, 'siyuan_get_child_blocks', { id: docId })
  check('get_child_blocks 有输出', children.length > 0, children.slice(0, 160))
  const attrs = await callTool(host.tools, 'siyuan_get_block_attrs', { id: docId })
  check('get_block_attrs 有输出', attrs.includes('='), attrs.slice(0, 160))
  const daily = await callTool(host.tools, 'siyuan_daily_note', { action: 'read', notebook: '20260302191216-4nh39ur' })
  check('daily_note read 可调用', daily.length > 0, daily.slice(0, 160))
}

console.log('\n== 写入闭环（临时文档，最后删除）==')
const stamp = Date.now()
const docPath = `/dsh-siyuan-notes-e2e-${stamp}`
const created = await callTool(host.tools, 'siyuan_create_doc', {
  notebook: '20260302191216-4nh39ur',
  path: docPath,
  markdown: `# e2e ${stamp}\n\n第一段。`,
})
check('create_doc 返回 id', /文档 id=[0-9]{14}-[a-z0-9]+/.test(created), created)
const newDocId = /文档 id=([0-9]{14}-[a-z0-9]+)/.exec(created)?.[1] ?? ''

if (newDocId !== '') {
  const appended = await callTool(host.tools, 'siyuan_append_block', { docId: newDocId, markdown: '\n第二段（追加）。\n' })
  check('append_block 成功', appended.includes('已追加'), appended)

  const after = await callTool(host.tools, 'siyuan_read_doc', { id: newDocId })
  check('追加内容可读回', after.includes('第二段（追加）'), after.slice(-200))

  const children = await callTool(host.tools, 'siyuan_get_child_blocks', { id: newDocId })
  // 注意：刚追加的块在 SQL 索引里 content/markdown 可能还是空的（预览为空），
  // 所以这里只验结构，内容由上面 read_doc 的断言负责。
  check('子块结构里有追加的段落', children.trim().split('\n').length >= 3 && children.includes('第一段'), children.slice(-200))
  const paragraphId = /id=([0-9]{14}-[a-z0-9]+)/.exec(children)?.[1] ?? ''

  if (paragraphId !== '') {
    const updated = await callTool(host.tools, 'siyuan_update_block', { blockId: paragraphId, markdown: '第二段（已改写）。' })
    check('update_block 成功', updated.includes('已更新'), updated)
    const attrs = await callTool(host.tools, 'siyuan_get_block_attrs', { id: paragraphId })
    check('能读到块属性', attrs.includes('id ='), attrs)
    const setAttrs = await callTool(host.tools, 'siyuan_set_block_attrs', { id: paragraphId, attrs: { 'custom-e2e': 'yes' } })
    check('set_block_attrs 成功', setAttrs.includes('已设置'), setAttrs)
    const attrs2 = await callTool(host.tools, 'siyuan_get_block_attrs', { id: paragraphId })
    check('自定义属性读回', attrs2.includes('custom-e2e = yes'), attrs2)
  }

  const renamed = await callTool(host.tools, 'siyuan_rename_doc', { docId: newDocId, title: `e2e-renamed-${stamp}` })
  check('rename_doc 成功', renamed.includes('重命名为'), renamed)

  const blocked = await (async () => {
    try {
      await callTool(host.tools, 'siyuan_delete_block', { blockId: newDocId, confirm: true })
      return ''
    } catch (error) {
      return String(error.message)
    }
  })()
  check('delete_block 拒绝文档块并指路', blocked.includes('siyuan_remove_doc'), blocked)

  const needConfirm = await (async () => {
    try {
      await callTool(host.tools, 'siyuan_remove_doc', { docId: newDocId })
      return ''
    } catch (error) {
      return String(error.message)
    }
  })()
  check('remove_doc 要求 confirm', needConfirm.includes('confirm=true'), needConfirm)

  const removed = await callTool(host.tools, 'siyuan_remove_doc', { docId: newDocId, confirm: true })
  check('remove_doc 成功', removed.includes('已删除文档'), removed)
  // 用属性判据复核：SQL 是异步索引，删掉的文档可能还残留一会儿（甚至永远没进过索引）。
  const gone = await callTool(host.tools, 'siyuan_get_block_attrs', { id: newDocId })
  check('临时文档确实已删除', gone.includes('没有属性'), gone)
}

console.log('\n== 清理 ==')
for (const effect of host.effects) {
  if (typeof effect.dispose === 'function') effect.dispose()
}
check('卸载后工具清空', host.tools.length === 0, `剩余 ${host.tools.length}`)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
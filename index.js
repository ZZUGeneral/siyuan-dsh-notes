/**
 * dsh-siyuan-notes —— 思源笔记（SiYuan）插件，宿主侧。
 *
 * 三件事：
 *  1. 17 个 `siyuan_*` 工具（检索 / 读取 / 写入 / 整理 / 删除），逐工具开关；
 *  2. 设置页的自建 HTTP 路由（`/siyuan-notes/api/*`），配置存自有 JSON、token 存宿主凭据库；
 *  3. 主面板与聊天侧边抽屉要用的只读数据接口（笔记本 / 文档树 / 检索 / 文档正文）。
 *
 * 思源内核的所有调用都走 POST JSON，判定成功只看响应体 `code === 0`。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

export const name = 'siyuan-notes'

/** 设置页/面板使用的前缀；客户端 fetch(`/siyuan-notes/api/<method>`) 用 POST 打到这里。 */
const API_PREFIX = '/siyuan-notes/api'
/**
 * 凭据库里 token 的引用名。用插件专属的名字而不是 `SIYUAN_TOKEN`：
 * 后者是别的思源插件也在用的公共 ref，会让人以为"没填 token 却能连上"——其实是继承了别人的值。
 */
const TOKEN_REF = 'SIYUAN_NOTES_TOKEN'
/** 环境变量兜底（按顺序取第一个非空的）。老名字保留，方便已经在用 `SIYUAN_TOKEN` 的部署。 */
const TOKEN_ENV_KEYS = ['SIYUAN_NOTES_TOKEN', 'SIYUAN_TOKEN']

/** 进程环境里显式给出的 token；没有就是空串（本插件不内置任何默认 token）。 */
function ambientToken() {
  for (const key of TOKEN_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}
const DEFAULT_BASE_URL = 'http://127.0.0.1:6806'
const REQUEST_TIMEOUT_MS = 20000
const PROBE_TIMEOUT_MS = 4000
const CONNECT_TEST_TIMEOUT_MS = 8000
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 读文档默认返给模型的字符上限；超出部分截断并明确标注。 */
const READ_DOC_MAX_CHARS = 40000

const TOOL_GROUPS = ['read', 'write', 'daily', 'danger']
/** 新装的默认：只读与日记开箱可用，写入与删除要用户自己打开。 */
const TOOL_GROUP_DEFAULTS = { read: true, write: false, daily: true, danger: false }

const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE_URL,
  defaultNotebook: '',
  /** 逐工具开关：{ "siyuan_search": false }；也认旧版的组名键（read/write/...）。 */
  tools: {},
}

// ── 配置持久化 ──────────────────────────────────────────────────────────────

function dshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? env : path.join(os.homedir(), '.dsh')
}

function configPath() {
  return path.join(dshHome(), 'storages', 'siyuan-notes', 'config.json')
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const rawTools = source.tools !== null && typeof source.tools === 'object' && !Array.isArray(source.tools) ? source.tools : {}
  const tools = {}
  for (const [key, value] of Object.entries(rawTools)) {
    if (typeof value === 'boolean') tools[key] = value
  }
  const candidate = typeof source.baseUrl === 'string' ? source.baseUrl.trim().replace(/\/+$/, '') : ''
  let baseUrl = DEFAULT_BASE_URL
  if (candidate !== '') {
    if (isHttpUrl(candidate)) baseUrl = candidate
    else reportConfigCorrupt(configPath(), `baseUrl 不是合法的 http(s) 地址：「${candidate}」，已回退默认值`)
  }
  return {
    baseUrl,
    defaultNotebook: typeof source.defaultNotebook === 'string' ? source.defaultNotebook.trim() : '',
    tools,
  }
}

/**
 * 某个工具当前是否启用，三级判定：逐工具开关 → 旧版组开关 → 组默认。
 * 分组默认值只有 buildTools 知道，所以缺项不在这里补。
 */
function isToolEnabled(config, toolName, group) {
  const explicit = config.tools[toolName]
  if (typeof explicit === 'boolean') return explicit
  const legacyGroup = config.tools[group]
  if (typeof legacyGroup === 'boolean') return legacyGroup
  return TOOL_GROUP_DEFAULTS[group] === true
}

/** 校验设置页填的地址：保存与"用草稿探测"共用同一套判据，避免自相矛盾的结果。 */
function normalizeBaseUrlInput(raw) {
  const candidate = String(raw).trim().replace(/\/+$/, '')
  if (!isHttpUrl(candidate)) throw new Error(`baseUrl 不是合法的 http(s) 地址：「${String(raw).trim()}」。示例：http://127.0.0.1:6806`)
  return candidate
}

// 坏配置只提醒一次：每次工具调用都刷日志没有意义。
let onConfigCorrupt = null
let warnedCorruptFile = ''

function reportConfigCorrupt(file, reason) {
  if (warnedCorruptFile === file) return
  warnedCorruptFile = file
  if (onConfigCorrupt === null) return
  try {
    onConfigCorrupt(file, reason)
  } catch {
    // 告警本身不得影响功能
  }
}

/**
 * 读配置：文件不存在是首次运行的正常状态，回默认值；存在但读不出来必须留告警
 * （否则用户只会看到"开关全变回去了"）。
 */
function readConfig() {
  const file = configPath()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeConfig(undefined)
    reportConfigCorrupt(file, `读取失败：${error?.message ?? String(error)}`)
    return normalizeConfig(undefined)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    reportConfigCorrupt(file, `不是合法 JSON：${error?.message ?? String(error)}`)
    return normalizeConfig(undefined)
  }
  warnedCorruptFile = ''
  return normalizeConfig(parsed)
}

/** 原子写入：临时文件 → fsync → rename。写一半被打断会留下半个 JSON，等于丢全部设置。 */
function writeConfig(config) {
  const target = configPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}`
  try {
    const handle = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(handle, JSON.stringify(config, null, 2) + '\n', 'utf8')
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, target)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // 临时文件没建起来或已被清掉都无所谓
    }
    throw error
  }
}

// ── 凭据 ────────────────────────────────────────────────────────────────────

/**
 * 工具调用路径只取 token 值。只有凭据服务本身缺席时才读进程环境变量：
 * 服务在、库里没值，说明真实部署里该由凭据库的 env 来源负责，这里不再兜。
 */
async function tokenValue(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    return ambientToken()
  }
  try {
    const hit = await credentials.resolve(TOKEN_REF)
    return hit !== undefined && typeof hit.value === 'string' ? hit.value : ''
  } catch {
    return ''
  }
}

/** 旧插件用的公共 ref；不再使用，启动时顺手清掉（幂等）。 */
const LEGACY_TOKEN_REF = 'SIYUAN_TOKEN'

async function dropLegacyToken(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.unset !== 'function') return
  try {
    const info = await credentials.describe(LEGACY_TOKEN_REF)
    if (info === undefined || info.configured !== true) return
    await credentials.unset(LEGACY_TOKEN_REF)
    try {
      ctx.logger?.info?.(`[siyuan-notes] 已删除旧插件遗留的凭据 ${LEGACY_TOKEN_REF}`)
    } catch {
      // 日志失败不影响清理
    }
  } catch {
    // 清理失败不该挡住挂载
  }
}

/** 设置页路径：额外要来源与可写性，但**永不回显值本身给前端**（只在宿主内用来请求）。 */
async function tokenState(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    const ambient = ambientToken()
    const present = ambient !== ''
    return { value: ambient, configured: present, source: present ? 'env' : '', writable: false }
  }
  let source = ''
  let writable = true
  let configured = false
  try {
    const info = await credentials.describe(TOKEN_REF)
    configured = info !== undefined && info.configured === true
    source = info !== undefined && typeof info.source === 'string' ? info.source : ''
    writable = info === undefined || info.writable !== false
  } catch {
    // describe 失败时退化为直接 resolve
  }
  let value = ''
  try {
    const hit = await credentials.resolve(TOKEN_REF)
    if (hit !== undefined && typeof hit.value === 'string') {
      value = hit.value
      configured = value !== ''
      if (source === '' && typeof hit.source === 'string') source = hit.source
    }
  } catch {
    // 未配置即视为空
  }
  return { value, configured, source, writable }
}

// ── 思源 HTTP 客户端 ────────────────────────────────────────────────────────

/**
 * 思源侧错误。`kind` 让设置页区分三类失败，而不是把原因拼进一句文案：
 *  - `transport`：fetch 失败（连不上 / 超时 / 地址不存在）；
 *  - `envelope`：响应不是可解析的思源 JSON（多半指向了别的服务）；
 *  - `siyuan`：思源回了信封但 code !== 0（带 `code` / `msg`）。
 */
class SiYuanError extends Error {
  constructor(message, kind) {
    super(message)
    this.kind = kind
  }
}

/** 思源拒绝鉴权时的 msg 实测长这样：`Auth failed [session]`、`Invalid auth token`。 */
const AUTH_FAILURE_PATTERN = /auth|token|unauthorized|forbidden|鉴权|未授权|无权限/i

/** 鉴权失败时追加的处理提示；与 siyuanFetch 的报错共用，便于单测。 */
function authHint(token) {
  return token === ''
    ? '（当前没有配置 Token；若思源开启了鉴权，请在 设置 → 思源笔记 里填写）'
    : '（Token 被思源拒绝；请在 设置 → 思源笔记 里更新或清除）'
}

function isAuthFailure(error) {
  if (error?.kind !== 'siyuan') return false
  return AUTH_FAILURE_PATTERN.test(String(error.msg ?? error.message ?? ''))
}

/** dsh-tools 认 `name === 'AbortError'` 并据此把结果包装成 ABORTED；抛普通 Error 会被当成接口失败。 */
function abortError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

function assertNotAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

/** 把调用方的取消信号接到请求上：既不丢掉超时，也让已发出的请求可被取消。 */
function requestSignal(timeoutMs, callerSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (callerSignal === undefined || typeof AbortSignal.any !== 'function') return timeout
  return AbortSignal.any([timeout, callerSignal])
}

/**
 * 自适应解码响应体。宿主或中间层可能解压了（响应头仍写 gzip），也可能留下压缩体
 * 却丢掉 `content-encoding`（DSH 0.1.7 + undici 的全局代理 dispatcher 实测如此），
 * 所以**魔数优先**，头只用于没有魔数的 br。
 */
function decodeResponseBody(buf, contentEncoding) {
  const tryDecompress = (fn) => {
    try {
      return fn(buf)
    } catch {
      return buf
    }
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return tryDecompress(gunzipSync)
  if (buf.length >= 2 && buf[0] === 0x78 && [0x01, 0x9c, 0xda].includes(buf[1])) return tryDecompress(inflateSync)
  const enc = typeof contentEncoding === 'string' ? contentEncoding.trim().toLowerCase() : ''
  if (enc === 'br') return tryDecompress(brotliDecompressSync)
  return buf
}

/** 发一次思源请求并解出 JSON：**不判断 code**（探测要自己分辨"连不上"与"被拒绝"）。 */
async function sendSiyuanRequest(config, token, apiPath, payload, timeoutMs, callerSignal = undefined) {
  const url = config.baseUrl.replace(/\/+$/, '') + apiPath
  const headers = { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }
  if (token !== '') headers.Authorization = 'Token ' + token
  assertNotAborted(callerSignal)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: requestSignal(timeoutMs, callerSignal),
    })
  } catch (error) {
    if (callerSignal?.aborted === true) throw abortError()
    throw new SiYuanError(`连接思源失败（${url}）：${error?.message ?? String(error)}`, 'transport')
  }
  const rawBuf = Buffer.from(await response.arrayBuffer())
  const contentEncoding = response.headers.get('content-encoding')
  const text = decodeResponseBody(rawBuf, contentEncoding).toString('utf8')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    const enc = contentEncoding ?? 'null'
    const headHex = [...rawBuf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    throw new SiYuanError(
      `思源 ${apiPath} 响应无法解析为 JSON（HTTP ${response.status}，content-encoding=${enc}，前 8 字节=${headHex}）：${text.slice(0, 200)}`,
      'envelope',
    )
  }
  return { url, apiPath, status: response.status, body, text }
}

/** 调用思源接口：思源一律回 HTTP 200，成功判定只看 `body.code === 0`，返回 `body.data`。 */
async function siyuanFetch(config, token, apiPath, payload, timeoutMs = REQUEST_TIMEOUT_MS, callerSignal = undefined) {
  const { body, text } = await sendSiyuanRequest(config, token, apiPath, payload, timeoutMs, callerSignal)
  if (body === null || typeof body !== 'object' || body.code !== 0) {
    const code = body !== null && typeof body === 'object' ? body.code : '?'
    const msg = body !== null && typeof body === 'object' && typeof body.msg === 'string' ? body.msg : text.slice(0, 200)
    const error = new SiYuanError(`思源接口 ${apiPath} 失败：code=${String(code)} msg=${msg}`, 'siyuan')
    error.code = code
    error.msg = msg
    // 鉴权失败时补一句"去哪儿处理"：空 token 与"token 填错了"是两种不同的修法。
    if (AUTH_FAILURE_PATTERN.test(msg)) error.message += authHint(token)
    throw error
  }
  return body.data
}

/**
 * 地址探测：不带 Authorization 打公开接口 `/api/system/version`，出三态。
 * 没配 token 时鉴权接口会失败，但那**不代表地址错**——地址明明是通的。
 *  - `ok`   拿到 `code: 0` 的信封，顺带拿到版本号；
 *  - `auth` 拿到思源信封但 code !== 0：地址是活的思源，只是拒绝未鉴权请求；
 *  - `fail` 连不上 / 不是 JSON / 根本不是思源信封。
 */
async function probeAddress(config, timeoutMs = CONNECT_TEST_TIMEOUT_MS) {
  let response
  try {
    response = await sendSiyuanRequest(config, '', '/api/system/version', {}, timeoutMs)
  } catch (error) {
    if (error?.kind === 'envelope') {
      return {
        verdict: 'fail',
        version: '',
        detail: `地址有响应，但返回的不是思源的 JSON（多半指向了别的服务）：${String(error.message).slice(0, 160)}`,
      }
    }
    return { verdict: 'fail', version: '', detail: error?.message ?? String(error) }
  }
  const body = response.body
  if (body === null || typeof body !== 'object' || typeof body.code !== 'number') {
    return {
      verdict: 'fail',
      version: '',
      detail: `地址有响应（HTTP ${response.status}），但不是思源的 JSON 信封：${response.text.slice(0, 160)}`,
    }
  }
  if (body.code !== 0) {
    return { verdict: 'auth', version: '', detail: `思源回了错误信封：code=${String(body.code)} msg=${String(body.msg ?? '')}` }
  }
  return { verdict: 'ok', version: String(body.data ?? ''), detail: `思源版本 ${String(body.data ?? '')}` }
}

/** 工具调用的请求入口：每次现读配置与 token，保证设置页改完立刻生效。 */
/**
 * 一次工具调用用的请求函数。**没有 token 就拒绝**：思源对本地直连不带 Authorization 头的请求是放行的，
 * 所以"能连上"不是插件给了默认值，而是内核允许匿名。要保证"没配 token 就不能读写"，必须在这里拦。
 */
function createApi(ctx, signal = undefined) {
  return async (apiPath, payload) => {
    const config = readConfig()
    const token = await tokenValue(ctx)
    if (token === '') throw missingTokenError()
    return siyuanFetch(config, token, apiPath, payload, REQUEST_TIMEOUT_MS, signal)
  }
}

/** 未配置 token 时统一的错误文案：指路到设置页，并提示 token 在思源哪儿。 */
function missingTokenError() {
  return new SiYuanError(
    '还没有配置 API Token，工具不会以匿名身份访问思源。请到 设置 → 思源笔记 填写（思源里的位置：设置 → 关于 → API token）。',
    'config',
  )
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function stringProp(description) {
  return { type: 'string', description }
}

function stripMarks(value) {
  return typeof value === 'string' ? value.replace(/<\/?mark>/g, '') : ''
}

function truncateText(text, limit) {
  if (text.length <= limit) return { text, truncated: false, omitted: 0 }
  return { text: text.slice(0, limit), truncated: true, omitted: text.length - limit }
}

/** 只接受单条 SELECT*/
function normalizeSqlStatement(value) {
  const text = String(value).trim()
  if (text === '') throw new Error('stmt 不能为空')
  let body = text
  if (body.endsWith(';')) body = body.slice(0, -1).trimEnd()
  if (body.includes(';')) throw new Error('一次只能执行一条 SQL：语句中间不能有分号（包括字符串字面量里的分号，例如 LIKE \'%;%\'，请换写法）。')
  if (!/^select\b/i.test(body)) throw new Error('只允许只读 SELECT 语句。')
  return body
}

/**
 * 所有工具的统一形状：入参是 JSON 对象，出参是 `{ result: string }`（markdown 文本），
 * render 直接把文本交给对话。这样输出体量、截断提示都由工具自己控制。
 */
function defineTextTool(spec) {
  const properties = spec.parameters ?? {}
  const required = Array.isArray(spec.required) ? spec.required.filter((key) => Object.hasOwn(properties, key)) : []
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      assertNotAborted(signal)
      return { result: await spec.execute(args, signal) }
    },
  }
}

// ── 笔记本 / 块 / 文档的辅助判断 ────────────────────────────────────────────

function assertNotebook(config, explicit) {
  const notebook = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : config.defaultNotebook
  if (notebook === '') {
    throw new Error('未指定笔记本，且设置页里也没有配置默认笔记本。请传 notebook 参数，或先在 设置 → 思源笔记 里选择默认笔记本。')
  }
  return notebook
}

/** 写入前校验笔记本真实存在且未关闭，否则只会拿到思源原始 code=-1，用户看不出哪步错了。 */
async function assertNotebookUsable(api, config, explicit) {
  const notebook = assertNotebook(config, explicit)
  const data = await api('/api/notebook/lsNotebooks', {})
  const notebooks = Array.isArray(data?.notebooks) ? data.notebooks : []
  const hit = notebooks.find((item) => item?.id === notebook)
  if (hit === undefined) {
    throw new Error(`笔记本 ${notebook} 不存在。可用 siyuan_list_notebooks 查看真实笔记本 id，或改用设置页里的默认笔记本。`)
  }
  if (hit.closed === true) {
    throw new Error(`笔记本 ${notebook}（${hit.name ?? ''}）处于关闭状态，请先在思源里打开它，再重试。`)
  }
  return notebook
}

/** 查一个块的类型；不存在返回空串。文档块的 type 是 'd'。 */
async function blockTypeOf(api, id) {
  const escaped = String(id).replace(/'/g, "''")
  const rows = await api('/api/query/sql', { stmt: `SELECT type FROM blocks WHERE id = '${escaped}'` })
  return Array.isArray(rows) && rows.length > 0 && typeof rows[0].type === 'string' ? rows[0].type : ''
}

/** 读块属性；块不存在时思源回 code 0 + 空对象，不会报错。 */
async function blockAttrsOf(api, id) {
  const data = await api('/api/attr/getBlockAttrs', { id })
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/**
 * 判断块存在性与种类：'doc' | 'block' | ''（不存在）。
 *
 * 判存在性用 /api/attr/getBlockAttrs 而不是 SQL：属性读的是块树，刚写完立刻可见；
 * SQL 是异步索引，刚 createDocWithMd 出来的文档可能几秒内都查不到（API.md「SQL」一节），
 * 拿 SQL 当预检会把合法的追加/更新误判成「块不存在」。
 */
async function blockKind(api, id) {
  const attrs = await blockAttrsOf(api, id)
  if (typeof attrs.id !== 'string' || attrs.id === '') return ''
  if (attrs.type === 'doc') return 'doc'
  if (typeof attrs.type === 'string' && attrs.type !== '') return 'block'
  // 有些块（如标题）的属性里没有 type，这时只用 SQL 区分文档块；查不到就按普通块处理。
  return (await blockTypeOf(api, id)) === 'd' ? 'doc' : 'block'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sleepAbortable(ms, signal) {
  if (signal === undefined) return sleep(ms)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 删除后复核。实测（思源 3.8.10）：`/api/block/deleteBlock` 传文档 id 会回 code 0 但
 * **什么都不删**，删除本身也是异步落库的——只信返回码就会把失败报成成功。
 */
async function waitUntilBlockGone(api, id, options = {}) {
  const totalMs = options.totalMs ?? 6000
  const limit = options.limit ?? 15
  const started = Date.now()
  let delay = 150
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if ((await blockKind(api, id)) === '') return { gone: true, waitedMs: Date.now() - started, missed: attempt > 0 }
    if (Date.now() - started >= totalMs) break
    await sleepAbortable(Math.min(delay, 1200), options.signal)
    delay *= 1.6
  }
  return { gone: false, waitedMs: Date.now() - started, missed: false }
}

function deletionNotVerifiedMessage(kind, id, waitedMs) {
  return `思源接受了删除请求，但 ${waitedMs}ms 后 ${kind} ${id} 依然存在：删除没有生效（不是落库慢）。请用 siyuan_get_block_attrs 或 siyuan_get_child_blocks 复核，不要把「接受请求」当成「已经删掉」。`
}

// ── 日记路径 ────────────────────────────────────────────────────────────────

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 用常见的 Go 日期 layout 片段渲染一个 Date。单趟替换：顺序替换会让 '02' 命中刚生成的 '2026'。 */
function goLayout(date, layout) {
  const values = {
    2006: String(date.getFullYear()),
    '01': pad2(date.getMonth() + 1),
    '02': pad2(date.getDate()),
    15: pad2(date.getHours()),
    '04': pad2(date.getMinutes()),
    '05': pad2(date.getSeconds()),
    January: date.toLocaleString('en-US', { month: 'long' }),
    Jan: date.toLocaleString('en-US', { month: 'short' }),
    Monday: date.toLocaleString('en-US', { weekday: 'long' }),
    Mon: date.toLocaleString('en-US', { weekday: 'short' }),
  }
  // 长 token 必须排在会被它截短命中的短 token 前面（否则 'Monday' 里的 'Mon' 先命中，
  // 2026-09-12 会渲染成 "Satday"，日记会按损坏路径"成功"创建）。
  return layout.replace(/2006|January|01|02|15|04|05|Monday|Jan|Mon/g, (token) => values[token])
}

function renderDailyPath(template, date) {
  return template.replace(/\{\{\s*now\s*\|\s*date\s+"([^"]*)"\s*\}\}/g, (_match, layout) => goLayout(date, layout))
}

/** 只有「没传 / 传空」才回退 now；传了但解析不出来一律抛错（Date 会滚动越界日期，写错日记更糟）。 */
function parseDateArg(value, now = new Date()) {
  if (value === undefined || value === null) return startOfDay(now)
  if (typeof value !== 'string') throw new Error(`date 必须是 YYYY-MM-DD 字符串，收到 ${typeof value}`)
  const text = value.trim()
  if (text === '') return startOfDay(now)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) throw new Error(`date 格式不合法：「${text}」。请用 YYYY-MM-DD（例如 2026-09-12），或省略 date 用今天。`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`date 不是真实存在的日期：「${text}」。请核对年月日。`)
  }
  return date
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

const DEFAULT_DAILY_PATH = '/daily note/{{now | date "2006/01"}}/{{now | date "2006-01-02"}}'

async function lookupDailyDoc(api, notebook, date) {
  const data = await api('/api/notebook/getNotebookConf', { notebook })
  const conf = data !== null && typeof data === 'object' && data.conf !== null && typeof data.conf === 'object' ? data.conf : {}
  const template = typeof conf.dailyNoteSavePath === 'string' && conf.dailyNoteSavePath.trim() !== '' ? conf.dailyNoteSavePath : DEFAULT_DAILY_PATH
  const hpath = renderDailyPath(template, date)
  const ids = await api('/api/filetree/getIDsByHPath', { notebook, path: hpath })
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id !== '') : []
  return { hpath, id: list[0] ?? '', count: list.length }
}

// ── 工具集 ──────────────────────────────────────────────────────────────────

function buildTools(makeApi) {
  const notebookArg = { notebook: stringProp('笔记本 id（省略则用设置页配置的默认笔记本）') }

  return [
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_list_notebooks',
        description: '列出思源笔记的所有笔记本及其 id。写入或检索前用它确认真实笔记本 id。',
        parameters: {},
        execute: async (_args, signal) => {
          const api = makeApi(signal)
          const data = await api('/api/notebook/lsNotebooks', {})
          const notebooks = Array.isArray(data?.notebooks) ? data.notebooks : []
          if (notebooks.length === 0) return '（没有笔记本）'
          return notebooks
            .map((nb) => `${nb.closed === true ? '[已关闭] ' : ''}${nb.name ?? '(无名)'} | id=${nb.id ?? ''}`)
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_list_docs',
        description: '列出一个目录下的直接子文档（不递归）。path 是目录的人类可读路径，根目录传 "/"。每条给出文档 id 与名字，读正文用 siyuan_read_doc。',
        parameters: {
          path: stringProp('目录的人类可读路径，根目录传 "/"'),
          ...notebookArg,
        },
        required: ['path'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const config = readConfig()
          const notebook = assertNotebook(config, args.notebook)
          const docPath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : '/'
          const data = await api('/api/filetree/listDocsByPath', { notebook, path: docPath })
          const files = Array.isArray(data?.files) ? data.files : []
          if (files.length === 0) return `${data?.path ?? docPath} 下没有子文档。`
          return files
            .map((file) => `${file.name ?? '(无名)'} | id=${file.id ?? ''} | 子文档=${file.subFileCount ?? file.count ?? 0}`)
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_search',
        description: '全文检索思源笔记，返回命中的块。每条给出文档 id（rootID，用它去读文档）、块 id、人类路径与片段。检索是全局的，可用 notebook 只保留某个笔记本的命中。',
        parameters: {
          query: stringProp('检索关键词'),
          limit: { type: 'integer', description: '返回条数上限，默认 20，最大 100' },
          ...notebookArg,
        },
        required: ['query'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const query = String(args.query ?? '').trim()
          if (query === '') throw new Error('query 不能为空')
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
          const data = await api('/api/search/fullTextSearchBlock', { query, limit })
          let blocks = Array.isArray(data?.blocks) ? data.blocks : []
          if (typeof args.notebook === 'string' && args.notebook !== '') {
            blocks = blocks.filter((block) => block.box === args.notebook)
          }
          if (blocks.length === 0) return `没有命中「${query}」的块。`
          return blocks
            .slice(0, limit)
            .map((block, index) => {
              const head = `${index + 1}. ${block.hPath ?? ''} | 文档id=${block.rootID ?? ''} | 块id=${block.id ?? ''} | 类型=${block.type ?? ''}`
              const snippet = stripMarks(block.content).replace(/\s+/g, ' ').slice(0, 200)
              return `${head}\n   ${snippet}`
            })
            .join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_read_doc',
        description: '读取一篇文档的 Markdown 全文。超过 maxChars 会截断并标注已省略多少字符；要读局部内容请改用 siyuan_get_child_blocks 或 siyuan_sql。',
        parameters: {
          id: stringProp('文档 id（list_docs / search 结果里的 id 或 rootID）'),
          maxChars: { type: 'integer', description: `返回的字符上限，默认 ${READ_DOC_MAX_CHARS}` },
        },
        required: ['id'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const id = String(args.id ?? '').trim()
          if (id === '') throw new Error('id 不能为空')
          const limit = Number.isFinite(args.maxChars) ? Math.max(500, Math.trunc(args.maxChars)) : READ_DOC_MAX_CHARS
          const data = await api('/api/export/exportMdContent', { id })
          const hPath = typeof data?.hPath === 'string' ? data.hPath : ''
          const content = typeof data?.content === 'string' ? data.content : ''
          const cut = truncateText(content, limit)
          const head = `# ${hPath === '' ? id : hPath}（文档 id=${id}）`
          if (cut.truncated) {
            return `${head}\n\n${cut.text}\n\n…（已截断：共省略 ${cut.omitted} 个字符。要读余下部分请用 siyuan_sql 按块取，例如 SELECT id, markdown FROM blocks WHERE root_id = '${id}' ORDER BY sort LIMIT 20 OFFSET 20）`
          }
          return `${head}\n\n${content}`
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_get_child_blocks',
        description: '列出一个块（通常是文档 id）的直接子块，带每个子块的一句话内容预览。用它看清文档结构，再决定改哪一个块。',
        parameters: {
          id: stringProp('父块 id（文档 id 也算）'),
        },
        required: ['id'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const id = String(args.id ?? '').trim()
          if (id === '') throw new Error('id 不能为空')
          // getChildBlocks 本身就带 content / markdown：不用再绕 SQL（刚写的块 SQL 索引还没跟上，
          // 会得到一排空预览，看起来像块是空的）。
          const children = await api('/api/block/getChildBlocks', { id })
          const list = Array.isArray(children) ? children : []
          if (list.length === 0) return `${id} 没有子块（或全部折叠）。`
          const joined = list
            .map((child, index) => {
              const raw = typeof child.markdown === 'string' && child.markdown !== '' ? child.markdown : child.content ?? ''
              const preview = String(raw).replace(/\s+/g, ' ').slice(0, 120)
              return `${index + 1}. ${child.type ?? '?'} | id=${child.id} | ${preview}`
            })
            .join('\n')
          return list.length > 1 ? `${joined}\n（共 ${list.length} 个直接子块）` : joined
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_get_block_attrs',
        description: '读取块的属性（含自定义属性 custom-*）。',
        parameters: {
          id: stringProp('块 id'),
        },
        required: ['id'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const id = String(args.id ?? '').trim()
          if (id === '') throw new Error('id 不能为空')
          const attrs = await api('/api/attr/getBlockAttrs', { id })
          const entries = attrs !== null && typeof attrs === 'object' ? Object.entries(attrs) : []
          if (entries.length === 0) return `${id} 没有属性。`
          return entries.map(([key, value]) => `${key} = ${String(value)}`).join('\n')
        },
      }),
    },
    {
      group: 'read',
      definition: defineTextTool({
        name: 'siyuan_sql',
        description:
          '对思源块数据库执行只读 SQL（SELECT）。常用表 blocks(id, parent_id, root_id, type, content, markdown, hpath, created, updated)；取正文用 markdown 列，content 列对带格式的段落常为空，不要据此判断块为空。只接受单条 SELECT：结尾允许一个分号，语句中间的分号会被拒绝（包括字符串字面量里的分号，例如 LIKE \'%;%\'，请换写法）。',
        parameters: {
          stmt: stringProp('单条 SELECT 语句'),
        },
        required: ['stmt'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const stmt = normalizeSqlStatement(args.stmt)
          const rows = await api('/api/query/sql', { stmt })
          const list = Array.isArray(rows) ? rows : []
          if (list.length === 0) return '（查询没有返回行）'
          const columns = Object.keys(list[0] ?? {})
          const body = list.map((row) =>
            columns
              .map((column) => {
                const value = row[column]
                const text = value === null || value === undefined ? '' : String(value)
                return `${column}=${text.length > 300 ? text.slice(0, 300) + '…' : text}`
              })
              .join(' | '),
          )
          return `${list.length} 行\n${body.join('\n')}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_create_doc',
        description: '在笔记本里用 Markdown 新建一篇文档。默认同名文档已存在时报错（避免建出重复文档）；确实要再建一份传 allowDuplicate=true。返回新文档 id。',
        parameters: {
          path: stringProp('文档的人类可读路径，以 / 开头，如 /收件箱/会议记录'),
          markdown: stringProp('文档正文 Markdown'),
          allowDuplicate: { type: 'boolean', description: '同名文档已存在时仍然新建，默认 false' },
          ...notebookArg,
        },
        required: ['path', 'markdown'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const config = readConfig()
          const notebook = await assertNotebookUsable(api, config, args.notebook)
          const docPath = String(args.path ?? '').trim()
          if (docPath === '') throw new Error('path 不能为空，示例：/收件箱/会议记录')
          const existing = await api('/api/filetree/getIDsByHPath', { notebook, path: docPath })
          const ids = Array.isArray(existing) ? existing.filter((id) => typeof id === 'string' && id !== '') : []
          if (ids.length > 0 && args.allowDuplicate !== true) {
            throw new Error(`已存在同路径文档「${docPath}」（id=${ids[0]}）。要追加内容请用 siyuan_append_block；确实要再建一份传 allowDuplicate=true。`)
          }
          const id = await api('/api/filetree/createDocWithMd', { notebook, path: docPath, markdown: String(args.markdown ?? '') })
          return `已创建文档「${docPath}」\n文档 id=${String(id ?? '')}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_append_block',
        description: '把 Markdown 追加为某篇文档的末尾子块。日常往已有文档加内容优先用它（一次可以是一整段 Markdown）。',
        parameters: {
          docId: stringProp('文档 id'),
          markdown: stringProp('要追加的 Markdown'),
        },
        required: ['docId', 'markdown'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const docId = String(args.docId ?? '').trim()
          if (docId === '') throw new Error('docId 不能为空')
          const docKind = await blockKind(api, docId)
          if (docKind === '') throw new Error(`文档 ${docId} 不存在，请核对 id`)
          if (docKind !== 'doc') {
            throw new Error(`${docId} 是内容块而不是文档块，appendBlock 只追加到文档/容器末尾。要在这个块之后插入请用 siyuan_insert_block（previousId=${docId}）。`)
          }
          const data = await api('/api/block/appendBlock', { dataType: 'markdown', data: String(args.markdown ?? ''), parentID: docId })
          return `已追加到文档 ${docId}${data !== null && typeof data === 'object' && typeof data.id === 'string' ? `（新块 id=${data.id}）` : ''}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_insert_block',
        description: '在某个块之后插入 Markdown。标题是叶子块，不能当 parentId：往标题下插入要传 previousId=该标题 id。插到文档最开头请用 parentId=文档 id。',
        parameters: {
          previousId: stringProp('前一个块的 id；插到文档开头时改传 parentId'),
          parentId: stringProp('父块 id（与 previousId 二选一；插到文档开头用文档 id）'),
          markdown: stringProp('要插入的 Markdown'),
        },
        required: ['markdown'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const previousId = typeof args.previousId === 'string' ? args.previousId.trim() : ''
          const parentId = typeof args.parentId === 'string' ? args.parentId.trim() : ''
          if (previousId === '' && parentId === '') throw new Error('必须提供 previousId 或 parentId 之一')
          const payload = { dataType: 'markdown', data: String(args.markdown ?? '') }
          if (previousId !== '') payload.previousID = previousId
          else payload.parentID = parentId
          await api('/api/block/insertBlock', payload)
          return previousId !== '' ? `已在块 ${previousId} 之后插入` : `已插入为 ${parentId} 的子块`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_update_block',
        description: '用 Markdown 覆盖某个块的内容。注意：实测传多段 Markdown 时只保留第一段，其余会被静默丢弃；要写多段请用 siyuan_insert_block 逐段插入。',
        parameters: {
          blockId: stringProp('块 id'),
          markdown: stringProp('新的 Markdown 内容（单段）'),
        },
        required: ['blockId', 'markdown'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const blockId = String(args.blockId ?? '').trim()
          if (blockId === '') throw new Error('blockId 不能为空')
          if ((await blockKind(api, blockId)) === '') {
            throw new Error(`块 ${blockId} 不存在，请核对 id（可用 siyuan_get_child_blocks 查看结构）`)
          }
          await api('/api/block/updateBlock', { id: blockId, dataType: 'markdown', data: String(args.markdown ?? '') })
          // 空内容更新会让块消失；用属性判据复核，避免被 SQL 索引延迟骗到。
          if ((await blockKind(api, blockId)) === '') {
            throw new Error(`思源已接受更新，但块 ${blockId} 现在查不到了：内容可能被写没了，请用 siyuan_read_doc 复核。`)
          }
          const paragraphs = String(args.markdown ?? '').split(/\n{2,}/).filter((part) => part.trim() !== '')
          if (paragraphs.length > 1) {
            return `已更新块 ${blockId}，但只写入了第一段：思源 updateBlock 对多段 Markdown 只保留第一段，其余 ${paragraphs.length - 1} 段被静默丢弃。要写多段请用 siyuan_insert_block 逐段插入。`
          }
          return `已更新块 ${blockId}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_set_block_attrs',
        description: '设置块属性（含 custom-* 自定义属性）。attrs 是属性名到值的对象，例如 {"custom-status":"done"}。',
        parameters: {
          id: stringProp('块 id'),
          attrs: { type: 'object', additionalProperties: true, description: '属性对象' },
        },
        required: ['id', 'attrs'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const id = String(args.id ?? '').trim()
          if (id === '') throw new Error('id 不能为空')
          if (args.attrs === null || typeof args.attrs !== 'object' || Array.isArray(args.attrs)) throw new Error('attrs 必须是对象')
          // 思源对不存在 id 的 setBlockAttrs 会静默 no-op 且仍回 code 0，先拒绝才不会假成功。
          if ((await blockKind(api, id)) === '') throw new Error(`块 ${id} 不存在，请核对 id`)
          await api('/api/attr/setBlockAttrs', { id, attrs: args.attrs })
          return `已设置 ${id} 的 ${Object.keys(args.attrs).length} 个属性`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_move_doc',
        description: '移动整篇文档到另一个父文档或笔记本下：toId 传目标父文档 id，或传目标笔记本 id（移到该笔记本根）。移动的是整篇文档，移动单个块请用 siyuan_insert_block / siyuan_delete_block。',
        parameters: {
          docIds: { type: 'array', items: { type: 'string' }, description: '要移动的文档 id 列表（至少一个）' },
          toId: stringProp('目标父文档 id 或目标笔记本 id'),
        },
        required: ['docIds', 'toId'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const docIds = Array.isArray(args.docIds) ? args.docIds.filter((id) => typeof id === 'string' && id !== '') : []
          if (docIds.length === 0) throw new Error('docIds 至少要有一个文档 id')
          const toId = String(args.toId ?? '').trim()
          if (toId === '') throw new Error('必须提供 toId（目标父文档 id 或目标笔记本 id）')
          await api('/api/filetree/moveDocsByID', { fromIDs: docIds, toID: toId })
          return `已移动 ${docIds.length} 篇文档到 ${toId}：${docIds.join(', ')}`
        },
      }),
    },
    {
      group: 'write',
      definition: defineTextTool({
        name: 'siyuan_rename_doc',
        description: '重命名文档（改标题）。',
        parameters: {
          docId: stringProp('文档 id'),
          title: stringProp('新标题'),
        },
        required: ['docId', 'title'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const docId = String(args.docId ?? '').trim()
          if (docId === '') throw new Error('docId 不能为空')
          const title = String(args.title ?? '').trim()
          if (title === '') throw new Error('title 不能为空')
          await api('/api/filetree/renameDocByID', { id: docId, title })
          return `已把 ${docId} 重命名为「${title}」`
        },
      }),
    },
    {
      group: 'daily',
      definition: defineTextTool({
        name: 'siyuan_daily_note',
        description: '读写思源日记。action=read 读取指定日期（默认今天）的日记；action=append 把 Markdown 追加到该日记，日记不存在时按笔记本的 dailyNoteSavePath 模板自动创建。',
        parameters: {
          action: { type: 'string', enum: ['read', 'append'], description: 'read 或 append' },
          date: stringProp('日期 YYYY-MM-DD，默认今天'),
          markdown: stringProp('action=append 时要写入的 Markdown'),
          ...notebookArg,
        },
        required: ['action'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          const config = readConfig()
          const notebook = await assertNotebookUsable(api, config, args.notebook)
          const date = parseDateArg(args.date)
          const action = args.action === 'append' ? 'append' : 'read'
          if (action === 'append' && (typeof args.markdown !== 'string' || args.markdown.trim() === '')) {
            throw new Error('action=append 时必须提供 markdown')
          }
          const resolved = await lookupDailyDoc(api, notebook, date)
          const duplicateNote = resolved.count > 1 ? `\n注意：同一天有 ${resolved.count} 篇同名日记，写入的是第一篇（id=${resolved.id}）。` : ''
          if (action === 'append') {
            if (resolved.id === '') {
              const createdId = await api('/api/filetree/createDocWithMd', { notebook, path: resolved.hpath, markdown: String(args.markdown) })
              return `日记原不存在，已创建并写入：${resolved.hpath}\n文档 id=${String(createdId ?? '')}`
            }
            const data = await api('/api/block/appendBlock', { dataType: 'markdown', data: String(args.markdown), parentID: resolved.id })
            return `已追加到日记 ${resolved.hpath}\n文档 id=${resolved.id}${data !== null && typeof data === 'object' && typeof data.id === 'string' ? `（新块 id=${data.id}）` : ''}${duplicateNote}`
          }
          if (resolved.id === '') return `${formatDate(date)} 的日记还不存在（预期路径 ${resolved.hpath}）。`
          const data = await api('/api/export/exportMdContent', { id: resolved.id })
          const content = typeof data?.content === 'string' ? data.content : ''
          const cut = truncateText(content, READ_DOC_MAX_CHARS)
          return `# ${resolved.hpath}（文档 id=${resolved.id}）\n\n${cut.truncated ? `${cut.text}\n\n…（已截断：共省略 ${cut.omitted} 个字符）` : content}${duplicateNote}`
        },
      }),
    },
    {
      group: 'danger',
      definition: defineTextTool({
        name: 'siyuan_delete_block',
        description: '删除一个内容块。删除标题块会连同其下内容一起删除，且必须先删子块再删父块。这是破坏性操作：只有用户明确要求删除时才调用，并传 confirm=true。整篇文档请用 siyuan_remove_doc——文档块走这个接口只"报成功不删"。',
        parameters: {
          blockId: stringProp('要删除的块 id'),
          confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除' },
        },
        required: ['blockId', 'confirm'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          if (args.confirm !== true) throw new Error('删除是破坏性操作，需要在用户明确要求后传 confirm=true')
          const blockId = String(args.blockId ?? '').trim()
          if (blockId === '') throw new Error('blockId 不能为空')
          const kind = await blockKind(api, blockId)
          if (kind === '') throw new Error(`块 ${blockId} 不存在，请核对 id`)
          if (kind === 'doc') {
            throw new Error(`块 ${blockId} 是文档块：思源对文档走 /api/block/deleteBlock 会返回成功但不删除。删除整篇文档请用 siyuan_remove_doc。`)
          }
          await api('/api/block/deleteBlock', { id: blockId })
          const verified = await waitUntilBlockGone(api, blockId, { signal })
          if (!verified.gone) throw new Error(deletionNotVerifiedMessage('块', blockId, verified.waitedMs))
          return verified.missed ? `已删除块 ${blockId}（复核用了 ${verified.waitedMs}ms：思源删除是异步落库的）` : `已删除块 ${blockId}`
        },
      }),
    },
    {
      group: 'danger',
      definition: defineTextTool({
        name: 'siyuan_remove_doc',
        description: '删除整篇文档（走 /api/filetree/removeDocByID，之后可在思源回收站找回）。这是破坏性操作：只有用户明确要求删除整篇文档时才调用，并传 confirm=true。删除单个内容块请用 siyuan_delete_block。',
        parameters: {
          docId: stringProp('要删除的文档 id'),
          confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除' },
        },
        required: ['docId', 'confirm'],
        execute: async (args, signal) => {
          const api = makeApi(signal)
          if (args.confirm !== true) throw new Error('删除是破坏性操作，需要在用户明确要求后传 confirm=true')
          const docId = String(args.docId ?? '').trim()
          if (docId === '') throw new Error('docId 不能为空')
          const kind = await blockKind(api, docId)
          if (kind === '') throw new Error(`文档 ${docId} 不存在，请核对 id（检索结果里的 rootID 是文档 id）`)
          if (kind !== 'doc') throw new Error(`块 ${docId} 是内容块，不是整篇文档。删除单个内容块请用 siyuan_delete_block。`)
          await api('/api/filetree/removeDocByID', { id: docId })
          const verified = await waitUntilBlockGone(api, docId, { signal })
          if (!verified.gone) throw new Error(deletionNotVerifiedMessage('文档', docId, verified.waitedMs))
          return verified.missed ? `已删除文档 ${docId}（复核用了 ${verified.waitedMs}ms：思源删除是异步落库的）` : `已删除文档 ${docId}`
        },
      }),
    },
  ]
}

// ── 请求信任围栏 ────────────────────────────────────────────────────────────

function headerValue(headers, key) {
  const value = headers[key]
  return Array.isArray(value) ? value[0] : value
}

/** IPv4 / IPv6 字面量（可带方括号、可带 `%zone`）；其余一律按域名处理。 */
function isIpLiteral(hostname) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const address = bare.includes('%') ? bare.slice(0, bare.indexOf('%')) : bare
  return net.isIPv4(address) || net.isIPv6(address)
}

/** 127.0.0.0/8、::1 及其 IPv4 映射形式。 */
function isLoopbackAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped !== null) return isLoopbackAddress(mapped[1])
  if (net.isIPv4(address)) return address.startsWith('127.')
  try {
    return new URL('http://[' + address + ']').hostname === '[::1]'
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || isLoopbackAddress(hostname)
}

function isBindAddressAuthority(hostUrl, bindHost) {
  if (typeof bindHost !== 'string' || !isIpLiteral(bindHost)) return false
  const bare = bindHost.startsWith('[') && bindHost.endsWith(']') ? bindHost.slice(1, -1) : bindHost
  const address = bare.includes('%') ? bare.slice(0, bare.indexOf('%')) : bare
  return normalizeAddressText(hostUrl.hostname) === normalizeAddressText(address)
}

function normalizeAddressText(text) {
  if (!isIpLiteral(text)) return text
  const bracketed = text.startsWith('[') ? text : '[' + text + ']'
  try {
    return new URL('http://' + bracketed).hostname
  } catch {
    return text
  }
}

/**
 * 只接受本机、监听器自身绑定地址，或部署声明的受信 authority 发起的同源浏览器请求。
 *
 * 这条路由能改 token 与默认笔记本，等于是宿主的一个写入口；Host 是防 DNS rebinding
 * 的唯一判据，Origin 与 Sec-Fetch-Site 用来挡住跨站页面借用户浏览器打过来的请求。
 * 受信列表取自 `webStartup.trustedHosts`（即 `dsh web --trusted-host`）：读早先的
 * `webRuntime` 拿到的永远是 undefined，于是域名部署下这条路由恒 403。
 */
function isTrustedRequest(req, { trustedHosts, bindHost } = {}) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) {
    const trusted = Array.isArray(trustedHosts) ? trustedHosts : []
    const isTrustedAuthority = trusted.some((entry) => {
      if (typeof entry !== 'string' || entry === '') return false
      let entryUrl
      try {
        entryUrl = new URL('http://' + entry)
      } catch {
        return false
      }
      // 没写端口的条目表示"这个主机名，任意端口"；写了端口就必须同端口。
      return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
    })
    if (!isTrustedAuthority && !isBindAddressAuthority(hostUrl, bindHost)) return false
  }
  if (headerValue(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 当前部署的信任边界；两者都可能在请求时缺席，缺席就按"没有"处理（退回只认本机）。 */
function trustBoundary(ctx) {
  let startup
  try {
    startup = ctx.get('webStartup')
  } catch {
    // 某些宿主进程可能没有注册 webStartup，退回到空名单。
    startup = undefined
  }
  const server = ctx.get('webServer')
  return {
    trustedHosts: Array.isArray(startup?.trustedHosts) ? startup.trustedHosts : [],
    bindHost: typeof server?.host === 'string' ? server.host : undefined,
  }
}

/** 403 的排障线索：只回显浏览器自己发的 Host 头，并给出可执行的下一步。 */
function trustHint(req, trust) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return '请求没有 Host 头，已拒绝。'
  let hostname = host
  try {
    hostname = new URL('http://' + host).hostname
  } catch {
    return `Host ${JSON.stringify(host)} 无法解析，已拒绝。`
  }
  const authority = /:\d+$/.test(host) ? host : hostname
  return `宿主不信任 Host ${JSON.stringify(host)}：本机使用请改用 http://127.0.0.1 打开；用域名访问时需要在启动 dsh web 时加 --trusted-host ${authority}，然后重启。`
}

// ── JSON 收发 ───────────────────────────────────────────────────────────────

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// ── 设置页 / 面板的数据面 ───────────────────────────────────────────────────

async function listNotebooksOf(api) {
  const data = await api('/api/notebook/lsNotebooks', {})
  const notebooks = Array.isArray(data?.notebooks) ? data.notebooks : []
  return notebooks.map((nb) => ({ id: nb.id ?? '', name: nb.name ?? '', icon: nb.icon ?? '', closed: nb.closed === true }))
}

/**
 * `getState` 的返回体：配置 + token 状态（不回显值）+ 可达性与版本 + 工具清单 + 笔记本。
 * 设置页与主面板都用它做首屏，省一次往返。
 */
async function buildStatePayload(ctx, allTools) {
  const config = readConfig()
  const token = await tokenState(ctx)
  let version = ''
  let reachable = false
  let notebooks = []
  let connectionError = ''
  // 先用公开接口 /api/system/version 探活（不需要 token），这样"思源没开、或地址写错"与
  // "token 没配"能被分开报告；只有配了 token 才去列笔记本，绝不以匿名身份发业务请求。
  try {
    version = String((await siyuanFetch(config, '', '/api/system/version', {}, PROBE_TIMEOUT_MS)) ?? '')
    reachable = true
  } catch (error) {
    reachable = false
    connectionError = error?.message ?? String(error)
  }
  if (token.configured) {
    try {
      const data = await siyuanFetch(config, token.value, '/api/notebook/lsNotebooks', {}, PROBE_TIMEOUT_MS)
      const items = Array.isArray(data?.notebooks) ? data.notebooks : []
      notebooks = items.map((nb) => ({ id: nb.id ?? '', name: nb.name ?? '', icon: nb.icon ?? '', closed: nb.closed === true }))
    } catch (error) {
      notebooks = []
      connectionError = isAuthFailure(error) ? 'token 被思源拒绝：请在本页更新或清除' : error?.message ?? String(error)
    }
  } else if (reachable) {
    connectionError = '未配置 API Token：所有工具与面板都会被拒绝，请在上方填入。'
  }
  return {
    config,
    token: { configured: token.configured, source: token.source, writable: token.writable },
    tokenRequired: true,
    ready: token.configured && reachable && connectionError === '',
    reachable,
    version,
    connectionError,
    notebooks,
    toolGroups: TOOL_GROUPS,
    tools: allTools.map((entry) => ({
      name: entry.definition.name,
      group: entry.group,
      enabled: isToolEnabled(config, entry.definition.name, entry.group),
    })),
    toolCount: allTools.length,
  }
}

async function panelSearch(api, args) {
  const query = String(args.query ?? '').trim()
  if (query === '') throw new Error('query 不能为空')
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
  const data = await api('/api/search/fullTextSearchBlock', { query, limit })
  let blocks = Array.isArray(data?.blocks) ? data.blocks : []
  if (typeof args.notebook === 'string' && args.notebook !== '') blocks = blocks.filter((block) => block.box === args.notebook)
  return {
    query,
    items: blocks.slice(0, limit).map((block) => ({
      id: block.id ?? '',
      rootID: block.rootID ?? '',
      hPath: block.hPath ?? '',
      type: block.type ?? '',
      box: block.box ?? '',
      snippet: stripMarks(block.content).replace(/\s+/g, ' ').slice(0, 240),
    })),
  }
}

async function panelReadDoc(api, args) {
  const id = String(args.id ?? '').trim()
  if (id === '') throw new Error('id 不能为空')
  const data = await api('/api/export/exportMdContent', { id })
  const content = typeof data?.content === 'string' ? data.content : ''
  const limit = 400000
  const cut = truncateText(content, limit)
  return { id, hPath: typeof data?.hPath === 'string' ? data.hPath : '', markdown: cut.text, truncated: cut.truncated }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

function mount(ctx) {
  onConfigCorrupt = (file, reason) => {
    try {
      ctx.logger?.warn?.(`[siyuan-notes] 配置文件 ${file} 有问题：${reason}`)
    } catch {
      // 日志本身失败不影响功能
    }
  }

  // 旧插件 @yoursc/dsh-siyuan 用的是公共 ref `SIYUAN_TOKEN`，本插件不读它。
  // 见到就删：库里留一条没人用、却能让"没填 token 也能用"的凭据，比没有更糟。
  void dropLegacyToken(ctx)

  // makeApi(signal) = 一次工具调用用的请求函数；配置与 token 每次现读。
  const allTools = buildTools((signal) => createApi(ctx, signal))
  const toolDisposers = []

  const disposeTools = () => {
    while (toolDisposers.length > 0) {
      const dispose = toolDisposers.pop()
      try {
        dispose()
      } catch {
        // 卸载失败不该挡住后面的重新注册
      }
    }
  }

  /** 先全部卸掉再按开关注册：宿主对同名工具会注册失败，不能"补差量"。 */
  const syncTools = () => {
    disposeTools()
    const config = readConfig()
    for (const entry of allTools) {
      if (!isToolEnabled(config, entry.definition.name, entry.group)) continue
      entry.definition.group = entry.group
      try {
        toolDisposers.push(ctx.tools.register(entry.definition))
      } catch (error) {
        // 同名工具已被别的插件占用时不该拖垮整个 apply：否则路由与设置页也会一起消失，
        // 用户只看到"插件已启用"却没有任何工具可用。逐个降级，其余照常。
        try {
          ctx.logger?.warn?.(`[siyuan-notes] 工具 ${entry.definition.name} 注册失败：${error?.message ?? String(error)}`)
        } catch {
          // 日志失败不影响继续注册
        }
      }
    }
  }

  ctx.effect(() => disposeTools, 'siyuan-notes: tools')

  const handlers = {
    async getState() {
      return buildStatePayload(ctx, allTools)
    },

    async updateConfig(body) {
      const current = readConfig()
      const next = { ...current, tools: { ...current.tools } }
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') next.baseUrl = normalizeBaseUrlInput(body.baseUrl)
      if (typeof body.defaultNotebook === 'string') {
        const notebook = body.defaultNotebook.trim()
        if (notebook !== '') {
          // 用直接 siyuanFetch + tokenValue 做校验，而不是走 createApi：
          // createApi 在没 token 时直接抛 missingTokenError，会让用户配 token
          // 之前连默认笔记本都选不了。没 token 时降级为不校验。
          try {
            const token = await tokenValue(ctx)
            const data = await siyuanFetch(readConfig(), token, '/api/notebook/lsNotebooks', {}, PROBE_TIMEOUT_MS)
            const items = Array.isArray(data?.notebooks) ? data.notebooks : []
            const known = items.map((nb) => nb.id ?? '')
            if (!known.includes(notebook)) throw new Error(`笔记本 ${notebook} 不存在，请从下拉列表里选。`)
          } catch (error) {
            // 如果错误跟 token 无关（比如内核离线），照常抛出；
            // 只有"没 token / token 被拒"时降级——用户在配 token 的流程中，
            // 此时先保存笔记本 ID 等他配好 token 后再来校验。
            if (error?.kind === 'siyuan' || error?.kind === 'config') {
              // 降级：不校验，先存下。下次 getState 会用真实 token 再验证。
            } else {
              throw error
            }
          }
        }
        next.defaultNotebook = notebook
      }
      if (body.tools !== null && typeof body.tools === 'object' && !Array.isArray(body.tools)) {
        for (const [key, value] of Object.entries(body.tools)) {
          if (typeof value === 'boolean') next.tools[key] = value
        }
      }
      writeConfig(next)
      syncTools()
      return buildStatePayload(ctx, allTools)
    },

    async setToken(body) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('宿主没有凭据服务：请在启动 dsh 的环境里设置 SIYUAN_NOTES_TOKEN。')
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error('token 不能为空；要清除请用 clearToken。')
      // 先验证再落库：存一个错 token 会让之后每次工具调用都失败，而用户以为保存成功了。
      const config = readConfig()
      try {
        await siyuanFetch(config, token, '/api/notebook/lsNotebooks', {}, CONNECT_TEST_TIMEOUT_MS)
      } catch (error) {
        if (isAuthFailure(error)) throw new Error(`思源拒绝了这个 token：${error.msg ?? error.message}`)
        throw new Error(`token 没能验证通过（${error?.message ?? String(error)}）。可以先保存地址再点"测试连接"确认思源在线。`)
      }
      await credentials.set(TOKEN_REF, token)
      return buildStatePayload(ctx, allTools)
    },

    async clearToken() {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('宿主没有凭据服务，没有可清除的 token。')
      await credentials.unset(TOKEN_REF)
      return buildStatePayload(ctx, allTools)
    },

    /** 用草稿地址 / 草稿 token 探测，不落库：设置页的"测试连接"与"保存"因此互不干扰。 */
    async testConnection(body) {
      const config = readConfig()
      const draftBaseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '' ? normalizeBaseUrlInput(body.baseUrl) : config.baseUrl
      const draftToken = typeof body.token === 'string' && body.token !== '' ? body.token.trim() : (await tokenValue(ctx))
      const probe = await probeAddress({ baseUrl: draftBaseUrl }, CONNECT_TEST_TIMEOUT_MS)
      if (probe.verdict === 'fail') {
        return { ok: false, kind: 'unreachable', reachable: false, version: '', detail: probe.detail }
      }
      if (draftToken === '') {
        return {
          ok: false,
          kind: 'no-token',
          reachable: true,
          version: probe.version,
          detail: `地址能连通（思源 ${probe.version || '(未知版本)'}），但还没有配置 API Token：本插件不会以匿名身份访问思源。`,
        }
      }
      try {
        const notebooks = await siyuanFetch({ baseUrl: draftBaseUrl }, draftToken, '/api/notebook/lsNotebooks', {}, CONNECT_TEST_TIMEOUT_MS)
        const count = Array.isArray(notebooks?.notebooks) ? notebooks.notebooks.length : 0
        return {
          ok: true,
          kind: 'ok',
          reachable: true,
          version: probe.version,
          notebookCount: count,
          detail: `连接成功：思源 ${probe.version || '(未知版本)'}，可见 ${count} 个笔记本。`,
        }
      } catch (error) {
        const kind = isAuthFailure(error) ? 'auth' : 'error'
        return {
          ok: false,
          kind,
          reachable: true,
          version: probe.version,
          detail:
            kind === 'auth'
              ? '地址是活的思源，但这个 token 被拒绝了（或在思源里没有开启 API token 鉴权）。'
              : error?.message ?? String(error),
        }
      }
    },

    async listNotebooks() {
      return { notebooks: await listNotebooksOf(createApi(ctx)) }
    },

    /** 主面板的左栏：某个目录下的直接子文档。 */
    async listDocs(body) {
      const config = readConfig()
      const notebook = typeof body.notebook === 'string' && body.notebook.trim() !== '' ? body.notebook.trim() : config.defaultNotebook
      if (notebook === '') throw new Error('还没有可用的笔记本：先保存地址与 token，再在设置页里选一个默认笔记本。')
      const api = createApi(ctx)
      const docPath = typeof body.path === 'string' && body.path.trim() !== '' ? body.path.trim() : '/'
      const data = await api('/api/filetree/listDocsByPath', { notebook, path: docPath })
      const files = Array.isArray(data?.files) ? data.files : []
      return {
        notebook,
        path: typeof data?.path === 'string' ? data.path : docPath,
        docs: files.map((file) => ({
          id: file.id ?? '',
          name: file.name ?? '',
          path: file.path ?? '',
          subFileCount: typeof file.subFileCount === 'number' ? file.subFileCount : typeof file.count === 'number' ? file.count : 0,
          hMtime: typeof file.hMtime === 'string' ? file.hMtime : '',
        })),
      }
    },

    async search(body) {
      return panelSearch(createApi(ctx), body)
    },

    async readDoc(body) {
      return panelReadDoc(createApi(ctx), body)
    },
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const trust = trustBoundary(ctx)
          if (!isTrustedRequest(req, trust)) {
            writeJson(res, 403, { ok: false, error: { message: 'forbidden', hint: trustHint(req, trust) } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(API_PREFIX + '/') ? pathname.slice(API_PREFIX.length + 1) : ''
          const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
          if (handler === undefined) {
            writeJson(res, 404, { ok: false, error: { message: `unknown siyuan-notes api method "${method}"` } })
            return
          }
          try {
            const body = await readJsonBody(req)
            const value = await handler(body)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            writeJson(res, 200, { ok: false, error: { message: error?.message ?? String(error) } })
          }
        },
      }),
    'siyuan-notes: settings routes',
  )

  // 工具最后注册：即使个别工具名被别的插件占用，设置页路由与状态接口也已经就位。
  syncTools()
}

export function apply(ctx) {
  // cordis 规定：没有声明 inject 的上下文读 ctx.tools / ctx.webServer 会抛
  // "cannot get property ... without inject"，所以服务访问都走注入后的子上下文。
  ctx.inject(['tools', 'webServer'], (sctx) => {
    mount(sctx)
  })
}

/** 测试缝：纯函数与请求函数导出，仅供本地 harness 使用（多出的命名导出对宿主无副作用）。 */
export const internals = {
  buildStatePayload,
  authHint,
  createApi,
  missingTokenError,
  configPath,
  decodeResponseBody,
  isToolEnabled,
  isTrustedRequest,
  normalizeBaseUrlInput,
  normalizeConfig,
  normalizeSqlStatement,
  parseDateArg,
  readConfig,
  renderDailyPath,
  siyuanFetch,
  trustBoundary,
  writeConfig,
  DEFAULT_CONFIG,
  TOOL_GROUP_DEFAULTS,
  TOKEN_REF,
  API_PREFIX,
}
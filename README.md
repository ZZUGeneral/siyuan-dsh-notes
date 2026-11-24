# dsh-siyuan-notes

把 [思源笔记](https://b3log.org/siyuan/) 接进 DeepSeek Harness：模型可以直接检索、读取、写入你的笔记；你也可以在设置页配置连接，在聊天侧边抽屉里翻笔记、搜全文、预览 Markdown。

## 装了什么

**17 个工具**（按四组开关，默认只开「读取」与「日记」）：

| 组 | 工具 | 说明 |
| --- | --- | --- |
| 读取 | `siyuan_list_notebooks` | 列出笔记本 |
| 读取 | `siyuan_list_docs` | 列某个路径下的文档 |
| 读取 | `siyuan_search` | 全文检索 |
| 读取 | `siyuan_read_doc` | 读整篇文档的 Markdown |
| 读取 | `siyuan_get_child_blocks` | 看一个块的直接子块 |
| 读取 | `siyuan_get_block_attrs` | 读块属性 |
| 读取 | `siyuan_sql` | 只读 SQL 查询（单条 SELECT） |
| 写入 | `siyuan_create_doc` | 新建文档 |
| 写入 | `siyuan_append_block` | 往文档末尾追加 |
| 写入 | `siyuan_insert_block` | 在某个块之后插入 |
| 写入 | `siyuan_update_block` | 覆盖一个块的内容 |
| 写入 | `siyuan_set_block_attrs` | 写块属性 |
| 写入 | `siyuan_move_doc` | 移动文档 |
| 写入 | `siyuan_rename_doc` | 改名 |
| 日记 | `siyuan_daily_note` | 读/追加今天的日记 |
| 删除 | `siyuan_delete_block` | 删块（需 `confirm=true`，拒绝文档块） |
| 删除 | `siyuan_remove_doc` | 删文档（需 `confirm=true`） |

删除类工具有两处兜底：块与文档类型在删除前先判定（思源对「用删块接口删文档」会返回成功但什么都没发生，所以文档只会被指路到 `siyuan_remove_doc`），删除后再复核 id 是否真的消失，没消失就明确报错而不是假装成功。

**设置页**（设置 → 思源笔记）：服务器地址、API Token、默认笔记本、每个工具的开关、连接测试与内核版本。

**聊天侧边抽屉**：会话标题栏右侧的思源图标打开，可以按笔记本浏览目录、全文检索、预览 Markdown 并复制。

## 配置

1. 思源必须开启内核 API：设置 → 关于，确认地址（默认 `http://127.0.0.1:6806`）。
2. 在「设置 → 关于 → API token」里查看或生成一个 token，粘贴到插件设置页保存（这是**必填**的）。
   Token 存在 DSH 的凭据库 `SIYUAN_NOTES_TOKEN` 项下，不写进任何配置文件，也不回显给前端；也可以用同名环境变量提供。
   **没有 token 时插件不会以匿名身份访问思源**：所有工具与侧边抽屉都会直接报错并指路设置页——思源对本地直连不带鉴权头的请求是放行的，所以这一层拦截必须由插件自己做。
   启动时若发现旧插件（`@yoursc/dsh-siyuan`）遗留的公共凭据 `SIYUAN_TOKEN`，会顺手删掉（只删引用，不复制其值）。
3. 点「测试连接」看到「已连接 + 内核版本」即可。

## 安全边界

- 设置页与抽屉走插件自己的 `POST /siyuan-notes/api/*` 路由，带信任围栏（Host / Origin / Sec-Fetch-Site 校验），陌生来源一律 403。
- 没有配置 API Token 时一切读写都被拒绝（插件不代你匿名访问）；写操作与删除另外默认关闭，需要你在设置页显式打开。
- 单个响应体上限 2 MiB，文档预览超过 40000 字符会截断并标注。
- 插件的后端只把请求转发到你配置的思源地址，不做其它网络访问。

## 开发

```bash
node --check index.js && node --check lib/client.js   # 语法检查
node test/harness.mjs        # 假宿主跑一遍工具面、路由与写入闭环（会连真实思源，结束时删掉临时文档）
node test/client-smoke.mjs   # 假 React/DOM 加载客户端 bundle，校验 4 个槽位注册与组件渲染
```

客户端 UI 在 `lib/client.js`（`window.__ModuleLoader__` 包一层），Host 在 `index.js`。
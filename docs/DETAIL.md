# 思源笔记（dsh-siyuan-notes）

这个插件把思源笔记（SiYuan）接到 DeepSeek Harness 里，分三块：模型可调用的工具、设置页、聊天侧边抽屉。

## 连接方式

插件只做一件事：把请求转发到你自己配置的思源内核地址（默认 `http://127.0.0.1:6806`）。它不访问其它网络，也不上传任何内容。思源的接口恒返回 HTTP 200，成功与否看响应体里的 `code`，所以插件把 `code !== 0` 当成失败，并把思源的 `msg` 原样带回给模型和设置页。

Token 是必填的：请在「设置 → 关于 → API token」查看或生成后填入。它保存在 DSH 凭据库的 `SIYUAN_NOTES_TOKEN` 项下（环境变量同名；也接受老名字 `SIYUAN_TOKEN`），不会出现在配置文件、日志或工具返回里。设置页只显示「已配置 / 来源」，不回显值。

## 工具

四组共 17 个工具，按组分配默认开关：

- **读取**（默认开）：`siyuan_list_notebooks`、`siyuan_list_docs`、`siyuan_search`、`siyuan_read_doc`、`siyuan_get_child_blocks`、`siyuan_get_block_attrs`、`siyuan_sql`
- **写入**（默认关）：`siyuan_create_doc`、`siyuan_append_block`、`siyuan_insert_block`、`siyuan_update_block`、`siyuan_set_block_attrs`、`siyuan_move_doc`、`siyuan_rename_doc`
- **日记**（默认开）：`siyuan_daily_note`
- **删除**（默认关）：`siyuan_delete_block`、`siyuan_remove_doc`

每个工具还能单独开关。关掉的工具不会注册到模型，模型看不到也调不到。

### 写入与删除的判定

思源有两处反直觉的行为，插件都做了兜底：

1. **对文档用删块接口会「假成功」**：`/api/block/deleteBlock` 收到文档 id 返回 `code: 0`，但什么都没删。所以插件在删除前先判定这个 id 是文档还是块：文档块的 `siyuan_delete_block` 会直接被拒绝，并提示改用 `siyuan_remove_doc`；反过来 `siyuan_remove_doc` 只接受文档。
2. **新建的内容在 SQL 索引里会晚几秒**：刚 `createDocWithMd` 的文档立刻查 `/api/query/sql` 可能是 0 行。所以存在性判断走块树（`/api/attr/getBlockAttrs`），不走 SQL 索引；写完再复核，删除后再确认 id 真的消失，没消失就报错而不是假装成功。

`siyuan_sql` 只接受单条 `SELECT`，中间出现分号会被拒绝，避免误写。

## 设置页

「设置 → 思源笔记」：

- **服务器地址**：失焦时自动保存；旁边的「测试连接」会带上当前草稿值试一次，不会先保存。
- **API Token**：保存前先用 `lsNotebooks` 验证一次，验证通过才进凭据库。
- **默认笔记本**：新建文档、列目录时的默认目标。
- **工具开关**：按组列出 17 个工具，勾选即生效。

## 聊天侧边抽屉

会话标题栏右侧的思源图标可以打开抽屉，抽屉里可以：

- 切换笔记本，逐层进入子文档；
- 全文检索（结果带命中片段）；
- 点开文档看 Markdown 预览，一键复制原文。

预览用的就是 DSH 自己的 Markdown 渲染器（`@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`，与聊天区同一套），标题、表格、代码块、链接、待办都能正常显示；只有在拿不到该组件（旧版 DSH）时才退回插件自带的轻量渲染。渲染出错也会自动回退，不会白屏。

抽屉是浮层形式，不抢占聊天区，点击抽屉外的界面照常可用。开合状态在标题栏按钮和抽屉之间共享。

## 排错

- **连不上**：确认思源在运行、内核地址正确、没被防火墙挡住；在浏览器里直接打开那个地址应该能看到思源。
- **Token 无效**：重新在思源「设置 → 关于」生成，粘贴时注意别带空格；也可以在插件设置里「清除」后重填。
- **工具里没有写入**：写入与删除默认关闭，去设置页打开。
- **搜不到刚写的内容**：思源全文索引有延迟，稍等再搜；工具返回的是索引结果，不是实时块树。
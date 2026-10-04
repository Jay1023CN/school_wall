# 校墙架构与维护说明

这份文档只记录代码边界、数据生命周期和维护入口，不记录服务器地址、账号、令牌或密钥。

## 目录边界

```text
server.js                 环境加载、运行生命周期与进程退出入口
app.js                    HTTP 应用工厂，不监听或初始化数据库
http/                     中间件、页面静态服务及有序 API 挂载
  middleware.js           请求体、跨域、日志等通用 HTTP 中间件
  static-pages.js         无扩展名页面别名、静态文件和缓存头
  routes.js               API 前缀与路由挂载顺序
modules/songs/            点歌模块依赖组装，共享维护服务实例
repositories/             注入连接后的 SQL 数据访问
config/environment.js     .env / .env.local 的启动加载入口
services/runtime.js       数据库、HTTP 监听及有界退出的生命周期
jobs/index.js             后台维护任务统一启停与等待
services/task-lifecycle.js 无加载副作用的定时任务控制器
routes/                   HTTP 路由与参数/权限校验
services/                 可复用业务能力（清理、头像、分页、公众号素材等）
middleware/               认证、权限和请求前置处理
config/database.js        数据库连接、历史启动 DDL 与迁移入口
config/schema-migrations.js 版本化新表迁移（schema_migrations）
frontend/                 前端静态源文件
public/                   运行时静态镜像，需与 frontend/ 保持一致
scripts/                  可重复执行的检查与维护脚本
deploy.sh                 拉取、同步、重启、健康检查和回滚
```

路由层负责“请求是否允许、参数是否有效、返回什么”，复杂或可复用的业务应下沉到 `services/`。数据库初始化仍包含历史表的启动 DDL、字段补齐和索引存在性检查；`config/schema-migrations.js` 另外为新结构提供版本化迁移，记录在 `schema_migrations` 中。当前迁移 v1 创建写入收据、名额预约和通知 outbox 表，v2 创建公众号持久同步任务及其 guard 表。MySQL DDL 会隐式提交，版本记录在该迁移的 DDL 全部成功后才写入；中途失败时下次启动会重试，并在已记录版本上再次只读校验列、索引和 InnoDB 引擎。两套机制都在启动锁内执行，重复启动不会重复应用同一版本，但历史启动 DDL 尚未整体移除。HTTP 路由的统一前缀和挂载顺序只在 `http/routes.js` 维护；页面别名和静态缓存行为只在 `http/static-pages.js` 维护。

## 点歌维护的依赖边界

点歌 HTTP 路由和后台任务通过 `modules/songs/index.js` 共享维护服务。`services/song-maintenance.js` 只编排日期窗口、时段容量、周期、生效日期、播放归档和通知；数据库访问全部通过注入的 `repositories/song-maintenance.js` 完成。repository 接收现有连接池或事务连接，不创建连接池、不依赖 Express、不发送邮件。时钟与通知发送器可注入以离线验证。

点歌提交、投票和后台审核的既有事务仍由原调用链维护，本次只迁移自动维护职责。`services/date.js` 统一提供中国日期窗口和时间，`services/number-utils.js` 复用正整数上限解析。退出时等待播放归档及由该轮归档安排的通知；不重复通知未成功更新的歌曲。该模块的离线测试通过注入时钟、repository 和通知发送器完成，不需要启动 Express 或连接业务数据库。

## 运行生命周期

`app.js` 的 `createApp()` 只组装 HTTP 行为，中间件、静态页面与 API 挂载依次由 `http/` 的三个模块完成。API 表保持原有路径和挂载顺序；应用工厂允许注入静态根目录、跨域配置及路由解析器用于独立验证。`server.js` 兼容导出 `app/start/stop`，仅直接执行时安装进程信号和异常处理器。

加载路由只注册接口与任务控制器，不启动验证码清理、点赞缓存清理、点歌归档、日期维护或公众号状态清理。`server.js` 通过 `services/runtime.js` 先初始化数据库，再确认 HTTP 监听成功，最后调用 `jobs/index.js` 启动任务。启动和停止幂等，监听失败不会启动任务。

收到 SIGTERM/SIGINT 后，服务停止接收新请求并取消维护定时器，等待已接收请求以及执行中的日期维护、数据清理、公众号同步和通知 outbox 任务，再关闭连接池。`server.js` 将 `SHUTDOWN_TIMEOUT_MS` 限制在 1 秒至 5 分钟，默认 240000 毫秒；超时会关闭连接并以失败退出。systemd 的 `TimeoutStopSec`/`StopTimeoutSec` 必须大于该值，否则 systemd 可能先于应用完成排空。公众号同步和通知发送的状态持久化在数据库中，租约过期后可由新进程恢复；外部微信草稿请求在进程退出或超时后仍可能结果未知，任务会进入 `needs_review`，不会自动重发以避免重复草稿。

`npm run test:runtime` 使用模拟数据库和临时端口真实监听验证加载副作用、慢任务去重、重复启停、启动失败及退出超时，不修改业务数据。

`npm run test:http` 在临时端口验证页面别名、缓存响应头、跨域白名单、匿名和五种角色权限，以及数据库不可用时的状态码，不连接业务数据库或发送外部通知。`npm run test:runtime` 验证启动、停止、慢任务去重和监听失败边界；两者都不代表真实数据库、微信或 SMTP 已在线可用。

## 事务收据与通知 outbox

预约表的历史 `status` 列可保留支持 `confirmed/cancelled` 写入的旧 ENUM 或足够长的 VARCHAR；启动时只读核对历史值，NULL 或未知状态仍会阻止启动，不自动修改历史预约。索引校验按列顺序和唯一性识别等效旧索引，不要求普通索引名称一致。

`services/write-transaction.js` 将业务写入和 API 幂等收据放在同一个 MySQL 事务中。带 `Idempotency-Key` 的请求必须先登录，键名为 16—128 个 ASCII 字符；相同用户、作用域和键会回放已保存响应，内容摘要变化返回 409。业务结果为 4xx 或 5xx 时回滚，异常也回滚并释放连接；没有键的写入仍使用同一事务边界，但不会提供回放能力。

反馈提交由 `routes/feedback.js` 在同一事务中完成反馈写入和管理员邮件 outbox 登记。`services/notification-outbox.js` 按收件人去重，使用 120 秒租约、claim token 和指数退避重试，达到上限后标记为 `failed`。SMTP 发送函数返回成功只表示发送器接受了本次发送；该 outbox 是至少一次投递，丢失确认或租约恢复可能造成重复邮件，不能证明邮件已经进入收件箱。反馈表及历史业务表的兼容性 `ensure...` 启动 DDL 仍保留。

## 持久化公众号同步任务

`services/mp-sync-jobs.js` 使用 `mp_sync_jobs`、`mp_sync_owners` 和队列 guard 表保存公众号同步任务、每个用户的活动任务锁、进度、结果、尝试次数和租约。`routes/mp-draft.js` 当前以并发 2、活动队列上限 100、240 秒租约启动 worker；数据库 advisory lock 保证同一数据库只运行一个 worker，因此 `DB_CONNECTION_LIMIT` 至少设为 3（示例值 10），避免锁连接占满连接池。进程重启或租约过期时，未开始外部调用的任务回到队列；已经标记外部调用开始但尚未记录 `media_id` 的任务进入 `needs_review`。草稿已创建而每日歌曲本地回写失败时，任务保留 `media_id`，只重试本地补标记，不再次调用微信创建草稿；重试达到上限后进入 `mark_failed`，该状态仍表示远端草稿已存在，不能按新任务重发。

`POST /api/mp/sync-review` 受公众号最高管理员和 `songs:review` 权限检查约束，且只能处理本人任务。请求需要 `sync_id` 和 `decision`：`decision=created` 必须提供已核实的 `media_id`，可恢复 `needs_review` 或 `mark_failed` 的本地补标记；已有草稿记录时不得更换 `media_id`。`decision=not_created` 只接受 `needs_review`，必须显式提供 `confirm_no_draft=true`。两种处理都不会自动创建草稿；人工核对前应先查看微信公众平台草稿箱。`GET /api/mp/sync-status` 只返回任务所有者可见的状态。

worker 认领任务时生成新的 `claim_token`，续租、完成和失败写回必须匹配该 token；恢复过期任务和人工核对会作废旧 token，旧进程不能覆盖新 worker 的状态。`services/database-transaction.js` 统一处理回滚失败：销毁状态不明的连接并阻止归还连接池，保留原业务异常。

## 内容生命周期

帖子和点歌记录的删除采用软删除：

1. 用户端或管理端删除时只写入回收站时间。
2. 普通列表、详情、评论、点赞、收藏、投票、浏览量和公众号素材查询都必须排除已删除记录。
3. 管理员可在回收站恢复或彻底删除。
4. 定时清理任务在保留期后执行物理删除；当前回收站保留期为 7 天。未发布帖子图片保留 7 天，未发布视频保留 30 天，具体常量由 `services/cleanup.js` 维护。

接口层仍要检查 `affectedRows`，因为页面打开后可能有另一个请求先完成删除、恢复或彻底清理。这样前端收到 404 后可以刷新列表，不会把过期按钮状态当成成功状态。

## 点歌审核和拒绝通知

点歌拒绝理由由后台维护，并随审核结果保留在点歌记录中：

1. 系统设置中的“点歌拒绝理由预设”按每行一个模板保存，后台审核弹窗可以选择、直接修改、更新当前预设，或另存为新预设。
2. 预设存放在 `settings.song_reject_reasons`，最多保留 20 条，每条最多 500 个字符；单独保存接口为 `PUT /api/admin/settings/song-reject-reasons`。
3. 拒绝单条或批量点歌时必须提交理由。审核接口把理由写入 `song_requests.reject_reason`，详情页用于追溯，邮件模板也会展示该理由。
4. 点歌审核通知沿用用户邮件通知偏好 `notify_song_approved` / `notify_song_rejected`。实际发信还要求用户有有效邮箱、系统邮件开关已开启且 SMTP 配置完整；不满足条件时不会把“接口成功”当成邮件已送达。

`config/database.js` 启动时会幂等补充 `song_requests.reject_reason` 字段，并初始化默认模板。修改数据库结构或邮件配置后，应在目标环境查看邮件日志和健康检查；本地静态检查不能证明线上 SMTP 投递成功。

## 分页约定

所有列表接口优先使用 `services/pagination.js` 的 `getPagination()`：

- 非法页码和页大小回退到默认值。
- 页大小按接口用途设置上限。
- 页码和 offset 也设上限，避免异常请求生成超大数据库 offset。
- 接口响应中的页码、总页数使用数字，不直接透传查询字符串。

## 前端静态文件

`frontend/` 是唯一静态源码，`public/` 是当前运行镜像。修改前端后执行：

```powershell
npm run sync:frontend
npm run check:mirrors
npm run build
```

同步、检查和构建共用 `scripts/lib/frontend-assets.js` 的文件收集规则。同步只复制变化文件，遇到 `public/` 的独立未提交改动会停止，额外镜像文件保留并报错，交给开发者审阅。上传目录和依赖不参与生成；链接和敏感文件会被拒绝。

`npm run build` 先同步并检查镜像，再生成 `dist/` 和包含提交号、逐文件 SHA-256 的 `asset-manifest.json`。构建只清理经过路径校验的项目 `dist/`，拒绝链接输出目录。生产仍沿用现有静态目录部署流程，尚未切换为发布 `dist/`；`dist/` 是可审计构建产物，不是当前 Express 静态根目录。`npm run test:frontend-assets` 在临时目录验证同步冲突、幂等、上传保留、路径保护和构建清单。

## 部署安全边界

`deploy.sh` 的流程是：

```text
拉取指定发布源
  -> 安装依赖
  -> 检查 frontend/public 镜像
  -> 数据库迁移预检（失败则保留旧进程）
  -> 同步 Nginx 静态目录（如配置）
  -> 重启服务
  -> 请求健康检查
       ├─ 成功：保留新版本
       └─ 失败：恢复部署前提交并再次健康检查
```

脚本使用单实例锁，避免多个 webhook 同时 reset、安装和重启。健康检查只验证应用可用性，不把凭据写入日志。

`scripts/check-database-startup.js` 在重启前按服务相同的环境加载规则执行数据库初始化和 schema 校验，不监听 HTTP、不启动后台发送任务。预检失败时恢复旧代码，保留未被重启的旧进程；`/api/deploy-status` 的 `diagnostics` 只公开该提交对应的错误码、SQL 操作类别和表名，不返回完整 SQL、参数、连接配置或异常消息。该预检包含 MySQL DDL，已完成的新增表不会随代码回滚而删除。

Gitee webhook 使用 `X-Gitee-Token` 与环境变量 `DEPLOY_SECRET` 做定时安全比较，并只响应 `DEPLOY_BRANCH`（默认 `main`）的推送；请求返回 `202 Accepted` 只表示部署子进程已接受启动，不代表新版本已经上线。`GET /api/deploy-status` 使用同一凭据返回不含敏感信息的状态、提交和退出码，状态文件由脚本原子写入部署目录的日志目录。实际结果也写入部署日志，webhook 进程只记录不含凭据的启动错误。生产环境应由 Webhook 启动独立的 `wall-deploy.service`，让部署进程脱离 `wall.service` 的控制组；脚本默认通过服务器已配置凭据的 Gitee SSH 仓库拉取 `main`（可用环境变量切换为其他受信任地址），并在重启和健康检查失败时恢复部署前提交。由于 systemd 的 PATH 可能不包含面板 Node.js，脚本会探测 `/www/server/nodejs/*/bin/node` 并在安装依赖前确认 node/npm 可用；Webhook 以 `www` 用户运行时，仅通过 sudoers 授权启动部署单元、重启 `wall` 服务和查询状态。

无 `rsync` 时脚本也会先清理静态目录再复制，避免旧资源残留；这一步只有在 `DEPLOY_FRONTEND_DIR` 精确等于 `DEPLOY_FRONTEND_PARENT/frontend`、父目录为绝对路径且不在部署目录内部、目标真实路径未越界时才允许执行。`systemctl` 不可用会使部署失败并进入回滚流程，不会把旧进程误判为新版本成功。线上 webhook、systemd、Nginx 路径和日志只能在服务器上验证，本仓库检查不替代线上验证。

## 微信署名与历史数据修正

公众号推歌的署名步骤中，回复“跳过”按绑定账号的 `nickname → username → 用户{id}` 取值；未绑定时要求填写署名或先绑定。确认与成功消息展示实际署名，自填名字保持不变。旧会话中的空署名按同样规则处理，不再自动写入“匿名同学”。公众号普通投稿在插入时复核绑定账号，并明确写入 `posts.is_anonymous=0`。

`POST /api/deploy-maintenance/wechat-author` 是限定用途的运维接口，使用与部署相同的私有 `X-Gitee-Token` 凭据，仅修正已确认的旧推歌署名。`mode=inspect` 配合准确的 `account_name` 核对唯一绑定账号最近两天的最新微信推歌；`mode=apply` 还必须提交核对所得的 `record_id` 和 `expected_name`。记录、账号或名字变化会拒绝修改；自填署名保留。修改前将旧署名写入服务器私有 `logs/wechat-author-repairs/`，随后在事务中更新一条记录。返回及备份均不包含 OpenID；接口不接受 SQL、表名、文件路径或命令。已创建的微信草稿不因数据库署名变化自动重新同步。

专项验证：`npm run test:wechat-song-flow`、`npm run test:wechat-output`、`npm run test:wechat-author-repair`。历史修正的检查覆盖未授权拒绝、只读核对、账号歧义、记录变化、自填署名保护、备份失败、事务回滚和重复请求。

准确账号名称未命中时，核对响应最多附带五条最近两天、歌曲/歌手/账号名称包含所提供名字的微信推歌，帮助辨认账号别名或歌曲信息。候选仅用于人工核对，不能直接授权修改；实际修改仍要求准确账号匹配。

旧推歌未绑定账号时，系统不能从歌手名推断投稿者名字。操作人获得用户明确指定的署名后，可使用 `mode=apply-record`，携带核对过的 `record_id`、`expected_song`、`expected_artist` 和 `replacement_name` 修正该条记录。此模式同样仅处理最近两天的微信推歌、保存旧值并使用事务；已有绑定账号或自选署名的记录会拒绝修改。明确署名由授权操作人提供，不作自动身份推断。

## 审核前检查

不启动本地服务时，可执行以下静态检查：

```powershell
npm run test:pagination
npm run test:runtime
npm run test:http
npm run test:song-maintenance
npm run check:mirrors
npm run check:privacy
node scripts/test-deployment-static.js
git diff --check
```

后台内联脚本还应使用 Node 的 `--check` 检查；真实手机和 PC 的视觉验收仍需在目标环境完成，静态检查不能替代真机观察。

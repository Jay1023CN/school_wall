# 校墙项目源码索引

> 目的：让 Codex 和开发者先命中入口文件，再按调用链展开，减少无效的全仓库搜索。索引只记录稳定的导航信息，不替代源码事实。

## 使用方法

1. 先按下面的功能表选择页面入口或后端路由。
2. 先读入口文件及其直接依赖，再根据实际调用关系扩展搜索。
3. 如果索引与源码不一致，以当前源码和实际运行结果为准，并在任务完成后更新本文件。

## 运行与目录关系

| 作用 | 位置 | 说明 |
| --- | --- | --- |
| 服务入口 | `server.js`、`config/environment.js` | 环境配置与进程启动、退出 |
| HTTP 应用组装 | `app.js` → `http/middleware.js`、`http/static-pages.js`、`http/routes.js` | 中间件、静态页面与 API 挂载；构建应用不初始化数据库、不监听、不启动任务 |
| 运行生命周期 | `services/runtime.js` | 数据库初始化、监听、任务启动、有界退出 |
| 数据库初始化与迁移 | `config/database.js`、`config/schema-migrations.js` | 历史表仍由启动 DDL/字段索引检查兼容；新表由 `schema_migrations` 记录版本化迁移 |
| 写入事务与幂等 | `services/write-transaction.js` | 业务写入与 `api_write_requests` 收据同事务；键和 payload 冲突返回 409 |
| 数据库事务退出 | `services/database-transaction.js` | 回滚失败销毁连接，避免未知事务状态回池 |
| 通知 outbox | `services/notification-outbox.js`、`jobs/index.js` | 反馈管理员通知在业务事务中登记，后台按租约、claim token 和退避重试；SMTP 至少一次，不证明收件箱到达 |
| 公众号持久同步 | `services/mp-sync-jobs.js`、`routes/mp-draft.js` | `mp_sync_jobs` 队列、owner 锁、租约恢复与 `needs_review` 人工核对；未知微信结果不自动重发 |
| 点歌状态转换 | `services/song-state-transitions.js` | 在行锁和旧状态条件下完成审核状态转换，冲突统一返回 409 |
| 后台任务入口 | `jobs/index.js`、`services/task-lifecycle.js`、`services/cleanup.js`、`services/mp-sync-jobs.js`、`services/notification-outbox.js` | 显式启停验证码、点赞、点歌、公众号同步、通知 outbox 和清理任务；数据库租约支持进程重启恢复；路由加载不创建维护定时器 |
| 点歌维护分层 | `modules/songs/index.js` → `services/song-maintenance.js` → `repositories/song-maintenance.js` | HTTP 与后台任务共享服务实例；服务编排日期与归档规则，repository 执行 SQL |
| 实际静态目录 | `public/` | `express.static` 当前提供的页面、CSS、JS |
| 前端源码 | `frontend/` | 唯一静态源码；通过 `npm run sync:frontend` 生成 `public/` 镜像 |
| 静态生成与检查 | `scripts/lib/frontend-assets.js`、`scripts/sync-frontend.js`、`scripts/check-frontend-mirror.js`、`scripts/build-static-site.js` | 共用文件规则；生成 `public/` 镜像和带哈希清单的 `dist/`；生产当前仍提供 `public/` |
| 旧/备用模板 | `views/` | 不要默认视为当前渲染来源，需由调用链确认 |
| 部署脚本 | `deploy.sh` | 部署和同步流程入口，修改部署时先读它 |
| 部署数据库预检 | `scripts/check-database-startup.js`、`scripts/test-database-startup-check.js` | 重启前初始化/核验 schema，失败报告仅包含结构错误码；关联 `/api/deploy-status` |
| 本次发布验证 | `docs/RELEASE_VERIFICATION.md` | 实际检查、功能提交、部署核对及未实测范围 |

## 功能入口地图

### 前端页面

| 功能 | 先看这些文件 | 后端入口 |
| --- | --- | --- |
| 首页/帖子流 | `frontend/index.html`、`frontend/js/home.js`、`frontend/js/app.js` | `routes/posts.js`、`routes/auth.js` |
| 帖子详情/回复 | `frontend/post-detail.html`、`frontend/js/detail.js`、`frontend/js/detail-replies.js` | `routes/posts.js` |
| 电台/歌曲 | `frontend/radio.html`、`frontend/js/radio.js`、`frontend/css/radio-polish-enhanced.css` | `routes/songs.js` |
| 管理后台 | `frontend/admin/index.html`、`public/admin/index.html` | `routes/admin.js` |
| 点歌审核与拒绝通知 | `frontend/admin/index.html`、`routes/admin.js`、`services/email.js` | `config/database.js`、`settings.song_reject_reasons`、`song_requests.reject_reason` |
| 每日歌曲独立页 | `frontend/admin/mp-draft.html`、`public/admin/mp-draft.html` | `routes/mp-draft.js`、`services/mp-draft.js` |
| 微信公众号回调与绑定 | `frontend/profile.html`、`frontend/register.html` | `routes/wechat.js`、`services/wechat*.js`；回调为 `/api/wechat/callback` |
| 意见反馈 | `frontend/feedback.html` | `routes/feedback.js` |
| 消息 | `frontend/messages.html`、`frontend/js/messages.js`、`frontend/css/messages-polish-enhanced.css` | `routes/messages.js` |
| 个人主页 | `frontend/profile.html`、`frontend/css/profile-polish-enhanced.css` | `routes/auth.js` |
| 登录与账号 | `frontend/js/auth.js` | `routes/auth.js` |

公共样式主要在 `frontend/css/`，常用入口为 `style.css`、`base.css`、`responsive.css`、`mobile-fix.css`；页面级美化补丁放在 `*-polish-enhanced.css`，并同步到 `public/`。

### 后端路由与服务

常规路由集中在 `routes/`：

`auth.js`、`posts.js`、`songs.js`、`admin.js`、`feedback.js`、`notices.js`、`messages.js`、`wechat.js`、`checkin.js`、`reservations.js`、`notifications.js`、`leaderboard.js`、`upload.js`、`follows.js`、`mp-draft.js`、`hitokoto.js`、`site.js`、`health.js`、`deploy.js`。

匿名发布权限由 `routes/posts.js`、`routes/songs.js` 按 `settings` 实时校验；对应回归入口为 `scripts/test-anonymous-policy.js`。反馈邮件由 `routes/feedback.js` 通过 `services/notification-outbox.js` 登记，再由 `services/email.js` 发送，回归入口为 `scripts/test-feedback-notices.js`、`scripts/test-email-service.js`。

可复用业务逻辑集中在 `services/`，包括 `ai.js`、`email.js`、`wechat.js`、`wechat-flows.js`、`wechat-reply.js`、`wechat-token.js`、`mp-draft.js`、`mp-sync-jobs.js`、`notification-outbox.js`、`song-state-transitions.js`、`write-transaction.js` 等。遇到接口问题，按“页面调用 → `routes/` → `services/` → 数据访问/外部服务”顺序追踪。

管理 API 入口为 `routes/admin.js`；每日推歌和时段日历接口分别位于 `routes/admin/daily-songs.js`、`routes/admin/slots.js`，由管理入口挂载到原 API 前缀下，并继续继承管理后台登录与员工身份校验。公众号推送入口单独挂载为 `/api/mp`，但仍由 `routes/mp-draft.js` 统一执行员工与权限校验。`POST /api/mp/sync-review` 仅允许最高管理员且具备 `songs:review` 权限的任务所有者处理 `needs_review` 或补标记失败的 `mark_failed`：`created` 需 `media_id`，`not_created` 需 `confirm_no_draft=true`，系统不会自动重发未知结果。

## 常见边界

- 管理后台主页面与每日歌曲页面是两个功能边界；修后台布局、权限或管理接口时不要顺手修改 `mp-draft`。
- `frontend/` 与 `public/` 不是任意复制关系；先确认对应文件，再做最小同步。
- `views/` 只有在 `server.js` 或调用链证明会使用时才是修改目标。
- `dist/` 是本地构建产物和哈希清单，不是当前 Express 静态目录；部署静态目录由私有运维配置决定。
- 不在索引中记录密钥、Cookie、服务器密码或完整线上配置。
- 多个 Git 远程并存；发布前必须由任务明确指定目标远程。

## 验证入口

- 服务语法：`node --check server.js`
- 运行生命周期：`npm run test:runtime`（离线任务测试及临时端口真实监听，不连接业务数据库）
- HTTP 兼容：`npm run test:http`（模拟数据库、临时端口，验证页面与权限响应）
- 点歌维护：`npm run test:song-maintenance`（注入时钟与数据访问，验证周期、生效日期、容量及归档条件）
- 静态流水线：`npm run test:frontend-assets`、`npm run build`（临时目录回归；同步镜像并生成静态产物）
- 用户反馈回归：`npm run test:feedback-clarity`（评论计数、发布身份说明、点歌名额提示和分类筛选）
- 公众号推送回归：`npm run test:mp-draft-modules`、`npm run test:mp-draft-flow`、`npm run test:mp-weekly-song-schedule`（模块镜像、同步终态、推送页面和排期）
- 持久任务与事务回归：`node scripts/test-schema-migrations.js`、`node scripts/test-write-transaction.js`、`node scripts/test-notification-outbox.js`、`node scripts/test-mp-sync-jobs.js`、`node scripts/test-content-transactions.js`
- 改期重复请求：`npm run test:reschedule-idempotency`（同目标不重复写入，收据回放跳过通知）
- 架构可靠性回归：`node scripts/test-architecture-reliability.js`（代理信任、点歌状态转换和前端幂等收据）
- 管理与邮件链路语法：`node --check routes/admin.js`、`node --check services/email.js`、`node --check config/database.js`
- 补丁空白：`git diff --check`
- 前端静态改动：检查 `frontend/` 与 `public/` 对应文件内容是否同步。
- 页面改动：在实际运行页面和目标视口验证，不只看源码或构建输出。

## 更新规则

只有在入口、运行副本、目录边界或验证命令发生变化时更新本索引；保持它短小、可执行，避免变成第二份 README。

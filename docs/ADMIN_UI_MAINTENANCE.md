# 后台界面维护约定

管理后台当前入口为 `frontend/admin/index.html`，`public/admin/index.html` 是由同步脚本生成的运行镜像。公众号推送工作台入口是 `frontend/admin/mp-draft.html`，访问路径为 `/admin/mp-draft`；任何后台界面改动必须先改 `frontend/`，再运行 `npm run sync:frontend` 和 `npm run check:mirrors`，不要直接编辑镜像文件。

后台的唯一专属样式入口是 `frontend/admin/css/admin.css`。`frontend/css/style.css` 只保留全站基础样式，不能再新增或恢复 `.admin-layout`、`.admin-sidebar`、`.admin-main`、`.admin-topbar` 等后台壳层规则。

## 结构分层

- 壳层：侧栏、顶栏、主内容区、弹窗层级和 `768px / 769px` 断点，全部由 `admin.css` 维护。
- 组件层：状态徽章、筛选控件、操作按钮、表格卡片和空状态。
- 业务层：帖子、点歌、推歌、用户等面板的渲染和接口调用。
- 主题层：`frontend/admin/css/admin.css` 中的 `--admin-*` 语义 token；主题只能重映射 token，不能复制组件或响应式规则。

移动端视觉使用“个人资料卡片”语言：暖白/浅粉背景、细边线、低强度阴影和清晰正文对比。该视觉层集中在 `admin.css` 的移动端公共区段，覆盖所有后台面板的共同外观；业务面板只补充自身的信息结构，不能各自发明另一套渐变或卡片颜色。

视觉含义由组件层统一提供：同一个“通过 / 暂不安排 / 删除”等操作在桌面和手机端保持同一颜色、边框和文字。移动端只调整栅格、间距、按钮尺寸与换行，不能重新定义业务状态颜色。

## 改动规则

1. 一个面板只保留一套生效的移动布局；替换旧方案时删除旧规则，不在文件末尾叠加“最终覆盖”。
2. 不用 JS 内联颜色表达状态；新增状态使用语义 class 或 `data-status`，在组件 CSS 中集中定义。
3. 顶栏、侧栏和弹窗各自拥有明确层级；内容区必须保留顶部和底部安全距离，不能被固定层遮住。
4. 抽屉仅能在 `768px` 及以下打开；`769px` 起菜单按钮必须隐藏，桌面即使残留遮罩状态也必须强制隐藏。
5. 先改共享组件，再改面板细节；只有确实不同的业务信息才写在面板作用域内。
6. `data-theme` 只负责浅色/深色，`data-admin-theme` 是后台皮肤扩展点。新增主题通过 `window.setAdminThemeVariant('theme-name')` 切换，并只新增对应 token 映射。
7. 浮层统一使用 `--admin-z-shell`、`--admin-z-drawer`、`--admin-z-overlay`、`--admin-z-modal`、`--admin-z-toast`；不再写任意的四位或六位 `z-index`。

## 验收

- 桌面：`769px` 及常用宽度下检查表格、颜色、操作和弹窗。
- 移动：至少检查 `390px`、`768px`，确认无横向滚动、顶栏遮挡或卡片截断。
- 运行 `npm run check:mirrors`、相关脚本和 `git diff --check`；涉及视觉改动时保留实际视口核验记录。
- 主题改动额外检查浅色/深色、刷新后的持久化，以及临时 `data-admin-theme` 覆盖是否只改变颜色而不改变布局。

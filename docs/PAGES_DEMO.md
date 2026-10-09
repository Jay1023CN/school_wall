# 校园墙 GitHub Pages 演示

演示地址：https://jay1023cn.github.io/school_wall/

## 演示来源与范围

演示复用公开镜像中的 `frontend/`，页面基于 Gitee `main` 已发布版本。首次建立演示时核对的 Gitee 提交为 `cf5626de4887c36bfe08d21c414799883f7dfcee`；GitHub 镜像保留独立的脱敏历史，不合并生产仓库历史。后续同步经审阅的页面源码后，演示随 GitHub `main` 自动更新。

浏览器端 `demo/runtime.js` 提供虚构帖子、歌曲、账号与私信，通过同源 API 拦截支持浏览、评论、点歌及后台审核。数据写入演示域名下的浏览器存储，不会进入服务器数据库；顶部“重置演示”可清除本演示操作。未实现的操作返回明确提示，不伪装成成功。

| 功能 | 演示行为 |
| --- | --- |
| 首页、分类、详情 | 读取虚构帖子，支持分类和搜索 |
| 点歌、评论、私信、审核 | 在当前浏览器中记录操作 |
| 管理后台 | 自动切换到虚构管理员，无真实管理权限 |
| 邮件、微信同步、AI、上传 | 不执行真实外部操作 |
| 登录与注册 | 顶部入口切换演示身份；不会创建真实账号 |

## 本地构建与预览

需要 Node.js；构建本身仅使用标准库，不需要 MySQL 或私有配置。

```bash
npm run build:demo
python -m http.server 8080 --directory .pages-demo
```

上方默认构建面向 GitHub 的仓库子路径。本地站点根目录预览需要将构建基础路径设为 `/`：

```powershell
$env:PAGES_BASE_PATH = '/'
npm run build:demo
python -m http.server 8080 --directory .pages-demo
```

访问 `http://localhost:8080/`。发布到 GitHub 时保留默认 `/school_wall/`，以适配仓库子路径。`.pages-demo/` 是忽略的构建产物，不提交 Git。

## 自动发布

`.github/workflows/pages-demo.yml` 在 GitHub `main` 推送或手动触发时执行构建、上传 Pages 产物并发布。仓库 Pages 的发布来源为 GitHub Actions，首页 Website 指向演示地址。

构建器 `scripts/build-pages-demo.js` 只复制前端允许的文件类型，禁止链接与敏感文件，排除 `uploads/`。产物内注入演示 API 与顶部身份入口，调整资源、导航和帖子详情的仓库子路径，替换专用学校名称及真实站点地址，移除搜索提交脚本。前端源码和生产镜像不受演示注入影响。

`demo-build.json` 记录 GitHub 构建提交与基础路径，用于确认当前线上版本。Pages 部署成功后还需要实际打开首页、点歌、详情、私信和后台，确认资源及导航正常。

浏览器专项回归：默认基础路径构建后运行 `python scripts/test-pages-demo-browser.py`（需 Playwright 与 Edge，可用 `WALL_BROWSER_CHANNEL` 指定浏览器）。可通过 `DEMO_TEST_URL` 指定已发布演示地址；测试操作仍只进入演示浏览器存储。

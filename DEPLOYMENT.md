# RoseKhlifa 博客部署记录

在线写作已于 2026-10-20 启用，管理路由已接入 1Panel，日常文章和图片请使用 **https://blog.rosekhlifa.com/admin/**。登录界面为普通网页表单，原账号密码保持不变。账号和操作说明见 [ONLINE-WRITING.md](ONLINE-WRITING.md)。服务器 `source` 目录保存最新内容；以下本地部署命令属于首次静态部署和维护流程，`Deploy.ps1` 现会先检查在线写作模式，保护服务器上新增的文章。

部署基于用户选定的 [cxro/astro-whono](https://github.com/cxro/astro-whono)，上游版本 `0.5.0`，源码基线提交 `b6bc4f9d484528cc522c7c1a5cab9cc425c91918`。本地分支为 `deploy/first-deployment`。主题代码、示例文章和配置保持上游内容；当前站名、作者、简介、About 和文章都是 Whono 主题演示资料，后续请替换为真实信息。

| 配置项 | 实际值 |
| --- | --- |
| 本地目录 | `E:\RoseKhlifa.com\blog` |
| 首次上线时间 | 2026-10-20，Asia/Shanghai |
| 公网入口 | `http://51.83.101.143:18180` |
| 生产 SITE_URL | `https://blog.rosekhlifa.com` |
| 构建根路径 | `/` |
| SSH | `ssh root@51.83.101.143`，沿用本机已有认证 |
| 服务器部署根目录 | `/opt/rosekhlifa-blog` |
| Compose 项目 / 容器 | `rosekhlifa-blog` / `rosekhlifa-blog` |
| 端口 | 宿主 `0.0.0.0:18180` → 容器 `8080` |
| 首次发布 ID（UTC） | `20261019T171705Z-b6bc4f9d4845` |
| 发布产物 | `/opt/rosekhlifa-blog/releases/20261019T171705Z-b6bc4f9d4845` |
| 当前站点 | `/opt/rosekhlifa-blog/current`，相对符号链接 |
| 静态服务 | Nginx，独立 Docker 容器 |
| 重启策略 | `unless-stopped`；服务器 Docker service 已 `enabled` |

`deploy/site.env` 保存正式 `SITE_URL` 与根路径。构建时通过进程环境显式传给 Astro，canonical、Open Graph、RSS、sitemap 和 robots 使用正式域名。导航和本地资源保持 `/...` URL，所以 IP 加端口能正常访问。默认示例 About 含外站链接和远程示例头像。

`deploy/runtime.env` 将镜像固定为本次拉取并验证过的 digest：

```text
nginx@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
```

容器以 UID/GID `101:101` 运行，站点目录只读挂载，`/tmp` 为临时可写空间。日志有轮转限制。`/_astro/` 的带摘要资源使用长期 immutable 缓存，HTML 使用 `no-cache`，未知路径返回真实 404。服务只提供静态 `dist`，本地写作后台的编辑能力需在本机 `npm run dev` 使用。

## 构建和更新

Windows PowerShell 中执行：

```powershell
Set-Location E:\RoseKhlifa.com\blog
& .\deploy\Build.ps1
```

脚本使用 `.nvmrc` 的 Node `22.22.0`。若当前 Node 版本不同且已安装 Volta，脚本自动通过 `volta run --node 22.22.0 npm ...` 调用指定版本，不修改全局默认版本。没有 Volta 时先使用 `.nvmrc` 对应的 Node 版本。

构建脚本依次执行 `npm ci --no-fund --no-audit`、`npm run verify`、`npm run check:prod-artifacts` 和部署资源检查。`verify` 包含 Astro check、396 项上游测试和静态构建。已有依赖时可传 `-SkipInstall`。

完整构建、打包、上传、发布和公网验收：

```powershell
& .\deploy\Deploy.ps1
```

本次构建已完成时可复用 `dist`：

```powershell
& .\deploy\Deploy.ps1 -SkipBuild
```

每次自动生成新的 UTC 发布 ID，包保存在本地 `deploy\artifacts\<ID>.tar.gz`；先核对包 SHA256，再解压到独立 `releases/<ID>`，原子切换 `current` 并保留 `previous`。容器重新打开路径后等待健康检查，失败时恢复旧链接并验证旧服务。首次失败时撤销新链接并停止本项目容器。脚本不覆盖已存在的发布 ID。

每次部署的本地收据写入 `deploy\artifacts\last-deployment.json`，包含发布 ID、源码提交、包摘要、服务器路径与完成时间。`-SkipBuild` 仍检查正式域名和关键产物，但应仅用于明确完成构建的 `dist`。更新主题源码时先审查差异、保留个人内容，再重新运行完整部署。

手动构建等价命令（已切换到 Node 22.22.0 时）：

```powershell
npm.cmd ci --no-fund --no-audit
$env:SITE_URL = 'https://blog.rosekhlifa.com'
$env:ASTRO_WHONO_BASE_PATH = '/'
npm.cmd run verify
npm.cmd run check:prod-artifacts
node deploy/verify-build.mjs
```

## 查看状态和日志

```powershell
ssh root@51.83.101.143 "docker compose --project-directory /opt/rosekhlifa-blog -f /opt/rosekhlifa-blog/deploy/compose.yaml -p rosekhlifa-blog ps"
ssh root@51.83.101.143 "docker logs --tail 100 rosekhlifa-blog"
node deploy/verify-public.mjs http://51.83.101.143:18180
```

服务重启：

```powershell
ssh root@51.83.101.143 "docker compose --project-directory /opt/rosekhlifa-blog -f /opt/rosekhlifa-blog/deploy/compose.yaml -p rosekhlifa-blog restart blog"
```

服务器 Docker 已配置开机启动，容器 `restart: unless-stopped` 会在 Docker 重启后恢复。人为 `docker stop` 后该策略保持停止，需要用 Compose `up -d` 再启动。本次执行了容器重启和健康检查，没有重启整台服务器。

## 回滚

第二次成功发布后，可切换到 `previous`：

```powershell
ssh root@51.83.101.143 "bash /opt/rosekhlifa-blog/deploy/ROLLBACK.sh"
node deploy/verify-public.mjs http://51.83.101.143:18180 --skip-local-hash
```

回滚后 `current` 和 `previous` 交换，可再次执行恢复刚才版本。`--skip-local-hash` 在回滚验收时跳过与本机较新 `dist` 的首页摘要比较，仍检查公网页面、资源和正式域名。也可以指定仍保留在服务器上的发布 ID：

```powershell
ssh root@51.83.101.143 "bash /opt/rosekhlifa-blog/deploy/ROLLBACK.sh 20261019T171705Z-b6bc4f9d4845"
```

首次上线没有历史发布，因此 `previous` 尚不存在。首次版本可作为后续更新的回退点。回滚脚本验证目标发布包含非空首页，并在服务健康检查失败时恢复操作前的链接。它回滚静态站点内容；如修改了 Nginx 或 Compose 配置，配置需从版本控制中恢复后再运行 Compose `up -d`。

真实脚本已在隔离目录上验证链接切换、原始配置 SHA256 和首页正文恢复，生产 `current` 保持正式版本。`deploy/test-rollback.sh` 可在 Linux 再次创建独立副本验证；它不操作 Docker。故障注入与脚本检查证据见 `deploy/evidence/shell-tests.txt`。

本地 `deploy/evidence/site.original.env` 和 `site.config.original.mjs` 保留原始配置及其哈希证据，`deploy/DIFF_FILE.patch` 记录 `SITE_URL` 从空值改为正式域名。回滚测试只在独立副本恢复空值，正式配置保持 `https://blog.rosekhlifa.com`。

## 1Panel 反代与验收

当前 1Panel OpenResty 使用 `host` 网络。创建 `blog.rosekhlifa.com` 的反向代理时，上游填 `http://127.0.0.1:18180`，按用户选择配置 DNS 与 HTTPS。博客已按最终 HTTPS 域名构建，无需因域名接入重新构建。

已从本机通过公网 IP 实际验证：首页、`/archive/markdown-guide/`、CSS、JavaScript、图片、自托管字体、`/rss.xml`、`/archive/rss.xml`、`/essay/rss.xml`、robots 与 sitemap。首页响应 SHA256 与本地 `dist/index.html` 相同；目录跳转保持 IP 和端口；未知路径返回 404。

逐项命令、字面输出、退出状态、摘要和服务状态保存在 `deploy/VERIFICATION.txt`。完整本机构建/部署日志保存在 `deploy/artifacts/`，该目录不纳入 Git。

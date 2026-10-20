# 在线写作使用说明

写作入口：**https://blog.rosekhlifa.com/admin/**

公开博客：**https://blog.rosekhlifa.com/**

用户名为 `rosekhlifa`。随机生成的密码保存在本机 `E:\RoseKhlifa.com\blog\deploy\artifacts\online-admin-login.txt`，此文件只授予当前 Windows 用户读取权限，并被 Git 忽略。服务器原件在 `/opt/rosekhlifa-blog/admin-secrets/login.txt`，权限为 `0600`。

管理入口已接入 1Panel 的博客域名与现有 HTTPS 证书。打开 `/admin/` 后会显示普通的中文登录表单，输入原账号密码即可使用。登录会话保留 12 小时。原 IP 加端口入口保留供维护；日常写作使用域名入口。

## 写文章和上传图片

1. 登录写作入口，在「随笔」分组点击「新建文章」。
2. 填写标题、日期和网址名称（slug），编辑正文，使用编辑器工具栏上传图片或插入画廊。
3. 点击保存。草稿只保存在写作后台；准备公开时关闭草稿状态，再保存。
4. 页面右下方会显示「等待发布」「正在发布」，成功后显示「网站已更新」。通常需要十几到几十秒。刷新公开博客即可看到新内容。

修改文章、删除文章、修改主题设置同样会触发自动发布。图片文件随文章一起构建和发布，无需另外上传服务器。单张图片上限为 12 MiB，支持 AVIF、GIF、JPEG、PNG、SVG、WebP。内容列表的「更多」菜单可下载 Markdown 源文件。

## 控制文章可见性

在文章编辑器的「文章信息」中，将 **「可见性」** 设为 **「公开」** 或 **「仅自己可见」**，然后保存。新建文章和内容列表的「修改信息」也有同样的选项；历史文章默认公开。

「仅自己可见」与草稿是独立设置。私密文章可以完成写作并退出草稿状态，仍只在登录后的后台展示。文章列表会显示标记，更多操作中的「私密阅读」打开受登录保护的阅读页；文章分类列表也能按可见性筛选。

保存并等待「网站已更新」后，私密文章不会出现在公开列表、标签、搜索、RSS、sitemap、上下篇导航或公开文章详情中，公开直链返回 404。后台阅读和编辑继续可用。将可见性改回「公开」并保存后，非草稿文章恢复公开发布。

生产内容加载器会在生成产物前剔除私密文章及其 Markdown 本地附件导入。私密文章配图请使用文章编辑器上传，文件保存在文章附件目录。已经放到 `public/` 或第三方图床的文件保留各自的公开访问属性。

曾公开的文章改为私密后，当前发布版本会移除正文和专属本地附件。此前访客下载或浏览器 / CDN 已缓存的公开副本可能继续存在；需要保密的内容请在首次发布前选择「仅自己可见」。

「发布失败，文章已保存」表示源文件已经留在服务器，但本轮公开站点构建失败。可点击「查看详情」看日志；系统会重试，公开站点继续提供上一个成功版本。

## 上传首页 Hero 图片

在「主题 → 首页设置」的 Hero 图片一栏，点击 **「上传图片」**，直接选择电脑上的图片。上传完成后会自动填入地址并显示预览；点击主题设置的 **「保存」**，等待「网站已更新」即可。

Hero 图片单独保存到 `src/assets/hero-uploads/`，上传过程不会创建文章或动态，也不会自动保存表单里的其他设置。「选择已有」仍可从已上传的图库中选图，输入框也继续支持 HTTPS 图片链接。

支持 JPG、PNG、WebP、AVIF、GIF，单张最多 12 MiB、4000 万像素。上传失败或取消选图会保留原地址；重复上传同一图片复用同一文件，旧图保持可用。上传后的原图通过后台认证预览，正式发布时由 Astro 生成页面使用的优化图片。

## 上传默认作者头像

在「主题 → 内页设置 → /bits/ 页默认作者」的默认头像一栏，直接点击 **「上传图片」**。地址与预览会自动更新，点击主题设置的 **「保存」** 后发布。无需创建文章或动态，作者名保持原值。

默认头像和 Hero 使用相同的上传交互与图片校验，支持 JPG、PNG、WebP、AVIF、GIF，单张最多 12 MiB、4000 万像素。建议使用方图，也可保留其他比例的原图。默认头像存放在 `public/author/uploads/`，上传后、保存前即可通过后台的受保护预览查看；正式发布后公开页面使用 `/author/uploads/...`。

主题设置中的图片入口现在包括 Hero、默认头像、标签页图标、触摸图标四处，都可在各自位置直接上传。站点图标继续采用其原有 PNG、接近正方形和 256 KiB 的格式要求。

## 站点图标预览

标签页图标和触摸图标上传后，会直接通过后台的受保护预览显示原图，无需等待公开站点构建。点击「保存」后，公开页面才切换到新图标。两个槽位都保留「恢复默认」；上传新文件不会删除此前上传的图标，因此可在保存前比较或回到原有选择。

如果图标暂时读取失败，槽位会显示提示和重试入口。登录过期会提示重新登录，上传失败时保留原图标地址。公开网站使用带内容摘要的图片地址，保存发布后可刷新页面查看浏览器标签页图标。

## 文件和服务

| 项目 | 位置或名称 |
| --- | --- |
| 服务器权威源文件 | `/opt/rosekhlifa-blog/source` |
| 随笔 Markdown | `/opt/rosekhlifa-blog/source/src/content/essay` |
| 随笔附件 | 对应文章的 `*-assets` 目录 |
| 主题设置 | `/opt/rosekhlifa-blog/source/src/data/settings` |
| 独立构建目录 | `/opt/rosekhlifa-blog/build` |
| 自动源文件快照 | `/opt/rosekhlifa-blog/source-backups`，保留最近 8 份自动快照 |
| 发布状态和日志 | `/opt/rosekhlifa-blog/publish-state` |
| 域名管理路由 | 1Panel `/opt/1panel/www/sites/blog.rosekhlifa.com/proxy/online-admin.conf` |
| HTTPS 内部反代容器 | `rosekhlifa-blog-admin`，监听 `18181` |
| 登录服务 | `rosekhlifa-blog-auth.service`，只监听 `127.0.0.1:14322` |
| 内网编辑服务 | `rosekhlifa-blog-editor.service`，只监听 `127.0.0.1:14321` |
| 自动发布服务 | `rosekhlifa-blog-publisher.service` |
| 公开静态站点容器 | `rosekhlifa-blog`，监听 `18180` |

编辑器与发布进程使用独立的系统用户 `rosekhlifa-blog`。生产构建在独立目录进行，源文件稳定 4 秒后开始构建，通过生产产物检查才切换静态站点。已成功发布的指纹持久化保存，服务重启后不会重复发布相同内容。

写作后台和全部 API、开发模块及 WebSocket 都受同一账号认证保护，写操作额外校验请求来源。未登录访问管理页面会转到 `/admin/login/`；API 返回 `401`。网页登录使用 Secure、HttpOnly、SameSite=Strict 的签名会话 Cookie，兼容内置浏览器。登录校验记录位于独立 `session-auth` 目录；登录密码原件与证书私钥位于 `admin-secrets` 目录。

## 下载服务器源文件备份

在线编辑后，服务器上的 source 是最新文章来源。下载完整源文件备份：

```powershell
Set-Location E:\RoseKhlifa.com\blog
& .\deploy\admin\Backup-Source.ps1
```

备份保存到本地 `deploy\artifacts\server-source-时间.tar.gz`，包含文章、图片、主题代码和设置，排除依赖和构建缓存。也可以从内容列表单独下载 Markdown。

原 `Deploy.ps1` 已增加在线写作模式检查。直接用旧的本地内容发布时会停止并提示先备份、同步服务器源文件，防止覆盖在线新写的文章。维护代码时先下载并合并服务器 source，再更新服务器 source、运行依赖安装并重启编辑服务；自动发布器会构建新版本。`-AllowLocalContentReplace` 只供已核对内容的维护操作使用，它只替换公开站点，下一次在线保存仍以服务器 source 为准。

## 维护与回退

查看服务和发布状态：

```powershell
ssh root@51.83.101.143 "systemctl status rosekhlifa-blog-editor rosekhlifa-blog-publisher --no-pager"
ssh root@51.83.101.143 "cat /opt/rosekhlifa-blog/publish-state/status.json"
ssh root@51.83.101.143 "tail -n 80 /opt/rosekhlifa-blog/publish-state/latest.log"
```

下载前先停止编辑操作，可避免恰好在打包过程中保存。自动发布快照则会检测源文件是否发生变化，等待内容稳定后再发布。

公开站点回退到上一个成功版本：

```powershell
ssh root@51.83.101.143 "systemctl stop rosekhlifa-blog-publisher"
ssh root@51.83.101.143 "bash /opt/rosekhlifa-blog/deploy/ROLLBACK.sh"
```

这会保留服务器上的最新文章源文件。修正源内容后启动 `rosekhlifa-blog-publisher`，继续自动发布。

关闭在线编辑功能、保留公开页面和全部源文件：

```powershell
ssh root@51.83.101.143 "bash /opt/rosekhlifa-blog/deploy/admin/ROLLBACK.sh"
```

恢复在线编辑可在本机重新运行 `deploy\admin\Install.ps1`。安装器发现已有 source 后会保留在线文章和图片，并重新启用服务。服务和容器均配置开机启动；本次已完成重启复验。

完整功能验收脚本为 `deploy/admin/verify-online.mjs`，会创建临时验证文章、上传图片、发布并修改、核对公开站点和 RSS，再删除该临时文章。它读取本地登录文件，不输出密码。验收记录保存在 `deploy/admin/VERIFICATION.txt`。

## 域名管理配置维护

1Panel 原有的 `proxy/root.conf` 继续服务公开博客。新增 `online-admin.conf` 将管理页、API、开发模块和发布状态转到带认证的编辑入口；`online-admin-upstream.inc` 保存共同的上游设置。实时连接使用 `/admin/_hmr/`，公开首页无需承担该连接。

原始 1Panel 站点文件、根反代文件、编辑服务和认证代理配置均备份在 `/opt/rosekhlifa-blog/deploy/admin/domain/backups/20261019T175511Z-2483456`。域名整合变更的回滚命令为：

```powershell
ssh root@51.83.101.143 "bash /opt/rosekhlifa-blog/deploy/admin/domain/ROLLBACK.sh"
```

它恢复整合前的管理入口与编辑配置，公开站点和文章源文件保留。独立副本回滚验证、网页登录、模块加载和真实域名发布的记录见 `deploy/admin/domain/VERIFICATION.txt`。

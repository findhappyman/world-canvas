# 无界画布 · World Canvas

全世界共用一张无限大的纸。打开网页，你会落在一块还没人画过的空白处，可以自由地画；拖动画布能看到别人的作品，也能实时看到其他人的光标和正在画的笔迹。

在线体验：https://canvas.findhappyman.com

## 功能

- 无限画布：拖动平移、滚轮 / 双指缩放，网址里的 `#x,y,缩放` 就是位置，可以直接分享
- 自由笔刷：多种颜色和粗细，可撤销自己的笔画
- 实时在场：看到其他人的光标、名字和正在画的线
- 进来就有空地：新访客自动落在空白区域；「找空地」随时换一块
- 防破坏：按 IP 限速、限墨量、缩得太小不能画、举报后自动隐藏并禁画 24 小时
- 管理入口：`?admin` 输入口令后，可查看被处罚的人并一键恢复

## 技术结构

没有构建步骤，也没有前端框架：

| 文件 | 作用 |
|------|------|
| `public/index.html` | 全部前端：Canvas 2D 渲染、交互、WebSocket 客户端 |
| `src/index.js` | Cloudflare Worker + 一个 Durable Object（`World`），SQLite 存储笔画，WebSocket 广播 |
| `wrangler.toml` | Worker 配置 |

世界被切成 2048×2048 的区块。客户端只加载视野附近的区块，服务器也只把消息转发给视野相交的连接，所以画布再大，单个用户的流量也不会跟着变大。

## 本地运行

需要 Node.js 18+。

```bash
npm install
npm run dev        # http://localhost:8787
```

想在本地试管理入口，新建 `.dev.vars`（已被 git 忽略）：

```
ADMIN_KEY=随便一个本地口令
```

然后打开 http://localhost:8787/?admin 。

## 部署到你自己的 Cloudflare 账号

1. 删掉 `wrangler.toml` 末尾的 `[[routes]]`（那是本站的自定义域名），或者换成你自己的域名
2. `npx wrangler login`
3. `npx wrangler secret put ADMIN_KEY`，设置管理员口令
4. `npm run deploy`

## 参与贡献

欢迎提 Issue 和 PR。几点约定：

- 保持「无构建」：前端只有一个 HTML 文件，不引入打包工具
- 改动客户端和服务端之间的消息格式时，两边一起改，并在 PR 里说明
- 提交前请在本地开两个浏览器窗口试一下：画、撤销、看到对方光标
- 和防破坏相关的改动，请说明它会怎样影响正常作画的人

## License

MIT

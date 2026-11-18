#!/bin/sh
# 本地启动：http://localhost:8787
# 默认不连 Cloudflare 的远程 AI（需要稳定联网），AI 画笔用 .dev.vars 里的 AI_MOCK=1 假数据测试。
# 想在本地用真的 AI：AI_REMOTE=1 npm run dev
cd "$(dirname "$0")" || exit 1
WR=node_modules/.bin/wrangler
[ -x "$WR" ] || { echo "先运行 npm install"; exit 1; }
# Wrangler 启动时会去 npm 官方源查新版本，走代理时这个请求会一直挂着导致起不来。
# 这里预写它的检查缓存，让它跳过联网。
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const d=path.join(os.tmpdir(),"update-check");
fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(path.join(d,"wrangler-latest.json"),JSON.stringify({latest:"0.0.0",lastUpdate:Date.now()}));
'
CFG=wrangler.toml
if [ -z "$AI_REMOTE" ]; then
  CFG=wrangler.local.toml
  sed '/^\[ai\]/,/^$/d' wrangler.toml > "$CFG"
fi
exec "$WR" dev --port 8787 -c "$CFG"

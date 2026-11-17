#!/bin/sh
# 本地启动：http://localhost:8787
# Wrangler 启动时会去 npm 官方源查新版本，走代理时这个请求会一直挂着导致起不来。
# 这里预写它的检查缓存，让它跳过联网。
cd "$(dirname "$0")" || exit 1
WR=node_modules/.bin/wrangler
[ -x "$WR" ] || { echo "先运行 npm install"; exit 1; }
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const d=path.join(os.tmpdir(),"update-check");
fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(path.join(d,"wrangler-latest.json"),JSON.stringify({latest:"0.0.0",lastUpdate:Date.now()}));
'
exec "$WR" dev --port 8787

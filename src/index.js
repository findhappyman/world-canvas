// 无界画布 —— 实时后端
// 一个 Durable Object 承载整个世界：SQLite 按区块存笔画，WebSocket 按视野转发实时事件。
import { DurableObject } from "cloudflare:workers";

const CHUNK = 2048; // 世界单位；须与前端一致
const COLOR = /^#[0-9a-f]{6}$/;
const PEER_COLORS = ["#e5484d", "#f76b15", "#30a46c", "#0090ff", "#8e4ec6", "#e93d82", "#12a594", "#6e56cf"];
const MAX_MSG = 200_000;

// ---- 防破坏参数 ----
const MAX_W = 66;            // 最粗笔画（世界单位）≈ 最粗画笔在 25% 缩放下的宽度；再缩小就不能画
const MAX_CONN_PER_IP = 8;
const MSG_PER_SEC = 150;     // 单连接每秒消息上限
const INK_CAP = 1_500_000;   // 墨水桶容量（长度×粗细，世界单位²）
const INK_RATE = 30_000;     // 每秒回墨
const N_CAP = 30;            // 笔画数桶
const N_RATE = 6;            // 每秒可画笔数
const DAY = 86_400_000;
const REPORTS_PER_HOUR = 10;
// 新人保护期：刚来的人这段时间里不能把笔画大面积压在别人的画上（画在旁边、添一小笔都可以）
const NEW_MS = 5 * 60_000;
const CELL = 16;             // 判断重叠用的网格边长（世界单位）
const OVER_RATIO = 0.3;      // 一笔里超过这个比例压在别人画上……
const OVER_MIN = 3;          // ……且至少压住这么多格，才算覆盖

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      return env.WORLD.get(env.WORLD.idFromName("world")).fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
};

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const r2 = (v) => Math.round(v * 100) / 100;

function cleanPts(p, max) {
  if (!Array.isArray(p) || p.length < 2 || p.length > max || p.length % 2) return null;
  const out = new Array(p.length);
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9) return null;
    out[i] = r2(v);
  }
  return out;
}

function bbox(p, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export class World extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS strokes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL, c TEXT NOT NULL, w REAL NOT NULL, p TEXT NOT NULL,
        x0 REAL, y0 REAL, x1 REAL, y1 REAL, ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS chunks (
        cx INTEGER NOT NULL, cy INTEGER NOT NULL, sid INTEGER NOT NULL,
        PRIMARY KEY (cx, cy, sid)
      ) WITHOUT ROWID;
    `);
    const cols = this.sql.exec("PRAGMA table_info(strokes)").toArray().map((r) => r.name);
    if (!cols.includes("iph")) this.sql.exec("ALTER TABLE strokes ADD COLUMN iph TEXT");
    if (!cols.includes("hidden")) this.sql.exec("ALTER TABLE strokes ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS bans (who TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (
        target TEXT NOT NULL, reporter TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY (target, reporter)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS strokes_ts ON strokes (ts);
      CREATE TABLE IF NOT EXISTS blocked (cx INTEGER NOT NULL, cy INTEGER NOT NULL, n INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (cx, cy)) WITHOUT ROWID;
    `);
    // 每个 IP 哈希第一次出现的时间。首次建表时用已有笔画回填，老用户不会被当成新人
    const hadPeople = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'people'").toArray().length;
    if (!hadPeople) {
      this.sql.exec("CREATE TABLE people (iph TEXT PRIMARY KEY, first INTEGER NOT NULL) WITHOUT ROWID");
      this.sql.exec("INSERT OR IGNORE INTO people (iph, first) SELECT iph, MIN(ts) FROM strokes WHERE iph IS NOT NULL GROUP BY iph");
    }
    let salt = this.sql.exec("SELECT v FROM kv WHERE k = 'salt'").toArray()[0]?.v;
    if (!salt) {
      salt = crypto.randomUUID();
      this.sql.exec("INSERT INTO kv (k, v) VALUES ('salt', ?)", salt);
    }
    this.salt = salt;
    this.buckets = new Map(); // iph -> {ink, n, t}
    this.flood = new WeakMap(); // ws -> {t, c}
    this.given = new Map(); // "cx,cy" -> 发放时间，刚分给别人的空地先别再给
    // 休眠唤醒后从附件恢复连接状态
    this.meta = new Map();
    for (const ws of ctx.getWebSockets()) {
      const m = ws.deserializeAttachment();
      if (m) this.meta.set(ws, m);
    }
  }

  async fetch(req) {
    // 不存原始 IP，只存加盐哈希，用于限速、举报计数和封禁
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.salt + ip));
    const iph = [...new Uint8Array(dig)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    let same = 0;
    for (const m of this.meta.values()) if (m.iph === iph) same++;
    if (same >= MAX_CONN_PER_IP) return new Response("too many connections", { status: 429 });
    this.sql.exec("INSERT OR IGNORE INTO people (iph, first) VALUES (?, ?)", iph, Date.now());
    const first = this.sql.exec("SELECT first FROM people WHERE iph = ?", iph).one().first;
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    const m = {
      id: crypto.randomUUID().slice(0, 8),
      uid: null,
      n: "",
      h: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
      view: null,
      x: 0, y: 0, pos: false,
      iph, first, ban: this.banUntil(iph), admin: false, tries: 0,
    };
    ws.serializeAttachment(m);
    this.meta.set(ws, m);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 只发给视野与 box 相交的连接
  relay(str, box, except, always) {
    for (const [ws, m] of this.meta) {
      if (ws === except) continue;
      if (ws !== always) {
        const v = m.view;
        if (!v || box[0] > v[2] || box[2] < v[0] || box[1] > v[3] || box[3] < v[1]) continue;
      }
      try { ws.send(str); } catch {}
    }
  }

  all(str) {
    for (const ws of this.meta.keys()) {
      try { ws.send(str); } catch {}
    }
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    const me = this.meta.get(ws);
    if (!me) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    // 消息洪水保护
    const now = Date.now();
    let f = this.flood.get(ws);
    if (!f || now - f.t > 1000) this.flood.set(ws, (f = { t: now, c: 0 }));
    if (++f.c > MSG_PER_SEC) return;

    switch (m.t) {
      case "hello": {
        if (typeof m.uid === "string" && m.uid.length >= 8 && m.uid.length <= 64) me.uid = m.uid;
        me.n = String(m.name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 16) || "旅人";
        ws.serializeAttachment(me);
        const fresh = Math.max(0, (me.first ?? 0) + NEW_MS - now);
        ws.send(JSON.stringify({ t: "welcome", id: me.id, h: me.h, n: this.meta.size, fresh }));
        this.all(JSON.stringify({ t: "n", n: this.meta.size }));
        break;
      }
      case "view": {
        const r = m.r;
        if (!Array.isArray(r) || r.length !== 4 || r.some((v) => num(v, -1e9, 1e9) === null)) return;
        me.view = r;
        ws.serializeAttachment(me);
        break;
      }
      case "load": {
        if (!Array.isArray(m.k) || m.k.length > 64) return;
        this.load(ws, m.k);
        break;
      }
      case "cur": {
        const x = num(m.x, -1e9, 1e9), y = num(m.y, -1e9, 1e9);
        if (x === null || y === null) return;
        me.x = x; me.y = y; me.pos = true;
        this.relay(JSON.stringify({ t: "cur", id: me.id, x, y, n: me.n, h: me.h }), [x, y, x, y], ws);
        break;
      }
      case "draw": {
        const p = cleanPts(m.p, 800);
        const w = num(m.w, 0.2, MAX_W);
        if (!p || w === null || !COLOR.test(m.c) || !this.sidOk(m.sid)) return;
        if (me.ban > now) return;
        this.relay(JSON.stringify({ t: "draw", from: me.id, sid: m.sid, c: m.c, w, p }), bbox(p, w), ws);
        break;
      }
      case "cancel": {
        if (!this.sidOk(m.sid)) return;
        const s = JSON.stringify({ t: "cancel", from: me.id, sid: m.sid });
        for (const [o, om] of this.meta) if (o !== ws && om.view) { try { o.send(s); } catch {} }
        break;
      }
      case "end": {
        if (!this.sidOk(m.sid)) return;
        const why = this.save(ws, me, m);
        if (why) {
          const left = why === "new" ? Math.ceil(((me.first ?? 0) + NEW_MS - now) / 1000) : 0;
          ws.send(JSON.stringify({ t: "rej", sid: m.sid, why, left }));
          // 别人已经看到了这笔的实时预览，要撤掉
          const s = JSON.stringify({ t: "cancel", from: me.id, sid: m.sid });
          for (const [o, om] of this.meta) if (o !== ws && om.view) { try { o.send(s); } catch {} }
        }
        break;
      }
      case "undo": {
        const id = num(m.id, 1, Number.MAX_SAFE_INTEGER);
        if (id === null || !me.uid) return;
        const row = this.sql.exec("SELECT owner, x0, y0, x1, y1 FROM strokes WHERE id = ?", id).toArray()[0];
        if (!row || row.owner !== me.uid) return;
        this.sql.exec("DELETE FROM chunks WHERE sid = ?", id);
        this.sql.exec("DELETE FROM strokes WHERE id = ?", id);
        this.relay(JSON.stringify({ t: "del", id }), [row.x0, row.y0, row.x1, row.y1], null, ws);
        break;
      }
      case "report": {
        const id = num(m.id, 1, Number.MAX_SAFE_INTEGER);
        if (id === null || !me.uid) return;
        const row = this.sql.exec("SELECT owner, iph FROM strokes WHERE id = ? AND hidden = 0", id).toArray()[0];
        if (!row) return;
        const reply = (o) => ws.send(JSON.stringify({ t: "reported", ...o }));
        if (row.owner === me.uid || row.iph === me.iph) return reply({ ok: false, why: "self" });
        const recent = this.sql.exec("SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND ts > ?", me.iph, now - 3_600_000).one().n;
        if (recent >= REPORTS_PER_HOUR) return reply({ ok: false, why: "rate" });
        const target = row.iph || "u:" + row.owner;
        this.sql.exec("INSERT OR REPLACE INTO reports (target, reporter, ts) VALUES (?,?,?)", target, me.iph, now);
        const n = this.sql.exec("SELECT COUNT(*) AS n FROM reports WHERE target = ? AND ts > ?", target, now - DAY).one().n;
        const ips = new Set();
        for (const om of this.meta.values()) ips.add(om.iph);
        const need = ips.size <= 4 ? 2 : 3; // 人少时两人举报即生效
        if (n >= need) {
          this.sanction(target);
          reply({ ok: true, done: true });
        } else reply({ ok: true, n, need });
        break;
      }
      case "admin": {
        const key = this.env.ADMIN_KEY;
        if (me.tries >= 5) return;
        me.tries++;
        me.admin = !!key && typeof m.key === "string" && m.key === key;
        ws.serializeAttachment(me);
        ws.send(JSON.stringify({ t: "admin", ok: me.admin }));
        break;
      }
      case "mod": {
        if (!me.admin) return;
        const id = num(m.id, 1, Number.MAX_SAFE_INTEGER);
        if (id === null) return;
        const row = this.sql.exec("SELECT owner, iph, x0, y0, x1, y1 FROM strokes WHERE id = ?", id).toArray()[0];
        if (!row) return;
        if (m.all) this.sanction(row.iph || "u:" + row.owner);
        else {
          this.sql.exec("DELETE FROM chunks WHERE sid = ?", id);
          this.sql.exec("DELETE FROM strokes WHERE id = ?", id);
          this.relay(JSON.stringify({ t: "del", id }), [row.x0, row.y0, row.x1, row.y1], null, ws);
        }
        break;
      }
      case "modlist": {
        if (me.admin) this.sendModList(ws);
        break;
      }
      case "recent": {
        if (me.admin) this.sendRecent(ws);
        break;
      }
      case "peek": {
        // 管理员预览某个被处罚者的隐藏笔画
        if (!me.admin || typeof m.who !== "string" || m.who.length > 80) return;
        const parts = [];
        for (const r of this.hiddenOf(m.who, "id, c, w, p", 800)) parts.push(`{"id":${r.id},"c":"${r.c}","w":${r.w},"p":${r.p}}`);
        ws.send(`{"t":"ghost","who":${JSON.stringify(m.who)},"s":[${parts.join(",")}]}`);
        break;
      }
      case "restore": {
        if (!me.admin || typeof m.who !== "string" || m.who.length > 80) return;
        const who = m.who;
        if (who.startsWith("u:")) this.sql.exec("UPDATE strokes SET hidden = 0 WHERE hidden = 1 AND iph IS NULL AND owner = ?", who.slice(2));
        else this.sql.exec("UPDATE strokes SET hidden = 0 WHERE hidden = 1 AND iph = ?", who);
        this.sql.exec("DELETE FROM bans WHERE who = ?", who);
        this.sql.exec("DELETE FROM reports WHERE target = ?", who);
        for (const [o, om] of this.meta) {
          if (who.startsWith("u:") ? om.uid === who.slice(2) : om.iph === who) {
            om.ban = 0;
            try { o.serializeAttachment(om); o.send('{"t":"unbanned"}'); } catch {}
          }
        }
        this.all('{"t":"reload"}');
        this.sendModList(ws);
        break;
      }
      case "who": {
        const list = [];
        for (const [o, om] of this.meta) {
          if (o === ws || !om.pos) continue;
          list.push({ id: om.id, n: om.n, h: om.h, x: om.x, y: om.y });
          if (list.length >= 50) break;
        }
        ws.send(JSON.stringify({ t: "who", list }));
        break;
      }
      case "empty": {
        let x = num(m.x, -1e9, 1e9), y = num(m.y, -1e9, 1e9);
        if (x === null || y === null) [x, y] = this.entrySeed();
        const spot = this.findEmpty(x, y);
        ws.send(JSON.stringify({ t: "empty", entry: !!m.entry, ...spot }));
        break;
      }
    }
  }

  sidOk(sid) {
    return typeof sid === "string" && /^[a-z0-9]{1,16}$/.test(sid);
  }

  hiddenOf(who, cols, limit) {
    return who.startsWith("u:")
      ? this.sql.exec(`SELECT ${cols} FROM strokes WHERE hidden = 1 AND iph IS NULL AND owner = ? ORDER BY id LIMIT ?`, who.slice(2), limit)
      : this.sql.exec(`SELECT ${cols} FROM strokes WHERE hidden = 1 AND iph = ? ORDER BY id LIMIT ?`, who, limit);
  }

  // 所有被处罚者：有隐藏笔画的，或仍在禁画期内的
  sendModList(ws) {
    const now = Date.now(), map = new Map();
    const rows = this.sql.exec(`
      SELECT COALESCE(iph, 'u:' || owner) AS who, COUNT(*) AS n, MAX(ts) AS ts,
             MIN(x0) AS x0, MIN(y0) AS y0, MAX(x1) AS x1, MAX(y1) AS y1
      FROM strokes WHERE hidden = 1 GROUP BY who ORDER BY ts DESC LIMIT 100`);
    for (const r of rows) map.set(r.who, { who: r.who, n: r.n, ts: r.ts, x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, span: Math.max(r.x1 - r.x0, r.y1 - r.y0), until: 0 });
    for (const b of this.sql.exec("SELECT who, until FROM bans WHERE until > ?", now)) {
      const e = map.get(b.who);
      if (e) e.until = b.until;
      else map.set(b.who, { who: b.who, n: 0, ts: 0, x: 0, y: 0, span: 0, until: b.until });
    }
    ws.send(JSON.stringify({ t: "modlist", now, list: [...map.values()] }));
  }

  // 最近 24 小时有人画过的区块，按最后一笔时间倒序，附带被拦下的新人覆盖次数
  sendRecent(ws) {
    const now = Date.now();
    const list = [];
    const rows = this.sql.exec(`
      SELECT k.cx, k.cy, COUNT(*) AS n, COUNT(DISTINCT COALESCE(s.iph, s.owner)) AS people, MAX(s.ts) AS ts
      FROM strokes s JOIN chunks k ON k.sid = s.id
      WHERE s.ts > ? AND s.hidden = 0
      GROUP BY k.cx, k.cy ORDER BY ts DESC LIMIT 80`, now - DAY);
    this.sql.exec("DELETE FROM blocked WHERE ts < ?", now - DAY);
    const blocked = new Map();
    for (const r of this.sql.exec("SELECT cx, cy, n, ts FROM blocked")) blocked.set(r.cx + "," + r.cy, r);
    for (const r of rows) {
      const k = r.cx + "," + r.cy;
      const b = blocked.get(k);
      blocked.delete(k);
      list.push({ x: (r.cx + 0.5) * CHUNK, y: (r.cy + 0.5) * CHUNK, n: r.n, people: r.people, ts: Math.max(r.ts, b?.ts ?? 0), blocked: b ? b.n : 0 });
    }
    // 只有被拦、没有新画的区块也列出来
    for (const b of blocked.values()) {
      list.push({ x: (b.cx + 0.5) * CHUNK, y: (b.cy + 0.5) * CHUNK, n: 0, people: 0, ts: b.ts, blocked: b.n });
    }
    list.sort((a, b) => b.ts - a.ts);
    ws.send(JSON.stringify({ t: "recent", now, list: list.slice(0, 80) }));
  }

  // 新人这一笔是否大面积压在别人（非本人、未隐藏）的画上
  covers(p, w, b, me) {
    const cells = new Set();
    const mark = (set, x0, y0, x1, y1) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        set.add(Math.floor((x0 + (x1 - x0) * t) / CELL) + "," + Math.floor((y0 + (y1 - y0) * t) / CELL));
      }
    };
    for (let i = 2; i < p.length; i += 2) mark(cells, p[i - 2], p[i - 1], p[i], p[i + 1]);
    if (p.length === 2) mark(cells, p[0], p[1], p[0], p[1]);
    const pad = MAX_W;
    const [qx0, qy0, qx1, qy1] = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    const rows = this.sql.exec(`
      SELECT DISTINCT s.id, s.w, s.p FROM chunks k JOIN strokes s ON s.id = k.sid
      WHERE k.cx BETWEEN ? AND ? AND k.cy BETWEEN ? AND ?
        AND s.hidden = 0 AND s.owner != ? AND (s.iph IS NULL OR s.iph != ?)
        AND s.x1 >= ? AND s.x0 <= ? AND s.y1 >= ? AND s.y0 <= ?
      LIMIT 400`,
      Math.floor(qx0 / CHUNK), Math.floor(qx1 / CHUNK), Math.floor(qy0 / CHUNK), Math.floor(qy1 / CHUNK),
      me.uid, me.iph, qx0, qx1, qy0, qy1);
    const other = new Set();
    let maxW = 0;
    for (const r of rows) {
      let q;
      try { q = JSON.parse(r.p); } catch { continue; }
      maxW = Math.max(maxW, r.w);
      for (let i = 2; i < q.length; i += 2) {
        // 只取落在新笔画附近的线段
        const sx0 = Math.min(q[i - 2], q[i]), sx1 = Math.max(q[i - 2], q[i]);
        const sy0 = Math.min(q[i - 1], q[i + 1]), sy1 = Math.max(q[i - 1], q[i + 1]);
        if (sx1 < qx0 || sx0 > qx1 || sy1 < qy0 || sy0 > qy1) continue;
        mark(other, q[i - 2], q[i - 1], q[i], q[i + 1]);
      }
      if (q.length === 2) mark(other, q[0], q[1], q[0], q[1]);
    }
    if (!other.size) return false;
    // 两笔的中心线距离小于两者半宽之和，就算压住了
    const R = Math.ceil((w / 2 + maxW / 2) / CELL);
    let hit = 0;
    for (const c of cells) {
      const [gx, gy] = c.split(",").map(Number);
      let found = false;
      for (let dx = -R; dx <= R && !found; dx++)
        for (let dy = -R; dy <= R && !found; dy++)
          if (dx * dx + dy * dy <= R * R && other.has(gx + dx + "," + (gy + dy))) found = true;
      if (found) hit++;
    }
    return hit >= OVER_MIN && hit / cells.size > OVER_RATIO;
  }

  banUntil(who) {
    return this.sql.exec("SELECT until FROM bans WHERE who = ?", who).toArray()[0]?.until ?? 0;
  }

  // 隐藏目标近 24 小时的笔画并禁画 24 小时（笔画只是隐藏，数据还在）
  sanction(target) {
    const now = Date.now(), until = now + DAY;
    const byUid = target.startsWith("u:");
    if (byUid) this.sql.exec("UPDATE strokes SET hidden = 1 WHERE owner = ? AND ts > ?", target.slice(2), now - DAY);
    else this.sql.exec("UPDATE strokes SET hidden = 1 WHERE iph = ? AND ts > ?", target, now - DAY);
    this.sql.exec("INSERT OR REPLACE INTO bans (who, until) VALUES (?,?)", target, until);
    this.sql.exec("DELETE FROM reports WHERE target = ?", target);
    this.sql.exec("DELETE FROM bans WHERE until < ?", now);
    for (const [ws, m] of this.meta) {
      if (byUid ? m.uid === target.slice(2) : m.iph === target) {
        m.ban = until;
        try { ws.serializeAttachment(m); ws.send('{"t":"banned"}'); } catch {}
      }
    }
    this.all('{"t":"reload"}');
  }

  // 令牌桶：按 IP 哈希限制笔画数量和覆盖面积
  spend(iph, ink) {
    const now = Date.now();
    let b = this.buckets.get(iph);
    if (!b) {
      if (this.buckets.size > 5000) this.buckets.clear();
      this.buckets.set(iph, (b = { ink: INK_CAP, n: N_CAP, t: now }));
    }
    const dt = (now - b.t) / 1000;
    b.t = now;
    b.ink = Math.min(INK_CAP, b.ink + dt * INK_RATE);
    b.n = Math.min(N_CAP, b.n + dt * N_RATE);
    if (b.n < 1 || b.ink < ink) return false;
    b.n -= 1;
    b.ink -= ink;
    return true;
  }

  // 成功返回 null，否则返回拒绝原因
  save(ws, me, m) {
    if (!me.uid || !COLOR.test(m.c)) return "bad";
    const w = num(m.w, 0.2, MAX_W);
    const p = cleanPts(m.p, 4000);
    if (w === null || !p || p.length < 4) return "bad";
    if (me.ban > Date.now() || this.banUntil("u:" + me.uid) > Date.now()) return "ban";
    let len = 0;
    for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (!this.spend(me.iph, Math.max(len, w) * w)) return "ink";
    const b = bbox(p, w / 2);
    const cx0 = Math.floor(b[0] / CHUNK), cy0 = Math.floor(b[1] / CHUNK);
    const cx1 = Math.floor(b[2] / CHUNK), cy1 = Math.floor(b[3] / CHUNK);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 64) return "bad";
    if (!me.admin && (me.first ?? 0) + NEW_MS > Date.now() && this.covers(p, w, b, me)) {
      // 记下被拦的位置和次数，给管理员巡查用
      const now = Date.now();
      this.sql.exec(
        "INSERT INTO blocked (cx, cy, n, ts) VALUES (?, ?, 1, ?) ON CONFLICT (cx, cy) DO UPDATE SET n = CASE WHEN ts < ? THEN 1 ELSE n + 1 END, ts = excluded.ts",
        Math.floor((b[0] + b[2]) / 2 / CHUNK), Math.floor((b[1] + b[3]) / 2 / CHUNK), now, now - DAY
      );
      return "new";
    }
    const pj = JSON.stringify(p);
    const id = this.sql
      .exec(
        "INSERT INTO strokes (owner, c, w, p, x0, y0, x1, y1, ts, iph) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id",
        me.uid, m.c, w, pj, b[0], b[1], b[2], b[3], Date.now(), me.iph
      )
      .one().id;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        this.sql.exec("INSERT OR IGNORE INTO chunks (cx, cy, sid) VALUES (?,?,?)", cx, cy, id);
      }
    }
    const out = `{"t":"stroke","from":"${me.id}","sid":"${m.sid}","s":{"id":${id},"c":"${m.c}","w":${w},"p":${pj}}}`;
    this.relay(out, b, null, ws);
    return null;
  }

  load(ws, keys) {
    const seen = new Set();
    let parts = [];
    let size = 0;
    const flush = () => {
      if (!parts.length) return;
      ws.send(`{"t":"strokes","s":[${parts.join(",")}]}`);
      parts = [];
      size = 0;
    };
    for (const k of keys) {
      if (!Array.isArray(k) || !Number.isInteger(k[0]) || !Number.isInteger(k[1])) continue;
      const rows = this.sql.exec(
        "SELECT s.id, s.c, s.w, s.p FROM chunks k JOIN strokes s ON s.id = k.sid WHERE k.cx = ? AND k.cy = ? AND s.hidden = 0",
        k[0], k[1]
      );
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const s = `{"id":${r.id},"c":"${r.c}","w":${r.w},"p":${r.p}}`;
        parts.push(s);
        size += s.length;
        if (size > 400_000) flush();
      }
    }
    flush();
  }

  // 新人进来时从哪儿开始找空地：随机挑一笔最近的画，让人落在别人旁边；世界还空着就随便挑一处
  entrySeed() {
    const rows = [...this.sql.exec(
      "SELECT x0, y0, x1, y1 FROM strokes WHERE hidden = 0 ORDER BY ts DESC LIMIT 300"
    )];
    if (rows.length) {
      const r = rows[Math.floor(Math.random() * rows.length)];
      return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
    }
    const span = 50 * CHUNK;
    return [(Math.random() * 2 - 1) * span, (Math.random() * 2 - 1) * span];
  }

  // 在 (x,y) 附近找一块没人画过的区块，优先四周也空的
  findEmpty(x, y) {
    const cx0 = Math.floor(x / CHUNK), cy0 = Math.floor(y / CHUNK);
    const now = Date.now();
    for (const [k, t] of this.given) if (now - t > 10 * 60e3) this.given.delete(k);
    const pick = (cx, cy) => {
      this.given.set(cx + "," + cy, now);
      return { x: (cx + 0.5) * CHUNK, y: (cy + 0.5) * CHUNK };
    };
    for (const R of [6, 16, 40]) {
      const used = new Set(this.given.keys());
      const rows = this.sql.exec(
        "SELECT DISTINCT cx, cy FROM chunks WHERE cx BETWEEN ? AND ? AND cy BETWEEN ? AND ?",
        cx0 - R - 1, cx0 + R + 1, cy0 - R - 1, cy0 + R + 1
      );
      for (const r of rows) used.add(r.cx + "," + r.cy);
      let best = [], bestScore = Infinity;
      for (let dx = -R; dx <= R; dx++) {
        for (let dy = -R; dy <= R; dy++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (d === 0) continue;
          const cx = cx0 + dx, cy = cy0 + dy;
          if (used.has(cx + "," + cy)) continue;
          let crowded = 0;
          for (let ax = -1; ax <= 1; ax++)
            for (let ay = -1; ay <= 1; ay++)
              if (used.has(cx + ax + "," + (cy + ay))) crowded = 1;
          const score = d + crowded * 1000;
          if (score < bestScore) { bestScore = score; best = [[cx, cy]]; }
          else if (score === bestScore) best.push([cx, cy]);
        }
      }
      if (best.length && (bestScore < 1000 || R === 40)) {
        const [cx, cy] = best[Math.floor(Math.random() * best.length)];
        return pick(cx, cy);
      }
    }
    // 极端情况：附近全满，往外跳远一点
    return pick(cx0 + 60 + Math.floor(Math.random() * 20), cy0);
  }

  bye(ws) {
    const m = this.meta.get(ws);
    if (!m) return;
    this.meta.delete(ws);
    this.all(JSON.stringify({ t: "leave", id: m.id }));
    this.all(JSON.stringify({ t: "n", n: this.meta.size }));
  }

  webSocketClose(ws, code) {
    this.bye(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {}
  }

  webSocketError(ws) {
    this.bye(ws);
  }
}

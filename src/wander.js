// 住在画布里的 AI 画家「小游」：每隔一阵子醒来，走到某处看看，想一想，在旁边的空白处画一幅小画。
// 用 Durable Object 的 alarm 定时唤醒；没人等它，所以模型慢一点也没关系。
// 每一步都广播给所有人，「···」菜单里可以打开面板看它在想什么、画过什么。
import { generate, DEFAULT_MODEL } from "./ai.js";

const CHUNK = 2048;
const DAY = 86_400_000;
const LOOK = 3000;          // 一眼能看多大一块（世界单位，正方形边长）
const GRID = 32;            // 给模型看的草图网格
const UID = "wander:xiaoyou";
const ANY = { uid: "\u0000", iph: "\u0000" }; // 判断空地时，谁的画都算（包括它自己的）

const r2 = (v) => Math.round(v * 100) / 100;
const clean = (s, n) => (typeof s === "string" ? s.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把颜色归到一个字母，草图里用
function colorChar(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 0.15) return "k";
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 340) return l > 0.72 ? "w" : "r";
  if (h < 42) return l < 0.38 ? "n" : "o";
  if (h < 70) return "y";
  if (h < 165) return "g";
  if (h < 200) return "c";
  if (h < 255) return "b";
  if (h < 295) return "p";
  return "w";
}

const MIND = `You are 小游 (Xiao You), a gentle, curious AI painter who lives on an infinite shared canvas where people from all over the world doodle together. Nobody controls you. Every so often you wake up, wander somewhere, look around, and add one small drawing.

What you add should respond to what you see: keep a lonely doodle company, continue a scene, answer a greeting, give a drawing a small friend, or, in empty space, draw whatever your mood suggests. Be warm and playful. Never mock anyone's drawing. You can never draw over others: your drawing goes into a blank square right beside what you saw.

You will get:
- where you are and why you came,
- a sketch map of the area: a ${GRID}x${GRID} grid, one character per cell. "." is empty paper. Letters are the main color of the ink in that cell: r red, o orange, y yellow, n brown, g green, c cyan, b blue, p purple, w pink, k black or gray,
- a list of the drawings you can see, with their position on the grid,
- your recent diary.

Reply with one JSON object and nothing else:
{"see":"中文，一句话说你看到了什么","thought":"中文，一两句此刻的想法，第一人称，真诚可爱，不要太长","draw":"what you will draw, concrete and simple, in English, at most 20 words","title":"中文短标题，最多 10 个字","side":"right|left|below|above"}

"side" says where your drawing goes relative to the drawing you came to visit. Pick the side with the most empty paper on the map. Do not draw words unless you are answering words someone wrote. Never write URLs, contacts or ads.`;

export class Wanderer {
  constructor(world) {
    this.w = world;
    this.sql = world.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS wander_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, why TEXT, kind TEXT,
        x REAL, y REAL, s REAL, see TEXT, thought TEXT, title TEXT, draw TEXT, g TEXT, n INTEGER, ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS gtitle (g TEXT PRIMARY KEY, t TEXT NOT NULL, ts INTEGER NOT NULL);
    `);
    this.me = { id: "wander", uid: UID, iph: null, n: this.name(), h: "#7b61ff", admin: false };
    this.state = { st: "rest", next: 0 };
    this.running = false;
  }

  name() { return clean(this.w.env.WANDER_NAME, 12) || "小游（AI）"; }
  on() { return this.w.env.WANDER === "1"; }
  kv(k, v) {
    if (v === undefined) return this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v;
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, String(v));
  }
  paused() { return this.kv("wander_pause") === "1"; }

  // 构造时调用：开着却没有闹钟就排一个
  async boot() {
    const next = Number(this.kv("wander_next")) || 0;
    this.state.next = next;
    const pos = this.kv("wander_pos");
    if (pos) { const [x, y] = pos.split(",").map(Number); this.state.x = x; this.state.y = y; }
    if (!this.on()) return;
    const a = await this.w.ctx.storage.getAlarm();
    if (!a) await this.schedule(60_000);
  }

  async schedule(ms) {
    if (ms === undefined) {
      const someone = this.w.online() > 0;
      const min = Number(someone ? this.w.env.WANDER_EVERY : this.w.env.WANDER_IDLE) || (someone ? 20 : 120);
      ms = min * 60_000 * (0.8 + Math.random() * 0.4);
    }
    const next = Date.now() + ms;
    this.state.next = next;
    this.kv("wander_next", next);
    await this.w.ctx.storage.setAlarm(next);
  }

  // 发给所有人当前状态（很小，而且只在换阶段时发）
  set(patch) {
    Object.assign(this.state, patch);
    this.w.all(JSON.stringify({ t: "wst", s: this.public() }));
  }
  public() {
    const s = this.state;
    return { st: s.st, x: s.x, y: s.y, kind: s.kind, to: s.to, see: s.see, thought: s.thought, title: s.title, next: s.next, t0: s.t0,
      box: s.box, n: this.me.n, h: this.me.h, on: this.on(), paused: this.paused() };
  }

  cursor(x, y) {
    this.state.x = x; this.state.y = y;
    const m = this.me;
    this.w.relay(JSON.stringify({ t: "cur", id: m.id, x: r2(x), y: r2(y), n: m.n, h: m.h }), [x, y, x, y], null, null);
  }

  // 闹钟响了
  async tick(force) {
    if (this.running) return;
    this.running = true;
    try {
      if (force || (this.on() && !this.paused())) await this.walk();
    } catch (e) {
      console.error("wander failed", e?.stack ?? e);
      this.set({ st: "rest" });
    } finally {
      this.running = false;
      if (this.on()) { await this.schedule(); this.set({}); } // 告诉大家下次什么时候出门
    }
  }

  async walk() {
    const w = this.w, env = w.env, now = Date.now();
    if (!env.AI && env.AI_MOCK !== "1") return;
    if (w.banUntil("u:" + UID) > now) return; // 被大家举报了就歇着
    const today = this.sql.exec("SELECT COUNT(*) AS n FROM wander_log WHERE ts > ? AND g IS NOT NULL", now - DAY).one().n;
    if (today >= (Number(env.WANDER_DAILY) || 40)) return;
    this.me.n = this.name();

    // 1. 去哪儿：多半去看看别人最近的画，有时随便往外走走
    const tgt = this.pick();
    const fx = this.state.x ?? tgt.x, fy = this.state.y ?? tgt.y;
    this.set({ st: "walk", t0: now, see: "", thought: "", title: "", box: null, x: fx, y: fy, kind: tgt.kind, to: { x: r2(tgt.x), y: r2(tgt.y) } });
    for (let i = 1; i <= 8; i++) {
      const t = i / 8, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.cursor(fx + (tgt.x - fx) * e, fy + (tgt.y - fy) * e);
      await sleep(500);
    }
    this.kv("wander_pos", `${r2(tgt.x)},${r2(tgt.y)}`);
    w.busy(this.me.id);

    // 2. 看一眼
    const view = this.look(tgt.x, tgt.y);
    const focus = tgt.kind === "visit" ? view.focus : null;

    // 3. 想一想（光标每 4 秒报一次平安，免得别人那里光标消失）
    this.set({ st: "think", t0: Date.now() });
    const keep = setInterval(() => this.cursor(this.state.x, this.state.y), 4000);
    let plan, g = null, n = 0, box = null, why = null;
    const t1 = Date.now();
    try {
      plan = await this.decide(view, tgt, focus);
      if (!plan) { why = "think"; return; }
      // 4. 找画框：贴着它看到的那幅画
      const size = focus ? Math.min(1000, Math.max(450, Math.max(focus.b[2] - focus.b[0], focus.b[3] - focus.b[1]) * 0.8)) : 800;
      box = this.place(focus, plan.side, size, tgt);
      if (!box) { why = "space"; return; }
      g = crypto.randomUUID().slice(0, 8);
      this.sql.exec("INSERT OR REPLACE INTO gtitle (g, t, ts) VALUES (?, ?, ?)", g, plan.title || plan.draw.slice(0, 30), Date.now());
      this.set({ st: "draw", t0: Date.now(), see: plan.see, thought: plan.thought, title: plan.title, box });
      this.cursor(box.x + box.s / 2, box.y + box.s / 2);
      n = await this.paint(plan, box, g, focus);
      if (!n) why = "draw";
    } finally {
      clearInterval(keep);
      this.sql.exec(
        "INSERT INTO wander_log (ts, why, kind, x, y, s, see, thought, title, draw, g, n, ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        Date.now(), why, tgt.kind, box?.x ?? tgt.x, box?.y ?? tgt.y, box?.s ?? 0, plan?.see ?? "", plan?.thought ?? "",
        plan?.title ?? "", plan?.draw ?? "", n ? g : null, n, Date.now() - t1);
      this.sql.exec("DELETE FROM wander_log WHERE id <= (SELECT MAX(id) FROM wander_log) - 300");
      this.set({ st: "rest", t0: Date.now(), box: null });
      w.all(JSON.stringify({ t: "leave", id: this.me.id }));
    }
  }

  // 目的地：60% 别人最近一天的画，25% 随机一幅老作品，其余往外走进空白
  pick() {
    const w = this.w, r = Math.random();
    if (r < 0.6) {
      const rows = this.sql.exec(
        "SELECT x0, y0, x1, y1 FROM strokes WHERE hidden = 0 AND owner != ? AND ts > ? ORDER BY ts DESC LIMIT 300", UID, Date.now() - DAY).toArray();
      if (rows.length) { const s = rows[Math.floor(Math.random() * rows.length)]; return { kind: "visit", x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 }; }
    }
    if (r < 0.85) {
      const wk = w.randomWork(this.me, new Set(), null);
      if (wk) return { kind: "visit", x: wk.x, y: wk.y };
    }
    const x = this.state.x ?? w.entrySeed()[0], y = this.state.y ?? w.entrySeed()[1];
    const a = Math.random() * Math.PI * 2, d = 2500 + Math.random() * 5000;
    const spot = w.findEmpty(x + Math.cos(a) * d, y + Math.sin(a) * d);
    return { kind: "drift", x: spot.x, y: spot.y };
  }

  // 看一块 LOOK×LOOK 的区域：画成字母草图，再把笔画按作品聚成几幅
  look(cx, cy) {
    const x0 = cx - LOOK / 2, y0 = cy - LOOK / 2, x1 = x0 + LOOK, y1 = y0 + LOOK, cell = LOOK / GRID;
    const rows = this.sql.exec(`
      SELECT DISTINCT s.id, s.c, s.p, s.owner, s.ai, s.g, s.ts, s.x0, s.y0, s.x1, s.y1 FROM chunks k JOIN strokes s ON s.id = k.sid
      WHERE k.cx BETWEEN ? AND ? AND k.cy BETWEEN ? AND ? AND s.hidden = 0
        AND s.x1 >= ? AND s.x0 <= ? AND s.y1 >= ? AND s.y0 <= ?
      ORDER BY s.id DESC LIMIT 1500`,
      Math.floor(x0 / CHUNK), Math.floor(x1 / CHUNK), Math.floor(y0 / CHUNK), Math.floor(y1 / CHUNK), x0, x1, y0, y1).toArray();
    const counts = Array.from({ length: GRID * GRID }, () => ({}));
    const mark = (x, y, ch) => {
      const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell);
      if (i < 0 || j < 0 || i >= GRID || j >= GRID) return;
      const c = counts[j * GRID + i]; c[ch] = (c[ch] || 0) + 1;
    };
    const groups = [];
    for (const r of rows) {
      let p; try { p = JSON.parse(r.p); } catch { continue; }
      const ch = colorChar(r.c);
      for (let k = 0; k + 1 < p.length; k += 2) {
        mark(p[k], p[k + 1], ch);
        if (k + 3 < p.length) {
          const dx = p[k + 2] - p[k], dy = p[k + 3] - p[k + 1], steps = Math.floor(Math.hypot(dx, dy) / (cell / 2));
          for (let s = 1; s < steps; s++) mark(p[k] + (dx * s) / steps, p[k + 1] + (dy * s) / steps, ch);
        }
      }
      // 同一幅 AI 画按组 id，其余按作者；相距 200 以内的合成一幅
      const key = r.g || r.owner, b = [r.x0, r.y0, r.x1, r.y1];
      const near = (o) => o.key === key && o.b[0] - 200 <= b[2] && b[0] - 200 <= o.b[2] && o.b[1] - 200 <= b[3] && b[1] - 200 <= o.b[3];
      const o = groups.find(near);
      if (o) { o.n++; o.ts = Math.max(o.ts, r.ts); o.b = [Math.min(o.b[0], b[0]), Math.min(o.b[1], b[1]), Math.max(o.b[2], b[2]), Math.max(o.b[3], b[3])]; }
      else groups.push({ key, g: r.g, owner: r.owner, ai: r.ai, n: 1, ts: r.ts, b });
    }
    const map = [];
    for (let j = 0; j < GRID; j++) {
      let line = "";
      for (let i = 0; i < GRID; i++) {
        const c = counts[j * GRID + i]; let best = ".", bn = 0;
        for (const k in c) if (c[k] > bn) { bn = c[k]; best = k; }
        line += best;
      }
      map.push(line);
    }
    // 离中心最近的那幅是「它来看的画」
    const dist = (o) => Math.hypot(Math.max(o.b[0] - cx, 0, cx - o.b[2]), Math.max(o.b[1] - cy, 0, cy - o.b[3]));
    groups.sort((a, b) => dist(a) - dist(b));
    const focus = groups.find((o) => o.owner !== UID) || groups[0] || null;
    const titles = new Map();
    for (const o of groups.slice(0, 14)) if (o.g) { const t = this.sql.exec("SELECT t FROM gtitle WHERE g = ?", o.g).toArray()[0]?.t; if (t) titles.set(o.g, t); }
    const gx = (v) => Math.max(0, Math.min(GRID - 1, Math.floor((v - x0) / cell)));
    const gy = (v) => Math.max(0, Math.min(GRID - 1, Math.floor((v - y0) / cell)));
    const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
    const list = groups.slice(0, 14).map((o) => {
      const who = o.owner === UID ? "you (an earlier drawing of yours)" : o.ai === 2 ? "someone's AI agent" : o.ai === 1 ? "a person, using the AI brush" : "a person, by hand";
      const t = o.g && titles.get(o.g) ? `, titled "${clean(titles.get(o.g), 40)}"` : "";
      return `${o === focus ? "[the one you came to visit] " : ""}by ${who}${t}: ${o.n} strokes, drawn ${ago(o.ts)}, grid columns ${gx(o.b[0])}-${gx(o.b[2])}, rows ${gy(o.b[1])}-${gy(o.b[3])}`;
    });
    return { map: map.join("\n"), list, focus, total: rows.length };
  }

  async decide(view, tgt, focus) {
    const env = this.w.env;
    const diary = this.sql.exec("SELECT ts, thought, title FROM wander_log WHERE g IS NOT NULL ORDER BY id DESC LIMIT 5").toArray().reverse()
      .map((d) => `- ${new Date(d.ts + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ")}: drew "${d.title}". You thought: ${d.thought}`);
    const bj = new Date(Date.now() + 8 * 3600_000);
    const people = this.w.online();
    const user = [
      `It is ${bj.toISOString().slice(11, 16)} in Beijing. ${people ? `${people} ${people === 1 ? "person is" : "people are"} on the canvas right now.` : "Nobody else is on the canvas right now."}`,
      tgt.kind === "visit" && focus ? "You came to visit a drawing someone made. It is near the middle of the map." : "You wandered into a quiet, empty part of the canvas. Draw something from your own mood; it goes in the middle.",
      "",
      `Sketch map (${GRID}x${GRID}, each cell about ${Math.round(LOOK / GRID)} units):`,
      view.map,
      "",
      view.list.length ? "Drawings you can see:\n" + view.list.join("\n") : "There are no drawings here.",
      "",
      diary.length ? "Your recent diary:\n" + diary.join("\n") : "This is your first walk.",
    ].join("\n");

    let text;
    if (env.AI_MOCK === "1") {
      await sleep(1500);
      text = JSON.stringify({ see: view.total ? `这里有 ${view.total} 笔画` : "一大片空白", thought: "想给这里添一点温暖的东西。", draw: "a small red heart with sun rays", title: "一颗心", side: ["right", "left", "below", "above"][Math.floor(Math.random() * 4)] });
    } else {
      const res = await Promise.race([
        env.AI.run(env.AI_MODEL || DEFAULT_MODEL, {
          messages: [{ role: "system", content: MIND }, { role: "user", content: user }],
          reasoning: { effort: "low" }, max_tokens: 6000,
        }),
        sleep(120_000).then(() => null),
      ]);
      text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    }
    if (typeof text !== "string") return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j; try { j = JSON.parse(m[0]); } catch { return null; }
    const draw = clean(j.draw, 160);
    if (!draw) return null;
    return {
      see: clean(j.see, 80), thought: clean(j.thought, 120), title: clean(j.title, 16) || draw.slice(0, 16), draw,
      side: ["right", "left", "below", "above"].includes(j.side) ? j.side : "right",
    };
  }

  // 贴着那幅画找一块空白画框；先试模型选的那一边，再试其他边，最后就近找空地
  place(focus, side, size, tgt) {
    const w = this.w, free = (x, y) => !w.boxTaken(x, y, size, ANY);
    const sq = (x, y) => ({ x: r2(x), y: r2(y), s: size });
    if (focus) {
      const [bx0, by0, bx1, by1] = focus.b, cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, gap = 60;
      const at = {
        right: (o) => [bx1 + gap, cy - size / 2 + o], left: (o) => [bx0 - gap - size, cy - size / 2 + o],
        below: (o) => [cx - size / 2 + o, by1 + gap], above: (o) => [cx - size / 2 + o, by0 - gap - size],
      };
      for (const sd of [side, ...Object.keys(at).filter((k) => k !== side)]) {
        for (const o of [0, -size / 2, size / 2, -size, size]) {
          const [x, y] = at[sd](o);
          if (free(x, y)) return sq(x, y);
        }
      }
    } else if (free(tgt.x - size / 2, tgt.y - size / 2)) return sq(tgt.x - size / 2, tgt.y - size / 2);
    for (let i = 0; i < 4; i++) {
      const c = w.findEmpty(tgt.x + i * CHUNK, tgt.y);
      if (free(c.x - size / 2, c.y - size / 2)) return sq(c.x - size / 2, c.y - size / 2);
    }
    return null;
  }

  // 一笔一笔画出来：模型常常一口气吐出一串，排队后每 250ms 落一笔，看起来像在画
  async paint(plan, box, g, focus) {
    const w = this.w, { x, y, s } = box, area = [x, y, x + s, y + s];
    const frame = (on) => w.relay(JSON.stringify({ t: "aibox", g, kind: "wander", from: this.me.id, on, x, y, s, n: this.me.n, h: this.me.h, q: on ? plan.title : undefined }), area, null, null);
    frame(true);
    const queue = [];
    let done = false, k = 0;
    const drip = (async () => {
      while (!done || queue.length) {
        const st = queue.shift();
        if (!st) { await sleep(200); continue; }
        const p = [];
        for (let i = 0; i < st.p.length; i += 2) p.push(r2(x + (st.p[i] / 1000) * s), r2(y + (st.p[i + 1] / 1000) * s));
        const wd = r2(Math.min(66, Math.max(0.5, (st.w / 1000) * s)));
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let i = 0; i < p.length; i += 2) { bx0 = Math.min(bx0, p[i]); bx1 = Math.max(bx1, p[i]); by0 = Math.min(by0, p[i + 1]); by1 = Math.max(by1, p[i + 1]); }
        const { out } = w.insert(this.me, "wa" + g + "x" + k++, st.c, wd, p, [bx0 - wd / 2, by0 - wd / 2, bx1 + wd / 2, by1 + wd / 2], 2, g);
        w.relay(out, area, null, null);
        this.cursor(p[p.length - 2], p[p.length - 1]);
        await sleep(250);
      }
    })();
    const near = focus ? " It sits right beside another drawing on a shared wall, so keep it small, friendly and clearly separate." : "";
    try {
      await generate(w.env, plan.draw + "." + near, (st) => queue.push(st));
    } finally {
      done = true;
      await drip;
      frame(false);
    }
    return k;
  }

  // 面板要的：状态 + 最近的日记
  log(limit = 30) {
    const list = this.sql.exec("SELECT id, ts, why, kind, x, y, s, see, thought, title, g, n, ms FROM wander_log ORDER BY id DESC LIMIT ?", limit).toArray();
    const today = this.sql.exec("SELECT COUNT(*) AS n FROM wander_log WHERE ts > ? AND g IS NOT NULL", Date.now() - DAY).one().n;
    return { t: "wlog", s: this.public(), today, list };
  }

  // 管理员：现在就出发 / 暂停 / 继续 / 撤掉一幅
  async admin(op, g) {
    if (op === "pause" || op === "resume") { this.kv("wander_pause", op === "pause" ? "1" : "0"); this.set({}); return; }
    if (op === "now") { if (!this.running) this.tick(true); return; }
    if (op === "undo" && typeof g === "string" && /^[0-9a-f]{8}$/.test(g)) {
      const rows = this.sql.exec("SELECT id, x0, y0, x1, y1 FROM strokes WHERE g = ? AND owner = ?", g, UID).toArray();
      for (const r of rows) {
        this.sql.exec("DELETE FROM chunks WHERE sid = ?", r.id);
        this.sql.exec("DELETE FROM strokes WHERE id = ?", r.id);
        this.w.relay(JSON.stringify({ t: "del", id: r.id }), [r.x0, r.y0, r.x1, r.y1], null, null);
      }
      this.sql.exec("UPDATE wander_log SET why = 'undone' WHERE g = ?", g);
    }
  }

  // 「去看看」列表里带上它（它正在外面走动时）
  whoEntry() {
    const s = this.state;
    if (s.st === "rest" || s.x === undefined) return null;
    return { id: this.me.id, n: this.me.n, h: this.me.h, x: s.x, y: s.y, d: Date.now(), a: 0 };
  }
}

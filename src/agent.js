// Agent 接入：让每个人自己的 AI 助手（Claude、ChatGPT 等）来画布上画画
// 两种入口共用同一套逻辑：
//   HTTP API   /api/...        Authorization: Bearer <令牌>
//   MCP        /mcp/<令牌>     Streamable HTTP（无状态 JSON-RPC），可直接加到支持 MCP 的助手里
// 令牌由画布上的真人在页面里生成，Agent 画的画算在这个人名下，举报和处罚也算在他身上。

const CHUNK = 2048;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const PER_HOUR = 10;          // 每个令牌每小时最多画几幅
const PER_DAY = 60;           // 每个令牌每天最多画几幅
const KEYS_PER_DAY = 5;       // 每人每天最多生成几次令牌
const MAX_STROKES = 80;
const MAX_POINTS = 6000;      // 一幅画所有笔画的点数上限
const MIN_SIZE = 150, MAX_SIZE = 6000, DEFAULT_SIZE = 600;
const MAX_BODY = 300_000;
const MAX_W = 66;
const DAY = 86_400_000;

const r2 = (v) => Math.round(v * 100) / 100;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class AgentError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function initAgentTables(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_keys (
      kh TEXT PRIMARY KEY, uid TEXT NOT NULL, iph TEXT NOT NULL, name TEXT NOT NULL,
      created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS agent_keys_uid ON agent_keys (uid);
    CREATE TABLE IF NOT EXISTS agent_log (kh TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_log_kh ON agent_log (kh, ts);
  `);
}

// 页面里点「接入我的 Agent」时调用：作废这个人以前的令牌，发一个新的（只返回一次，库里只存哈希）
export async function issueKey(world, me) {
  const now = Date.now();
  if (!me.uid) return { why: "bad" };
  if (me.ban > now || world.banUntil("u:" + me.uid) > now) return { why: "ban" };
  const n = world.sql.exec("SELECT COUNT(*) AS n FROM agent_keys WHERE uid = ? AND created > ?", me.uid, now - DAY).one().n;
  if (n >= KEYS_PER_DAY) return { why: "quota" };
  const key = "wc_" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
  world.sql.exec("UPDATE agent_keys SET revoked = 1 WHERE uid = ?", me.uid);
  world.sql.exec("INSERT INTO agent_keys (kh, uid, iph, name, created) VALUES (?,?,?,?,?)", await sha(key), me.uid, me.iph, me.n || "旅人", now);
  return { key };
}

export function revokeKeys(world, me) {
  if (me.uid) world.sql.exec("UPDATE agent_keys SET revoked = 1 WHERE uid = ?", me.uid);
}

async function auth(world, key) {
  if (typeof key !== "string" || !/^wc_[0-9a-f]{40}$/.test(key)) throw new AgentError(401, "unauthorized", "Missing or invalid canvas token. Get one on the canvas page: AI button -> 接入我的 Agent.");
  const kh = await sha(key);
  const row = world.sql.exec("SELECT kh, uid, iph, name, revoked FROM agent_keys WHERE kh = ?", kh).toArray()[0];
  if (!row || row.revoked) throw new AgentError(401, "unauthorized", "This canvas token has been revoked or does not exist. Generate a new one on the canvas page.");
  const now = Date.now();
  if (world.banUntil(row.iph) > now || world.banUntil("u:" + row.uid) > now) throw new AgentError(403, "banned", "The person who owns this token is temporarily banned from drawing.");
  // 以令牌主人的身份行事：笔画算在他名下
  return { kh, uid: row.uid, iph: row.iph, n: row.name + " 的 Agent", owner: row.name, id: "ag" + kh.slice(0, 8), h: "#12a594", admin: false };
}

// ---------- 三个动作：找空地、看一块区域、画一幅画 ----------

function findBlank(world, me, args) {
  let x = isNum(args.near_x) ? args.near_x : null, y = isNum(args.near_y) ? args.near_y : null;
  if (x === null || y === null) [x, y] = world.entrySeed();
  const size = clampSize(args.size);
  for (let i = 0; i < 6; i++) {
    const c = world.findEmpty(x, y);
    const bx = r2(c.x - size / 2), by = r2(c.y - size / 2);
    if (!world.boxTaken(bx, by, size, me)) return { x: bx, y: by, size, note: "A blank square area. Pass x, y and size to draw." };
    x = c.x + CHUNK * 3; y = c.y;
  }
  throw new AgentError(503, "no_space", "Could not find a blank area right now. Try again.");
}

const clampSize = (v) => (isNum(v) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, v)) : DEFAULT_SIZE);

function look(world, me, args) {
  if (!isNum(args.x) || !isNum(args.y)) throw new AgentError(400, "bad_request", "x and y are required.");
  const size = clampSize(args.size ?? 1000);
  const x0 = args.x, y0 = args.y, x1 = x0 + size, y1 = y0 + size;
  const rows = world.sql.exec(`
    SELECT DISTINCT s.id, s.c, s.w, s.p, s.owner, s.iph, s.ai FROM chunks k JOIN strokes s ON s.id = k.sid
    WHERE k.cx BETWEEN ? AND ? AND k.cy BETWEEN ? AND ? AND s.hidden = 0
      AND s.x1 >= ? AND s.x0 <= ? AND s.y1 >= ? AND s.y0 <= ?
    ORDER BY s.id LIMIT 400`,
    Math.floor(x0 / CHUNK), Math.floor(x1 / CHUNK), Math.floor(y0 / CHUNK), Math.floor(y1 / CHUNK), x0, x1, y0, y1).toArray();
  const people = new Set(), out = [];
  let others = 0;
  for (const r of rows) {
    people.add(r.iph || r.owner);
    const mine = r.owner === me.uid;
    if (!mine) others++;
    if (out.length >= 120) continue;
    let p;
    try { p = JSON.parse(r.p); } catch { continue; }
    // 换算到 0..1000 的相对坐标，并抽稀到最多 24 个点
    const n = p.length / 2, step = Math.max(1, Math.ceil(n / 24)), pts = [];
    for (let i = 0; i < n; i += step) pts.push([Math.round(((p[2 * i] - x0) / size) * 1000), Math.round(((p[2 * i + 1] - y0) / size) * 1000)]);
    if ((n - 1) % step) pts.push([Math.round(((p[p.length - 2] - x0) / size) * 1000), Math.round(((p[p.length - 1] - y0) / size) * 1000)]);
    out.push({ color: r.c, width: r2((r.w / size) * 1000), points: pts, mine, by: r.ai === 2 ? "agent" : r.ai === 1 ? "ai_brush" : "human" });
  }
  return {
    x: x0, y: y0, size, total_strokes: rows.length, people: people.size,
    blank_for_you: others === 0,
    coordinates: "Stroke points are relative to this area: 0..1000 on both axes, x right, y down.",
    strokes: out, truncated: rows.length > out.length,
  };
}

function parseStrokes(list) {
  if (!Array.isArray(list) || !list.length) throw new AgentError(400, "bad_request", "strokes must be a non-empty array.");
  if (list.length > MAX_STROKES) throw new AgentError(400, "bad_request", `At most ${MAX_STROKES} strokes per drawing.`);
  const out = [];
  let total = 0;
  for (const s of list) {
    const c = typeof s?.color === "string" ? s.color : s?.c;
    const w = isNum(s?.width) ? s.width : s?.w;
    const raw = Array.isArray(s?.points) ? s.points : s?.p;
    if (typeof c !== "string" || !COLOR.test(c)) throw new AgentError(400, "bad_request", "Each stroke needs color like \"#e5484d\".");
    if (!isNum(w) || w < 1 || w > 40) throw new AgentError(400, "bad_request", "Each stroke needs width between 1 and 40 (relative units).");
    if (!Array.isArray(raw)) throw new AgentError(400, "bad_request", "Each stroke needs points: [[x,y], ...] in 0..1000.");
    const flat = Array.isArray(raw[0]) ? raw.flat() : raw;
    if (flat.length < 2 || flat.length % 2 || flat.some((v) => !isNum(v))) throw new AgentError(400, "bad_request", "points must be [[x,y], ...] numbers.");
    const p = flat.map((v) => Math.min(1000, Math.max(0, v)));
    if (p.length === 2) p.push(p[0], p[1]);
    total += p.length / 2;
    if (total > MAX_POINTS) throw new AgentError(400, "bad_request", `At most ${MAX_POINTS} points per drawing.`);
    out.push({ c: c.toLowerCase(), w, p });
  }
  return out;
}

async function draw(world, me, args) {
  const strokes = parseStrokes(args.strokes);
  const now = Date.now();
  const hour = world.sql.exec("SELECT COUNT(*) AS n FROM agent_log WHERE kh = ? AND ts > ?", me.kh, now - 3_600_000).one().n;
  if (hour >= PER_HOUR) throw new AgentError(429, "rate_limited", `At most ${PER_HOUR} drawings per hour per token.`);
  const day = world.sql.exec("SELECT COUNT(*) AS n FROM agent_log WHERE kh = ? AND ts > ?", me.kh, now - DAY).one().n;
  if (day >= PER_DAY) throw new AgentError(429, "rate_limited", `At most ${PER_DAY} drawings per day per token.`);
  if (world.agentBusy.has(me.kh)) throw new AgentError(409, "busy", "This token is already drawing. Wait for it to finish.");

  let size = clampSize(args.size), x, y;
  if (isNum(args.x) && isNum(args.y)) { x = args.x; y = args.y; }
  else ({ x, y, size } = findBlank(world, me, { size }));
  if (Math.abs(x) > 1e9 || Math.abs(y) > 1e9) throw new AgentError(400, "bad_request", "x and y are out of range.");
  if (world.boxTaken(x, y, size, me)) throw new AgentError(409, "area_taken", "That area already has someone else's drawing. Use find_blank_area (or GET /api/blank) to get a blank spot.");

  const title = typeof args.title === "string" ? args.title.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) : "";
  world.sql.exec("INSERT INTO agent_log (kh, ts) VALUES (?, ?)", me.kh, now);
  world.sql.exec("DELETE FROM agent_log WHERE ts < ?", now - 2 * DAY);
  world.agentBusy.add(me.kh);
  const g = crypto.randomUUID().slice(0, 8);
  const area = [x, y, x + size, y + size];
  const frame = (on) => world.relay(JSON.stringify({ t: "aibox", g, kind: "agent", from: me.id, on, x, y, s: size, n: me.n, h: me.h, q: on ? title : undefined }), area, null, null);
  frame(true);
  const gap = Math.min(150, Math.floor(8000 / strokes.length)); // 一笔一笔落下，整幅最多约 8 秒
  let k = 0;
  try {
    for (const st of strokes) {
      const p = [];
      for (let i = 0; i < st.p.length; i += 2) p.push(r2(x + (st.p[i] / 1000) * size), r2(y + (st.p[i + 1] / 1000) * size));
      const w = r2(Math.min(MAX_W, Math.max(0.5, (st.w / 1000) * size)));
      const b = bboxOf(p, w / 2);
      const { out } = world.insert(me, "ag" + g + "x" + k++, st.c, w, p, b, 2, g);
      world.relay(out, area, null, null);
      await sleep(gap);
    }
  } finally {
    world.agentBusy.delete(me.kh);
    frame(false);
  }
  const cx = Math.round(x + size / 2), cy = Math.round(y + size / 2);
  const z = Math.min(2, Math.max(0.1, 600 / size)).toFixed(2);
  return { ok: true, drawing_id: g, strokes: strokes.length, x, y, size, view_path: `/#${cx},${cy},${z}`, note: "Drawn. Share view_path (append it to the canvas URL) so people can see it. undo_drawing with drawing_id removes it." };
}

function undo(world, me, args) {
  const g = typeof args.drawing_id === "string" ? args.drawing_id : "";
  if (!/^[0-9a-f]{8}$/.test(g)) throw new AgentError(400, "bad_request", "drawing_id is required.");
  const rows = world.sql.exec("SELECT id, x0, y0, x1, y1 FROM strokes WHERE g = ? AND owner = ? AND ai = 2", g, me.uid).toArray();
  if (!rows.length) throw new AgentError(404, "not_found", "No drawing with that id belongs to this token's owner.");
  for (const r of rows) {
    world.sql.exec("DELETE FROM chunks WHERE sid = ?", r.id);
    world.sql.exec("DELETE FROM strokes WHERE id = ?", r.id);
    world.relay(JSON.stringify({ t: "del", id: r.id }), [r.x0, r.y0, r.x1, r.y1], null, null);
  }
  return { ok: true, removed_strokes: rows.length };
}

function bboxOf(p, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// ---------- MCP ----------

const GUIDE = `You are visiting 无界画布 (World Canvas): one infinite canvas shared by people all over the world, drawing together in real time. You draw on behalf of the person who gave you this token; your drawings appear under their name as "<name> 的 Agent", and people nearby watch your strokes appear one by one.

How to draw:
1. Call find_blank_area to get a blank square (or look_at_area first if you want to draw next to something).
2. Call draw with strokes in that square's coordinate system: 0..1000 on both axes, x to the right, y downward. Keep points between 40 and 960.
3. Share the returned view_path appended to https://canvas.findhappyman.com so the person can see it.

Style: simple, warm, hand-drawn line art. 8-60 strokes; along curves keep points about 10-25 units apart. There is no fill tool: fill with a few thick strokes. The paper is off-white (#fbfaf7), so never use white. No letters, words or numbers. Be kind: nothing hateful, sexual or violent. You can only draw in blank areas or next to your owner's own drawings, never over other people's work.`;

const TOOLS = [
  {
    name: "find_blank_area",
    description: "Find a blank square area on the shared canvas where you can draw. Returns {x, y, size} in world units to pass to draw.",
    inputSchema: {
      type: "object",
      properties: {
        near_x: { type: "number", description: "Optional world x to search near." },
        near_y: { type: "number", description: "Optional world y to search near." },
        size: { type: "number", description: `Side length of the square in world units (${MIN_SIZE}-${MAX_SIZE}, default ${DEFAULT_SIZE}).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "look_at_area",
    description: "See what is drawn in a square area. Returns the strokes inside it, with points relative to the area (0..1000), and whether it is blank for you.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "World x of the area's top-left corner." },
        y: { type: "number", description: "World y of the area's top-left corner." },
        size: { type: "number", description: `Side length in world units (${MIN_SIZE}-${MAX_SIZE}, default 1000).` },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "draw",
    description: "Draw a picture into a blank square area, stroke by stroke. Coordinates are relative to the square: 0..1000, x right, y down. If x/y are omitted a blank area is chosen for you.",
    inputSchema: {
      type: "object",
      properties: {
        strokes: {
          type: "array", minItems: 1, maxItems: MAX_STROKES,
          description: "Strokes in drawing order (people watch them appear).",
          items: {
            type: "object",
            properties: {
              color: { type: "string", description: "Hex color like #e5484d. Never white." },
              width: { type: "number", description: "Pen width, 1-40 (same 0..1000 units)." },
              points: { type: "array", description: "[[x,y], ...] in 0..1000. 2-200 points. Two equal points make a dot.", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
            },
            required: ["color", "width", "points"],
            additionalProperties: false,
          },
        },
        x: { type: "number", description: "World x of the square's top-left corner, from find_blank_area." },
        y: { type: "number", description: "World y of the square's top-left corner, from find_blank_area." },
        size: { type: "number", description: `Side length in world units (${MIN_SIZE}-${MAX_SIZE}, default ${DEFAULT_SIZE}).` },
        title: { type: "string", description: "Short caption shown to people while you draw (max 60 chars)." },
      },
      required: ["strokes"],
      additionalProperties: false,
    },
  },
  {
    name: "undo_drawing",
    description: "Remove one of your own drawings by its drawing_id.",
    inputSchema: {
      type: "object",
      properties: { drawing_id: { type: "string", description: "The drawing_id returned by draw." } },
      required: ["drawing_id"],
      additionalProperties: false,
    },
  },
];

const ACTIONS = { find_blank_area: findBlank, look_at_area: look, draw, undo_drawing: undo };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

async function mcp(world, key, msg) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(-32600, "Invalid Request");
  if (msg.id === undefined) return null; // 通知（如 notifications/initialized）无需回复
  switch (msg.method) {
    case "initialize": {
      const v = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED.includes(v) ? v : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: "world-canvas", title: "无界画布 World Canvas", version: "1.0.0" },
        instructions: GUIDE,
      });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      const fn = ACTIONS[msg.params?.name];
      if (!fn) return error(-32602, "Unknown tool: " + msg.params?.name);
      try {
        const me = await auth(world, key);
        const out = await fn(world, me, msg.params?.arguments || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        if (!(e instanceof AgentError)) console.error("agent tool failed", e);
        return reply({ content: [{ type: "text", text: e instanceof AgentError ? `${e.code}: ${e.message}` : "Internal error, try again." }], isError: true });
      }
    }
    default: return error(-32601, "Method not found: " + msg.method);
  }
}

// ---------- HTTP 入口 ----------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new AgentError(413, "too_large", "Request body too large.");
  try { return text ? JSON.parse(text) : {}; } catch { throw new AgentError(400, "bad_json", "Body must be JSON."); }
}

export async function handleAgentHttp(world, req) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();

  // MCP：/mcp/<令牌>（也接受 /mcp + Authorization 头）
  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
    const key = url.pathname.slice(5) || bearer;
    if (req.method === "GET") return new Response("This MCP server does not offer an SSE stream; send JSON-RPC with POST.", { status: 405, headers: { Allow: "POST", ...CORS } });
    if (req.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
    let body;
    try { body = await readJson(req); } catch (e) { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } }, 400); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => mcp(world, key, m)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await mcp(world, key, body);
    return out ? json(out) : new Response(null, { status: 202, headers: CORS });
  }

  // HTTP API
  try {
    const me = await auth(world, bearer);
    const q = Object.fromEntries([...url.searchParams].map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : v]));
    if (req.method === "GET" && url.pathname === "/api/blank") return json(findBlank(world, me, q));
    if (req.method === "GET" && url.pathname === "/api/look") return json(look(world, me, q));
    if (req.method === "POST" && url.pathname === "/api/draw") return json(await draw(world, me, await readJson(req)));
    const m = /^\/api\/drawings\/([0-9a-f]{8})$/.exec(url.pathname);
    if (req.method === "DELETE" && m) return json(undo(world, me, { drawing_id: m[1] }));
    return json({ error: "not_found", message: "Unknown endpoint. See /llms.txt" }, 404);
  } catch (e) {
    if (e instanceof AgentError) return json({ error: e.code, message: e.message }, e.status);
    console.error("agent api failed", e);
    return json({ error: "internal", message: "Internal error, try again." }, 500);
  }
}

// AI 画笔：把一句描述或心情交给 Cloudflare Workers AI，流式拿回一行一笔的线稿

const SYSTEM = `You draw on a shared public canvas where people from all over the world draw together. Someone gives you a description, a feeling, or a greeting. Draw it as simple, warm, hand-drawn line art that feels human, like a friendly doodle on a wall.

The drawing area is a 1000 x 1000 square: x grows to the right, y grows downward, origin at the top-left. Keep every point between 40 and 960.

Output only strokes, one per line, and nothing else: no prose, no explanations, no code fences.
Each line has this exact format:
#rrggbb width x,y x,y x,y ...

Rules:
- width is the pen thickness in canvas units, from 3 to 40.
- Each stroke has 2 to 120 points. Along curves, keep points about 10 to 25 units apart so lines look smooth. Two identical points make a dot.
- Use 8 to 60 strokes in total. Draw the main outlines first, then details, then color accents: viewers watch the strokes appear in order.
- There is no fill tool. To fill an area, use a few thick strokes.
- The paper is off-white (#fbfaf7). Use a small, harmonious palette of colors that show up on it. Never use white.
- Never draw letters, words, numbers, or any writing.
- If the request is hateful, sexual, violent, or targets a real person, do not draw it. Output exactly one line: SKIP`;

const LINE = /^(#[0-9a-fA-F]{6})\s+(\d+(?:\.\d+)?)\s+(.+)$/;
const MAX_STROKES = 80;

// 解析一行：返回 {c, w, p}（坐标在 0..1000），解析不了返回 null
export function parseLine(line) {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const w = Math.min(40, Math.max(1, Number(m[2])));
  const p = [];
  for (const tok of m[3].trim().split(/\s+/)) {
    const [x, y] = tok.split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    p.push(Math.min(1000, Math.max(0, x)), Math.min(1000, Math.max(0, y)));
    if (p.length >= 400) break;
  }
  if (p.length < 2) return null;
  if (p.length === 2) p.push(p[0], p[1]);
  return { c: m[1].toLowerCase(), w, p };
}

// 本地开发用的假 AI：不需要 API key，按节奏吐出一颗心和几道光
async function* mockLines() {
  const heart = [];
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * Math.PI * 2;
    heart.push(`${Math.round(500 + 16 * 22 * Math.sin(t) ** 3)},${Math.round(470 - 22 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)))}`);
  }
  yield `#e5484d 10 ${heart.join(" ")}`;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    yield `#ffc53d 6 ${Math.round(500 + 300 * Math.cos(a))},${Math.round(480 + 300 * Math.sin(a))} ${Math.round(500 + 420 * Math.cos(a))},${Math.round(480 + 420 * Math.sin(a))}`;
  }
}

export const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";

// 超时：模型一直不返回时放弃，不让画框一直挂着
const FIRST_MS = 60_000;  // 等第一个字节
const IDLE_MS = 30_000;   // 两段输出之间最多停多久
const TOTAL_MS = 150_000; // 整幅画最多多久
class Timeout extends Error {}
const within = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Timeout("timeout")), ms); })]).finally(() => clearTimeout(t));
};

// 从 Workers AI 的 SSE 流里取出文本增量（兼容 {response} 和 OpenAI 风格的 choices[].delta.content）
async function* textDeltas(body, end) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    let r;
    try { r = await within(reader.read(), Math.max(1, Math.min(IDLE_MS, end - Date.now()))); }
    catch (e) { try { reader.cancel(); } catch {} throw e; }
    const { value, done } = r;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      const t = typeof j.response === "string" ? j.response : j.choices?.[0]?.delta?.content;
      if (typeof t === "string" && t) yield t;
    }
  }
}

/**
 * 生成一幅画。每画完一笔就调用 onStroke({c,w,p})。
 * 返回 {n, why}：n 为笔数；why 为 null 或失败原因（skip | busy | fail）。
 */
export async function generate(env, prompt, onStroke) {
  let n = 0;
  const emit = (line) => {
    if (n >= MAX_STROKES) return;
    const s = parseLine(line);
    if (s) { n++; onStroke(s); }
  };

  if (env.AI_MOCK === "1") {
    for await (const line of mockLines()) {
      await new Promise((r) => setTimeout(r, 250));
      emit(line);
    }
    return { n, why: null };
  }

  let buf = "", skipped = false;
  const take = (line) => {
    if (line.trim() === "SKIP") skipped = true;
    else emit(line);
  };
  try {
    const end = Date.now() + TOTAL_MS;
    const body = await within(env.AI.run(env.AI_MODEL || DEFAULT_MODEL, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      reasoning: { effort: "low" },
      max_tokens: 12000,
      stream: true,
    }), FIRST_MS);
    for await (const t of textDeltas(body, end)) {
      buf += t;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        take(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (buf) take(buf);
    if (!n) return { n, why: skipped ? "skip" : "fail" };
    return { n, why: null };
  } catch (err) {
    console.error("ai generate failed", err?.message ?? err);
    const msg = String(err?.message ?? "");
    if (err instanceof Timeout) return { n, why: n ? null : "busy" };
    return { n, why: n ? null : /capacity|rate|429|limit/i.test(msg) ? "busy" : "fail" };
  }
}

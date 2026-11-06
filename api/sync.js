// Cloud save for Word Wizard + Word Muncher (iPhone <-> iPad).
// Storage: Upstash Redis added from Vercel > Storage (env vars are injected automatically).
// GET  /api/sync?code=XXX            -> { rev, data, ts }   (rev 0 = nothing saved yet)
// POST /api/sync {code, baseRev, data} -> { rev }  or 409 { rev, data } when another device saved first
// Every save also keeps a daily backup (kept 60 days) so play history can always be restored.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmds) {
  const r = await fetch(URL_ + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).map((x) => x.result);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(503).json({ error: "storage-not-connected" });
  const code = String((req.method === "GET" ? req.query.code : req.body && req.body.code) || "").toLowerCase();
  if (!/^[a-z0-9-]{6,40}$/.test(code)) return res.status(400).json({ error: "bad-code" });
  const key = "sync:" + code;
  try {
    const [cur] = await redis([["GET", key]]);
    const doc = cur ? JSON.parse(cur) : { rev: 0, data: null, ts: 0 };
    if (req.method === "GET") return res.status(200).json(doc);
    if (req.method !== "POST") return res.status(405).end();
    const { baseRev, data } = req.body || {};
    if (!data || typeof data !== "object") return res.status(400).json({ error: "no-data" });
    if ((baseRev || 0) !== doc.rev) return res.status(409).json(doc);
    const next = { rev: doc.rev + 1, data, ts: Date.now() };
    const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // Vietnam date
    const body = JSON.stringify(next);
    await redis([
      ["SET", key, body],
      ["SET", "bak:" + code + ":" + day, body, "EX", String(60 * 86400)],
    ]);
    return res.status(200).json({ rev: next.rev, ts: next.ts });
  } catch (e) {
    return res.status(500).json({ error: "server", detail: String(e.message || e) });
  }
};

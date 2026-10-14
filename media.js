// Lead media: the homeowner's guided photos and optional walk-in video.
// Stored in Postgres (bytea) for now. If volume grows, swap saveMedia/readMedia for object storage (S3/R2) and keep the routes.
//
//   POST /api/leads/:id/media/photos?token=<resume_token>   JSON { photos: [{ slot, media_type, data(base64 or data URL) }] }
//   POST /api/leads/:id/media/video?token=<resume_token>    raw video bytes (Content-Type video/mp4 | video/webm | video/quicktime)
//   GET  /api/leads/:id/media                               x-api-key (assigned company) or x-admin-key -> list with short-lived links
//   GET  /api/media/:mediaId?e=&s=                          signed link, supports HTTP Range so video plays and seeks everywhere
const crypto = require("crypto");

module.exports = function initMedia(d) {
  const { app, pool, express, authCompany, requireAdmin, limiter, logAudit } = d;

  const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_MB || 50) * 1024 * 1024;
  const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
  const MAX_PHOTOS = 12;
  const LINK_MINUTES = 20;
  const SLOTS = new Set(["full", "base", "surroundings", "canopy", "house", "access", "lines"]);
  const SECRET = crypto.randomBytes(32); // links die on restart, which is fine: they only live minutes
  const sign = (id, exp) => crypto.createHmac("sha256", SECRET).update(`${id}.${exp}`).digest("hex").slice(0, 32);
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function schema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lead_media (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER NOT NULL,
        tree_index INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        slot TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_lead_media_lead ON lead_media (lead_id)");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_media_slot ON lead_media (lead_id, kind, tree_index, slot)");
  }

  // ---- file-type checks on the bytes themselves, not on what the browser claims ----
  function sniffImage(buf) {
    if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
    return null;
  }
  function sniffVideo(buf) {
    if (buf.length > 16 && buf.slice(4, 8).toString() === "ftyp") {
      const brand = buf.slice(8, 12).toString();
      return brand.startsWith("qt") ? "video/quicktime" : "video/mp4";
    }
    if (buf.length > 16 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
    return null;
  }

  async function leadForToken(req) {
    const id = Number(req.params.id);
    const token = String(req.query.token || "");
    if (!Number.isInteger(id) || token.length < 20) return null;
    const { rows } = await pool.query("SELECT id, resume_token FROM leads WHERE id = $1", [id]);
    if (!rows[0] || !rows[0].resume_token || !safeEq(rows[0].resume_token, token)) return null;
    return rows[0];
  }

  // ---- photos ----
  app.post("/api/leads/:id/media/photos", limiter, async (req, res) => {
    try {
      const lead = await leadForToken(req);
      if (!lead) return res.status(403).json({ error: "Invalid link." });
      const list = Array.isArray(req.body && req.body.photos) ? req.body.photos : [];
      if (!list.length) return res.status(400).json({ error: "No photos sent." });
      if (list.length > MAX_PHOTOS) return res.status(400).json({ error: `At most ${MAX_PHOTOS} photos.` });
      let saved = 0; const rejected = [];
      for (const p of list) {
        const slot = String(p.slot || "");
        const okSlot = SLOTS.has(slot) || /^extra\d{1,2}$/.test(slot);
        const tree = Number.isInteger(p.tree_index) && p.tree_index >= 0 && p.tree_index < 20 ? p.tree_index : 0;
        const raw = String(p.data || "").replace(/^data:[^,]*,/, "");
        const buf = Buffer.from(raw, "base64");
        const type = sniffImage(buf);
        if (!okSlot || !type || buf.length > MAX_PHOTO_BYTES) { rejected.push(slot || "?"); continue; }
        await pool.query(
          `INSERT INTO lead_media (lead_id, tree_index, kind, slot, content_type, size_bytes, data)
           VALUES ($1,$2,'photo',$3,$4,$5,$6)
           ON CONFLICT (lead_id, kind, tree_index, slot) DO UPDATE SET content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, created_at = NOW()`,
          [lead.id, tree, slot, type, buf.length, buf]);
        saved++;
      }
      res.json({ saved, rejected });
    } catch (e) { console.error("[media/photos] Failed:", e); res.status(500).json({ error: "Could not save photos." }); }
  });

  // ---- video ----
  const rawVideo = express.raw({ type: ["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"], limit: MAX_VIDEO_BYTES });
  app.post("/api/leads/:id/media/video", limiter, async (req, res, next) => {
    // Cheap early rejection before buffering a huge body.
    const len = Number(req.headers["content-length"] || 0);
    if (len > MAX_VIDEO_BYTES) return res.status(413).json({ error: `Video is too large (limit ${Math.round(MAX_VIDEO_BYTES / 1048576)} MB).` });
    next();
  }, rawVideo, async (req, res) => {
    try {
      const lead = await leadForToken(req);
      if (!lead) return res.status(403).json({ error: "Invalid link." });
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "No video received." });
      const type = sniffVideo(buf);
      if (!type) return res.status(415).json({ error: "That file does not look like an MP4, MOV or WebM video." });
      await pool.query(
        `INSERT INTO lead_media (lead_id, tree_index, kind, slot, content_type, size_bytes, data)
         VALUES ($1,0,'video','walkin',$2,$3,$4)
         ON CONFLICT (lead_id, kind, tree_index, slot) DO UPDATE SET content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, created_at = NOW()`,
        [lead.id, type, buf.length, buf]);
      res.json({ saved: true, bytes: buf.length });
    } catch (e) {
      if (e && e.type === "entity.too.large") return res.status(413).json({ error: "Video is too large." });
      console.error("[media/video] Failed:", e); res.status(500).json({ error: "Could not save video." });
    }
  });

  // ---- listing (assigned company or admin) ----
  app.get("/api/leads/:id/media", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad lead id." });
      if (req.header("x-admin-key")) { if (!requireAdmin(req, res)) return; }
      else {
        const co = await authCompany(req);
        if (!co) return res.status(401).json({ error: "Invalid API key." });
        const { rows: lr } = await pool.query("SELECT 1 FROM leads WHERE id = $1 AND assigned_company_id = $2", [id, co.id]);
        if (!lr.length) return res.status(404).json({ error: "Lead not found." });
      }
      const { rows } = await pool.query("SELECT id, tree_index, kind, slot, content_type, size_bytes FROM lead_media WHERE lead_id = $1 ORDER BY kind DESC, tree_index, id", [id]);
      const exp = Date.now() + LINK_MINUTES * 60 * 1000;
      res.json(rows.map(r => ({ ...r, url: `/api/media/${r.id}?e=${exp}&s=${sign(r.id, exp)}` })));
    } catch (e) { console.error("[media/list] Failed:", e); res.status(500).json({ error: "Could not load media." }); }
  });

  // ---- signed download with Range support ----
  app.get("/api/media/:mediaId", async (req, res) => {
    try {
      const id = Number(req.params.mediaId), exp = Number(req.query.e);
      if (!Number.isInteger(id) || !exp || exp < Date.now() || !safeEq(sign(id, exp), req.query.s || "")) return res.status(403).send("Link expired.");
      const { rows } = await pool.query("SELECT content_type, data FROM lead_media WHERE id = $1", [id]);
      if (!rows[0]) return res.status(404).send("Not found.");
      const buf = rows[0].data, total = buf.length;
      res.set({ "Content-Type": rows[0].content_type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff" });
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (m && (m[1] || m[2])) {
        let start = m[1] === "" ? Math.max(total - Number(m[2]), 0) : Number(m[1]);
        let end = m[1] === "" || m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
        if (start > end || start >= total) { res.set("Content-Range", `bytes */${total}`); return res.status(416).end(); }
        res.status(206).set({ "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
        return res.end(buf.slice(start, end + 1));
      }
      res.set("Content-Length", total);
      res.end(buf);
    } catch (e) { console.error("[media/get] Failed:", e); res.status(500).send("Error."); }
  });

  // Counts for the lead lists, so the dashboard can show "3 photos, video" without loading anything.
  async function countsFor(leadIds) {
    if (!leadIds.length) return {};
    const { rows } = await pool.query("SELECT lead_id, kind, COUNT(*)::int AS n FROM lead_media WHERE lead_id = ANY($1) GROUP BY lead_id, kind", [leadIds]);
    const out = {}; rows.forEach(r => { (out[r.lead_id] = out[r.lead_id] || { photos: 0, video: 0 })[r.kind === "video" ? "video" : "photos"] = r.n; });
    return out;
  }

  return { schema, countsFor, SLOTS, MAX_VIDEO_BYTES };
};

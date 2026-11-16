"use strict";
// Database + HTTP side of the aerial height check. See lidar.js for the switch (LIDAR_MODE) and lidar-core.js for the logic.
const L = require("./lidar");
const core = require("./lidar-core");
const num = (v, max = 1e7) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);

module.exports = function ({ app, pool, requireAdmin, limiter, express }) {
  async function schema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS lidar_lookups (
      id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(), mode TEXT, zip TEXT, address_hash TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION, geocode_method TEXT,
      source TEXT, acquisition_start TEXT, acquisition_end TEXT, canopy_modes TEXT, status TEXT, reason TEXT, use_candidate BOOLEAN DEFAULT FALSE,
      height_ft DOUBLE PRECISION, low_ft DOUBLE PRECISION, high_ft DOUBLE PRECISION, uncertainty_ft DOUBLE PRECISION, tier TEXT, photo_tier TEXT,
      photo_h_low DOUBLE PRECISION, photo_h_high DOUBLE PRECISION, age_years DOUBLE PRECISION, candidates_json TEXT, elapsed_ms INTEGER,
      photo_quote_low INTEGER, photo_quote_high INTEGER, photo_category TEXT, aerial_quote_low INTEGER, aerial_quote_high INTEGER, aerial_category TEXT,
      applied BOOLEAN, outcome_at TIMESTAMP)`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_lidar_lookups_created ON lidar_lookups (created_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_lidar_lookups_lead ON lidar_lookups (lead_id)");
  }

  // Only ZIPs that belong to a territory of the pilot metro (Nashville) are looked up.
  async function zipAllowed(zip) {
    const z = String(zip || "").trim().slice(0, 5); if (!/^\d{5}$/.test(z)) return false;
    const { rows } = await pool.query("SELECT 1 FROM territory_zips z JOIN territories t ON t.id = z.territory_id WHERE z.zip = $1 AND t.metro ILIKE $2 LIMIT 1", [z, L.config().metro + "%"]);
    return rows.length > 0;
  }

  async function persist(row) {
    try {
      await pool.query(`INSERT INTO lidar_lookups (ref, mode, zip, address_hash, lat, lon, geocode_method, source, acquisition_start, acquisition_end, canopy_modes, status, reason, use_candidate,
        height_ft, low_ft, high_ft, uncertainty_ft, tier, photo_tier, photo_h_low, photo_h_high, age_years, candidates_json, elapsed_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [row.ref, row.mode, row.zip, row.address_hash, row.lat, row.lon, row.geocode_method, row.source, row.acquisition_start, row.acquisition_end, row.canopy_modes, row.status, (row.reason || "").slice(0, 400), !!row.use_candidate,
         row.height_ft, row.low_ft, row.high_ft, row.uncertainty_ft, row.tier_name, row.photo_tier == null ? null : core.TIER_NAMES[row.photo_tier], row.photo_h_low, row.photo_h_high, row.age_years == null ? null : row.age_years, JSON.stringify(row.candidates || []), row.elapsed_ms]);
      return true;
    } catch (e) { console.warn("[lidar] could not record lookup:", e.message); return false; }
  }

  // Called when a lead is stored: attaches the lookups the page quoted from, so the admin can see why a height was used or skipped.
  async function linkToLead(leadId, trees) {
    try {
      const refs = (Array.isArray(trees) ? trees : []).map((t) => t && t.lidar_ref).filter((r) => typeof r === "string" && /^[0-9a-f]{20}$/.test(r));
      if (refs.length) await pool.query("UPDATE lidar_lookups SET lead_id = $1 WHERE ref = ANY($2) AND lead_id IS NULL", [leadId, refs]);
    } catch (e) { console.warn("[lidar] could not link lookups:", e.message); }
  }

  // Page reports the photo-only range ("shown": what the quote is without aerial data) and what the aerial height would give. First write wins.
  app.post("/api/lidar/outcome", limiter, express.json({ limit: "4kb" }), async (req, res) => {
    const b = req.body || {}; if (typeof b.ref !== "string" || !/^[0-9a-f]{20}$/.test(b.ref)) return res.status(400).json({ error: "bad ref" });
    const s = b.shown || {}, a = b.aerial || {}, cat = (v) => (typeof v === "string" && core.TIER_NAMES.includes(v) ? v : null);
    try {
      const r = await pool.query(`UPDATE lidar_lookups SET photo_quote_low=$2, photo_quote_high=$3, photo_category=$4, aerial_quote_low=$5, aerial_quote_high=$6, aerial_category=$7, applied=$8, outcome_at=NOW()
        WHERE ref=$1 AND outcome_at IS NULL`, [b.ref, num(s.low), num(s.high), cat(s.category), num(a.low), num(a.high), cat(a.category), b.applied === true]);
      res.json({ recorded: r.rowCount > 0 });
    } catch (e) { res.status(500).json({ error: "not recorded" }); }
  });

  app.get("/api/admin/lidar/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(await L.status());
  });

  app.get("/api/admin/lidar/lookups", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    try {
      const { rows } = await pool.query(`SELECT id, ref, lead_id, created_at, mode, zip, lat, lon, geocode_method, source, acquisition_end, status, reason, use_candidate, height_ft, low_ft, high_ft, uncertainty_ft,
          tier, photo_tier, photo_h_low, photo_h_high, age_years, candidates_json, elapsed_ms, photo_quote_low, photo_quote_high, photo_category, aerial_quote_low, aerial_quote_high, aerial_category, applied
        FROM lidar_lookups ORDER BY id DESC LIMIT $1`, [limit]);
      const by = {}; let usable = 0, changed = 0;
      for (const r of rows) {
        by[r.status || "none"] = (by[r.status || "none"] || 0) + 1; if (r.use_candidate) usable++;
        if (r.use_candidate && r.aerial_quote_low != null && (r.aerial_quote_low !== r.photo_quote_low || r.aerial_quote_high !== r.photo_quote_high)) changed++;
        try { r.candidates = JSON.parse(r.candidates_json || "[]"); } catch (e) { r.candidates = []; } delete r.candidates_json;
      }
      res.json({ total: rows.length, by_status: by, usable, would_change_quote: changed, lookups: rows });
    } catch (e) { res.status(500).json({ error: "Could not read lookups." }); }
  });

  // Lookups that never became a lead are not kept: 30 days.
  const purge = () => pool.query("DELETE FROM lidar_lookups WHERE lead_id IS NULL AND created_at < NOW() - INTERVAL '30 days'").catch(() => {});
  function startPurge() { purge(); setInterval(purge, 6 * 3600e3).unref(); }

  return { schema, zipAllowed, persist, linkToLead, startPurge };
};

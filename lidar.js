"use strict";
/*
 * lidar.js — runtime side of the aerial (USGS 3DEP LiDAR) height check. Nashville-only, flag-controlled, never blocks a quote.
 *
 *   LIDAR_MODE   off (default) | log | price
 *       off   : nothing runs; /api/analyze behaves exactly as before.
 *       log   : the lookup runs and is recorded, the page is told what it WOULD do, the homeowner's price is never changed.
 *       price : same, and the page narrows the height-driven part of the range when use_candidate is true.
 *   LIDAR_CHM_DIR  folder with manifest.json + chm_*.tif made by tools/lidar/prepare_chm.py   (or)
 *   LIDAR_CHM_URL  https base URL of the same files (S3/R2/any static host that supports HTTP range requests)
 *   LIDAR_TIMEOUT_MS      total budget for geocode + tile read + decision (default 2500). Slow = fall back to the photo estimate.
 *   LIDAR_MAX_AGE_YEARS   survey older than this is "stale" and never used (default 6)
 *   LIDAR_GEOCODER        census (default) | fixture   (fixture reads LIDAR_FIXTURE_GEOCODES, a JSON {"address lowercased": [lon,lat]}; tests only)
 *   LIDAR_METRO           metro name the lookup is allowed for (default Nashville); the request ZIP must belong to a territory of it
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./lidar-core");

let proj4 = null, GeoTIFF = null;
function libs() {
  if (!proj4) { proj4 = require("proj4"); proj4.defs("EPSG:26916", "+proj=utm +zone=16 +datum=NAD83 +units=m +no_defs"); }
  if (!GeoTIFF) GeoTIFF = require("geotiff");
  return { proj4, GeoTIFF };
}

function config() {
  const e = process.env, mode = ["off", "log", "price"].includes((e.LIDAR_MODE || "").toLowerCase()) ? e.LIDAR_MODE.toLowerCase() : "off";
  return {
    mode, dir: e.LIDAR_CHM_DIR || "", url: (e.LIDAR_CHM_URL || "").replace(/\/+$/, ""), timeoutMs: Math.max(200, parseInt(e.LIDAR_TIMEOUT_MS || "2500", 10) || 2500),
    maxAgeYears: parseFloat(e.LIDAR_MAX_AGE_YEARS || "6") || 6, geocoder: (e.LIDAR_GEOCODER || "census").toLowerCase(), fixture: e.LIDAR_FIXTURE_GEOCODES || "",
    metro: e.LIDAR_METRO || "Nashville",
  };
}
const enabled = () => config().mode !== "off";

// ---------- manifest + tiles (cached in memory) ----------
let manifestCache = { key: "", at: 0, value: null };
async function readText(src) {
  if (/^https?:/i.test(src)) { const r = await fetch(src); if (!r.ok) throw new Error("HTTP " + r.status + " for " + src); return r.text(); }
  return fs.promises.readFile(src, "utf8");
}
async function loadManifest(cfg) {
  const base = cfg.dir || cfg.url; if (!base) throw new Error("LIDAR_CHM_DIR or LIDAR_CHM_URL is not set");
  const key = base;
  if (manifestCache.key === key && Date.now() - manifestCache.at < 10 * 60 * 1000 && manifestCache.value) return manifestCache.value;
  const src = cfg.dir ? path.join(cfg.dir, "manifest.json") : cfg.url + "/manifest.json";
  const m = JSON.parse(await readText(src));
  if (!m || m.kind !== "canopy_height_model" || !Array.isArray(m.tiles) || !m.source) throw new Error("manifest.json is not a CanopyBid CHM manifest");
  m._index = new Map(m.tiles.map((t) => [t.e + "_" + t.n, t]));
  manifestCache = { key, at: Date.now(), value: m };
  return m;
}
const tileHandles = new Map();
async function openTile(cfg, file) {
  const k = (cfg.dir || cfg.url) + "|" + file;
  if (tileHandles.has(k)) return tileHandles.get(k);
  const { GeoTIFF: G } = libs();
  const p = (cfg.dir ? G.fromFile(path.join(cfg.dir, file)) : G.fromUrl(cfg.url + "/" + file)).then((t) => t.getImage());
  tileHandles.set(k, p); if (tileHandles.size > 64) tileHandles.delete(tileHandles.keys().next().value);
  p.catch(() => tileHandles.delete(k));
  return p;
}
// Returns a grid window (metres above ground, NaN = no data) covering +-radius around a UTM point, stitched across tiles.
async function readGrid(cfg, man, cx, cy, radiusM) {
  const res = man.resolution_m || 1, T = man.tile_size_m || 1000;
  const x0 = Math.floor(cx - radiusM), x1 = Math.ceil(cx + radiusM), y0 = Math.floor(cy - radiusM), y1 = Math.ceil(cy + radiusM);
  const w = Math.round((x1 - x0) / res), h = Math.round((y1 - y0) / res), data = new Float32Array(w * h).fill(NaN);
  for (let E = Math.floor(x0 / T); E <= Math.floor((x1 - 1e-9) / T); E++) for (let N = Math.floor(y0 / T); N <= Math.floor((y1 - 1e-9) / T); N++) {
    const t = man._index.get(E + "_" + N); if (!t) continue;
    const img = await openTile(cfg, t.file), nodata = man.nodata == null ? 65535 : man.nodata;
    const tx0 = Math.max(x0, E * T), tx1 = Math.min(x1, E * T + T), ty0 = Math.max(y0, N * T), ty1 = Math.min(y1, N * T + T);
    const cw = Math.round((tx1 - tx0) / res), ch = Math.round((ty1 - ty0) / res); if (cw <= 0 || ch <= 0) continue;
    const c0 = Math.round((tx0 - E * T) / res), r0 = Math.round((N * T + T - ty1) / res);
    const ras = await img.readRasters({ window: [c0, r0, c0 + cw, r0 + ch], samples: [0], interleave: true });
    for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) {
      const v = ras[r * cw + c]; if (v === nodata) continue;
      const gr = Math.round((y1 - ty1) / res) + r, gc = Math.round((tx0 - x0) / res) + c;
      data[gr * w + gc] = v / 100;
    }
  }
  return { data, w, h, res, x0, y0: y1 };
}

// ---------- geocoding (server side; the browser never sends coordinates, only the address CanopyBid already collects) ----------
const geoCache = new Map();
async function geocode(cfg, address, zip, signal) {
  const addr = String(address || "").trim(); if (!addr) return null;
  const key = (addr + "|" + (zip || "")).toLowerCase();
  const hit = geoCache.get(key); if (hit && hit.at > Date.now() - 24 * 3600e3) return hit.value;
  let value = null;
  if (cfg.geocoder === "fixture") {
    const map = cfg.fixture ? JSON.parse(await fs.promises.readFile(cfg.fixture, "utf8")) : {};
    const hit2 = map[addr.toLowerCase()]; if (hit2) value = { lon: hit2[0], lat: hit2[1], method: "fixture", matched: addr };
  } else {
    const q = /\b\d{5}\b/.test(addr) || !zip ? addr : addr + " " + zip;
    const url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(q);
    const r = await fetch(url, { signal }); if (!r.ok) throw new Error("geocoder HTTP " + r.status);
    const j = await r.json(), m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (m && m.coordinates) value = { lon: m.coordinates.x, lat: m.coordinates.y, method: "census_address_range", matched: m.matchedAddress };
  }
  if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value);
  geoCache.set(key, { at: Date.now(), value });
  return value;
}

const sha = (s) => crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex").slice(0, 16);
const newRef = () => crypto.randomBytes(10).toString("hex");

/*
 * start({address, zip, zipAllowed}) -> Promise of the photo-independent part (geocode + CHM window). Never rejects.
 * finish(pre, photo, {now}) -> the decision row + the block returned to the page.
 */
function start({ address, zip, zipAllowed }) {
  const cfg = config(), t0 = Date.now();
  const run = (async () => {
    if (cfg.mode === "off") return null;
    if (zipAllowed && !(await zipAllowed(zip))) return null;            // not a Nashville ZIP: do nothing, record nothing
    const out = { cfg, t0, address_hash: sha(address), zip: zip || null, geo: null, grid: null, man: null, error: null, status: null, reason: "" };
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    try {
      out.man = await loadManifest(cfg);
      const geo = await geocode(cfg, address, zip, ac.signal);
      if (!geo) { out.status = "geocode_failed"; out.reason = "address could not be geocoded"; return out; }
      out.geo = geo;
      const { proj4: P } = libs(); const [cx, cy] = P("EPSG:4326", "EPSG:26916", [geo.lon, geo.lat]);
      out.cx = cx; out.cy = cy;
      const bb = out.man.bbox_lonlat;
      if (bb && (geo.lon < bb[0] || geo.lon > bb[2] || geo.lat < bb[1] || geo.lat > bb[3])) { out.status = "no_data"; out.reason = "geocoded point is outside the prepared LiDAR area"; return out; }
      out.grid = await readGrid(cfg, out.man, cx, cy, core.DEFAULTS.searchRadiusM + 20);
    } catch (e) {
      out.status = ac.signal.aborted ? "timeout" : "error"; out.reason = String(e && e.message || e).slice(0, 200);
    } finally { clearTimeout(timer); }
    return out;
  })().catch((e) => ({ cfg, t0, status: "error", reason: String(e && e.message || e).slice(0, 200) }));
  return { promise: run, cfg, t0 };
}

async function finish(handle, photo, opts = {}) {
  const cfg = handle.cfg, remaining = Math.max(50, cfg.timeoutMs - (Date.now() - handle.t0));
  let pre = await Promise.race([handle.promise, new Promise((r) => setTimeout(() => r({ cfg, t0: handle.t0, status: "timeout", reason: "aerial lookup did not finish in time" }), remaining))]);
  if (!pre) return null;
  const man = pre.man, src = man && man.source || {};
  const row = {
    ref: newRef(), mode: cfg.mode, zip: pre.zip || null, address_hash: pre.address_hash || null,
    lat: pre.geo ? +pre.geo.lat.toFixed(6) : null, lon: pre.geo ? +pre.geo.lon.toFixed(6) : null, geocode_method: pre.geo ? pre.geo.method : null,
    source: src.project || src.name || null, acquisition_start: src.acquisition_start || null, acquisition_end: src.acquisition_end || null,
    canopy_modes: man && man.canopy_modes ? man.canopy_modes.join(",") : null,
    photo_h_low: photo && photo.h_low || null, photo_h_high: photo && photo.h_high || null,
    status: pre.status || null, reason: pre.reason || "", use_candidate: false, height_ft: null, low_ft: null, high_ft: null, uncertainty_ft: null,
    tier: null, tier_name: null, photo_tier: null, candidates: [], elapsed_ms: Date.now() - handle.t0,
  };
  if (!pre.status && pre.grid) {
    const cands = core.findCandidates(pre.grid, pre.cx, pre.cy);
    const coverage = core.coverageFraction(pre.grid, pre.cx, pre.cy, 30);
    const d = core.decide({ candidates: cands, photo, acquisitionEnd: src.acquisition_end, now: opts.now, coverage, opts: { maxAgeYears: cfg.maxAgeYears } });
    row.candidates = cands.slice(0, 6).map((c) => ({ height_ft: c.height_ft, dist_m: c.dist_m, crown_diam_m: c.crown_diam_m }));
    Object.assign(row, { status: d.status, reason: d.reason, use_candidate: !!d.use_candidate, height_ft: d.height_ft, low_ft: d.low_ft, high_ft: d.high_ft, uncertainty_ft: d.uncertainty_ft, tier: d.tier, tier_name: d.tier_name, photo_tier: d.photo_tier });
    row.age_years = d.age_years;
  }
  row.elapsed_ms = Date.now() - handle.t0;
  // What the page is told. Never includes coordinates or the address.
  row.page = { mode: cfg.mode, ref: row.ref, status: row.status, use_candidate: row.mode === "off" ? false : !!row.use_candidate, height_ft: row.height_ft, low_ft: row.low_ft, high_ft: row.high_ft, tier: row.tier, tier_name: row.tier_name, source: row.source, acquisition_end: row.acquisition_end };
  return row;
}

async function status() {
  const cfg = config(); const out = { mode: cfg.mode, geocoder: cfg.geocoder, timeout_ms: cfg.timeoutMs, max_age_years: cfg.maxAgeYears, metro: cfg.metro, source_configured: !!(cfg.dir || cfg.url), source_kind: cfg.dir ? "directory" : cfg.url ? "url" : null };
  if (cfg.dir || cfg.url) {
    try { const m = await loadManifest(cfg); const age = core.yearsSince(m.source.acquisition_end); Object.assign(out, { manifest_ok: true, project: m.source.project, acquisition_start: m.source.acquisition_start, acquisition_end: m.source.acquisition_end, leaf_condition: m.source.leaf_condition, age_years: age == null ? null : +age.toFixed(2), stale: age == null || age > cfg.maxAgeYears, tiles: m.tiles.length, bbox_lonlat: m.bbox_lonlat, canopy_modes: m.canopy_modes, prepared: m.created }); }
    catch (e) { out.manifest_ok = false; out.manifest_error = String(e.message || e).slice(0, 200); }
  }
  return out;
}
const _reset = () => { manifestCache = { key: "", at: 0, value: null }; tileHandles.clear(); geoCache.clear(); };
module.exports = { config, enabled, start, finish, status, _reset };

"use strict";
/*
 * lidar-core.js — pure logic for the aerial (3DEP LiDAR) height check. No I/O, no network, no database.
 *
 * Input is a small window of a canopy height model (CHM, metres above ground, NaN = no data) around the geocoded
 * address. This file finds individual tree crowns in it, decides whether ONE of them can be confidently matched to the
 * tree in the homeowner's photo, and decides whether the height is precise enough to pick a single existing price tier.
 *
 * Tiers are exactly the site's height buckets: <30 ft small, <50 medium, <75 large, <100 xl, else exceptional.
 */
const M_TO_FT = 3.280839895;
const TIER_EDGES_FT = [30, 50, 75, 100];
const TIER_NAMES = ["small", "medium", "large", "xl", "exceptional"];

const DEFAULTS = {
  minTreeM: 3.0,            // ignore anything shorter than ~10 ft (shrubs, fences, cars)
  searchRadiusM: 40,        // candidates farther than this from the geocoded point are ignored
  strongRadiusM: 30,        // a "strong" match must be this close (street-interpolated geocodes are not parcel-accurate)
  mergeRatio: 0.85,         // two peaks are one crown when the saddle between them is >= this share of the lower peak
  mergeDistM: 2.5,          // ...or when they are closer than this
  widthTolFrac: 0.3,        // crown-width tie-break: photo width range widened by this share of its midpoint ...
  widthTolFt: 6,            // ... plus this many feet (both measurements are rough)
  uncertBaseFt: 1.5,        // height uncertainty = base + perFt * height + perYear * years since acquisition
  uncertPerFt: 0.03,
  uncertPerYearFt: 0.5,     // trees keep growing/being cut after the flight
  maxAgeYears: 6,           // older than this -> "stale", never used
  heightTolFrac: 0.15,      // photo height range is widened by this share of its midpoint plus tolFt before comparing
  heightTolFt: 3,
  ambiguityGapM: 15,        // two consistent crowns inside strongRadiusM whose distances differ by less than this cannot be told apart
};

function tierOfFt(h) { let i = 0; while (i < TIER_EDGES_FT.length && h >= TIER_EDGES_FT[i]) i++; return i; }
function tierBounds(i) { return [i === 0 ? 0 : TIER_EDGES_FT[i - 1], i >= TIER_EDGES_FT.length ? Infinity : TIER_EDGES_FT[i]]; }

function yearsSince(dateStr, now) {
  const t = Date.parse(dateStr); if (!isFinite(t)) return null;
  return Math.max(0, ((now ? +now : Date.now()) - t) / (365.25 * 86400000));
}
function heightUncertaintyFt(hFt, ageYears, p) {
  p = Object.assign({}, DEFAULTS, p || {});
  return p.uncertBaseFt + p.uncertPerFt * hFt + p.uncertPerYearFt * (ageYears || 0);
}

// grid = { data: Float32Array|number[] (metres, NaN = none), w, h, res (m), x0, y0 (UTM easting of col 0, northing of row 0 = top edge) }
function smooth3(g) {
  const { data, w, h } = g, out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let s = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const v = data[rr * w + cc]; s += isFinite(v) ? v : 0; n++;
    }
    out[r * w + c] = n ? s / n : 0;
  }
  return out;
}

function findCandidates(g, cx, cy, opts) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  const { data, w, h, res } = g, sm = smooth3(g), N = w * h;
  const label = new Int32Array(N).fill(-1), peakOf = new Int32Array(N).fill(-1);
  const nb = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const climb = (i) => {                        // steepest ascent to a local maximum
    const path = []; let cur = i;
    for (let guard = 0; guard < 4000; guard++) {
      if (peakOf[cur] >= 0) { cur = peakOf[cur]; break; }
      path.push(cur);
      const r = (cur / w) | 0, c = cur % w; let best = cur, bv = sm[cur];
      for (const [dr, dc] of nb) {
        const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const j = rr * w + cc, v = sm[j];
        if (v > bv || (v === bv && j > best)) { best = j; bv = v; }
      }
      if (best === cur) break;
      cur = best;
    }
    for (const q of path) peakOf[q] = cur;
    return cur;
  };
  for (let i = 0; i < N; i++) if (sm[i] >= p.minTreeM) label[i] = climb(i);
  const peaks = new Map();                       // peak index -> {z}
  for (let i = 0; i < N; i++) if (label[i] >= 0 && !peaks.has(label[i])) peaks.set(label[i], sm[label[i]]);
  // union-find over peaks
  const parent = new Map([...peaks.keys()].map((k) => [k, k]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const saddle = new Map();
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c, a = label[i]; if (a < 0) continue;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const rr = r + dr, cc = c + dc; if (rr >= h || cc < 0 || cc >= w) continue;
      const j = rr * w + cc, b = label[j]; if (b < 0 || b === a) continue;
      const key = a < b ? a + "_" + b : b + "_" + a, s = Math.min(sm[i], sm[j]);
      if (!(saddle.get(key) >= s)) saddle.set(key, s);
    }
  }
  const pk = (idx) => ({ r: (idx / w) | 0, c: idx % w });
  for (const [key, s] of saddle) {
    const [a, b] = key.split("_").map(Number), za = peaks.get(a), zb = peaks.get(b);
    const pa = pk(a), pb = pk(b), d = Math.hypot(pa.r - pb.r, pa.c - pb.c) * res;
    if (s >= p.mergeRatio * Math.min(za, zb) || d < p.mergeDistM) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  }
  const groups = new Map();
  for (let i = 0; i < N; i++) if (label[i] >= 0) { const root = find(label[i]); (groups.get(root) || groups.set(root, []).get(root)).push(i); }
  const out = [];
  for (const cells of groups.values()) {
    let top = cells[0]; for (const i of cells) if (sm[i] > sm[top]) top = i;
    const tr = (top / w) | 0, tc = top % w;
    let raw = 0;                                  // unsmoothed tallest return within 1 cell of the smoothed top
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = tr + dr, cc = tc + dc; if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const v = data[rr * w + cc]; if (isFinite(v) && v > raw) raw = v;
    }
    if (raw < p.minTreeM) continue;
    const half = 0.5 * sm[top]; let area = 0; for (const i of cells) if (sm[i] >= half) area++;
    const x = g.x0 + (tc + 0.5) * res, y = g.y0 - (tr + 0.5) * res;
    out.push({ x, y, height_m: +raw.toFixed(2), height_ft: +(raw * M_TO_FT).toFixed(1), crown_diam_m: +(2 * Math.sqrt((area * res * res) / Math.PI)).toFixed(1), dist_m: +Math.hypot(x - cx, y - cy).toFixed(1) });
  }
  return out.filter((c) => c.dist_m <= p.searchRadiusM).sort((a, b) => a.dist_m - b.dist_m);
}

function coverageFraction(g, cx, cy, radiusM) {
  let n = 0, ok = 0;
  const r0 = Math.max(0, Math.floor((g.y0 - (cy + radiusM)) / g.res)), r1 = Math.min(g.h - 1, Math.ceil((g.y0 - (cy - radiusM)) / g.res));
  const c0 = Math.max(0, Math.floor((cx - radiusM - g.x0) / g.res)), c1 = Math.min(g.w - 1, Math.ceil((cx + radiusM - g.x0) / g.res));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { n++; if (isFinite(g.data[r * g.w + c])) ok++; }
  return n ? ok / n : 0;
}

/*
 * decide({candidates, photo:{h_low,h_high}|null, acquisitionEnd, now, coverage, opts})
 * -> { status, use_candidate, reason, chosen, height_ft, low_ft, high_ft, uncertainty_ft, tier, tier_name, photo_tier, consistent, age_years }
 * status: strong | weak | multiple | disagrees | no_tree | no_data | stale | no_photo
 */
function decide({ candidates, photo, acquisitionEnd, now, coverage, opts }) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  const age = yearsSince(acquisitionEnd, now);
  const base = { status: "no_data", use_candidate: false, reason: "", chosen: null, height_ft: null, low_ft: null, high_ft: null, uncertainty_ft: null, tier: null, tier_name: null, photo_tier: null, consistent: 0, age_years: age == null ? null : +age.toFixed(2), all_same_tier: null };
  let wnote = "";
  const fin = (o) => Object.assign(base, o, wnote && o.reason ? { reason: o.reason + wnote } : {});
  if (age == null) return fin({ status: "no_data", reason: "acquisition date unknown" });
  if (age > p.maxAgeYears) return fin({ status: "stale", reason: `survey is ${age.toFixed(1)} years old (limit ${p.maxAgeYears})` });
  if (coverage != null && coverage < 0.5) return fin({ status: "no_data", reason: "address is outside or at the edge of the processed LiDAR area" });
  if (!candidates || !candidates.length) return fin({ status: "no_tree", reason: `no canopy taller than ${(p.minTreeM * M_TO_FT).toFixed(0)} ft within ${p.searchRadiusM} m of the address` });
  if (!photo || !(photo.h_low > 0) || !(photo.h_high >= photo.h_low)) return fin({ status: "no_photo", reason: "photo analysis gave no height range to confirm the match" });
  const mid = (photo.h_low + photo.h_high) / 2, tol = p.heightTolFrac * mid + p.heightTolFt;
  const lo = photo.h_low - tol, hi = photo.h_high + tol;
  const photoTier = tierOfFt(mid);
  const withU = candidates.map((c) => { const u = heightUncertaintyFt(c.height_ft, age, p); return Object.assign({}, c, { u_ft: +u.toFixed(1), low_ft: +(c.height_ft - u).toFixed(1), high_ft: +(c.height_ft + u).toFixed(1), consistent: c.height_ft >= lo && c.height_ft <= hi }); });
  let cons = withU.filter((c) => c.consistent);
  // Second check when several crowns fit the height: the photo's crown-width estimate vs the crown width measured from above. Both are rough, so the
  // tolerance is wide, and it is only used to break a tie (if nothing fits the width, or everything does, the height-only set stands).
  if (cons.length > 1 && photo.w_low > 0 && photo.w_high >= photo.w_low) {
    const wmid = (photo.w_low + photo.w_high) / 2, wtol = p.widthTolFrac * wmid + p.widthTolFt, wlo = photo.w_low - wtol, whi = photo.w_high + wtol;
    const wc = cons.filter((c) => { const w = c.crown_diam_m * M_TO_FT; return w >= wlo && w <= whi; });
    if (wc.length && wc.length < cons.length) { wnote = ` [crown width ${photo.w_low}-${photo.w_high} ft narrowed ${cons.length} height matches to ${wc.length}]`; cons = wc; base.width_narrowed = true; }
  }
  base.photo_tier = photoTier; base.consistent = cons.length;
  const describe = (c) => { const t0 = tierOfFt(c.low_ft), t1 = tierOfFt(c.high_ft); return { chosen: c, height_ft: c.height_ft, low_ft: c.low_ft, high_ft: c.high_ft, uncertainty_ft: c.u_ft, tier: t0 === t1 ? t0 : tierOfFt(c.height_ft), tier_name: TIER_NAMES[t0 === t1 ? t0 : tierOfFt(c.height_ft)], single_tier: t0 === t1 }; };
  if (!cons.length) return fin({ status: "disagrees", reason: `${withU.length} crown(s) nearby but none within ${lo.toFixed(0)}–${hi.toFixed(0)} ft (photo range ±tolerance); tallest ${Math.max(...withU.map((c) => c.height_ft)).toFixed(0)} ft` });
  const near = cons.filter((c) => c.dist_m <= p.strongRadiusM);
  if (near.length > 1 && near[1].dist_m - near[0].dist_m < p.ambiguityGapM) {
    const tiers = near.map((c) => (tierOfFt(c.low_ft) === tierOfFt(c.high_ft) ? tierOfFt(c.low_ft) : -1));
    const same = tiers[0] !== -1 && tiers.every((t) => t === tiers[0]);
    return fin(Object.assign(describe(near[0]), { status: "multiple", all_same_tier: same, reason: `${near.length} plausible crowns (${near.map((c) => c.height_ft.toFixed(0) + " ft @ " + c.dist_m + " m, crown " + (c.crown_diam_m * M_TO_FT).toFixed(0) + " ft wide").join("; ")}); cannot tell which one is the photographed tree` + (photo.w_low > 0 ? ` (photo crown width ${photo.w_low}-${photo.w_high} ft)` : " (photo gave no crown width)") }));
  }
  const c = cons[0], d = describe(c), nearestAny = withU[0];
  if (nearestAny !== c && nearestAny.height_ft >= p.minTreeM * M_TO_FT) {
    return fin(Object.assign(d, { status: "weak", reason: `the one consistent crown is ${c.dist_m} m away but a different, inconsistent crown is closer (${nearestAny.dist_m} m, ${nearestAny.height_ft.toFixed(0)} ft)` }));
  }
  if (c.dist_m > p.strongRadiusM) return fin(Object.assign(d, { status: "weak", reason: `only consistent crown is ${c.dist_m} m from the geocoded point (strong match needs <= ${p.strongRadiusM} m)` }));
  if (!d.single_tier) return fin(Object.assign(d, { status: "strong", use_candidate: false, reason: `matched a single crown (${c.height_ft.toFixed(0)} ft ±${c.u_ft}) but its uncertainty straddles a price-tier breakpoint (${c.low_ft.toFixed(0)}–${c.high_ft.toFixed(0)} ft)` }));
  return fin(Object.assign(d, { status: "strong", use_candidate: true, reason: `single matching crown ${c.height_ft.toFixed(0)} ft ±${c.u_ft} (${c.low_ft.toFixed(0)}–${c.high_ft.toFixed(0)} ft) inside the ${d.tier_name} tier, ${c.dist_m} m from the address` }));
}


/* ---- parcel helpers: rings are arrays of [x, y] in the same metric CRS as the crowns ---- */
function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToRings(x, y, rings) {
  let best = Infinity;
  for (const ring of rings) for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}
/* Crowns whose top is on the parcel or within bufferM of its edge (a trunk just over the line is still "next to" the lot). */
function filterToParcel(cands, rings, bufferM = 4) {
  if (!rings || !rings.length) return cands;
  return cands.filter((c) => pointInRings(c.x, c.y, rings) || distToRings(c.x, c.y, rings) <= bufferM);
}

/* ---- pricing helpers: mirror the site's rules so server tests and the admin report can show what the aerial height would do ---- */
const NASHVILLE_REMOVAL = [[400, 750], [750, 1500], [1400, 3000], [2750, 5500], [5000, 10000]];
const dbhBucket = (d) => (d < 12 ? 0 : d < 24 ? 1 : d < 36 ? 2 : d < 48 ? 3 : 4);
const categoryIdx = (hB, dB) => (hB > dB ? Math.min(hB, dB + 1) : dB);   // diameter-led, same as the site
function quote({ hBucket, dbhMid, territoryFactor = 1.04, accessPct = 0, confWidth = 0.25 }) {
  const idx = categoryIdx(hBucket, dbhBucket(dbhMid)), r = NASHVILLE_REMOVAL[idx], mid = ((r[0] + r[1]) / 2) * territoryFactor * (1 + accessPct);
  return { category: TIER_NAMES[idx], low: Math.round(mid * (1 - confWidth)), high: Math.round(mid * (1 + confWidth)), width: confWidth };
}
/* Only the height-driven slice of the range is narrowed: the photo height range's own relative half-width is removed from the
 * total confidence width in quadrature, and what is left (diameter, scale, view quality) stays, with a floor. */
function narrowedWidth(confWidth, photoLow, photoHigh, floor = 0.15) {
  const hs = photoHigh + photoLow > 0 ? (photoHigh - photoLow) / (photoHigh + photoLow) : 0;
  return Math.max(floor, Math.sqrt(Math.max(0, confWidth * confWidth - hs * hs)));
}

module.exports = { pointInRings, distToRings, filterToParcel, DEFAULTS, TIER_EDGES_FT, TIER_NAMES, M_TO_FT, tierOfFt, tierBounds, yearsSince, heightUncertaintyFt, smooth3, findCandidates, coverageFraction, decide, dbhBucket, categoryIdx, quote, narrowedWidth, NASHVILLE_REMOVAL };

// Homeowner-side additions: coverage check, waitlist, intake validation, "no response" reports, status payload.
// Everything here is additive: new tables/columns use IF NOT EXISTS, and the existing routing (ZIP -> territory -> eligible company) is reused, not duplicated.
module.exports = function initHomeowner({ app, pool, limiter, requireAdmin, R, ELIG_COLS, logAudit, sendEmail, FRONTEND_URL }) {
  const crypto = require("crypto");
  const LINK_DAYS = () => Number(process.env.LEAD_LINK_DAYS || 90);
  const ZIP = /^\d{5}$/;
  const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const pick = (v, allowed) => allowed.includes(v) ? v : undefined;

  async function schema() {
    await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS intake_json TEXT");
    await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS idempotency_key TEXT");
    await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS resume_issued_at TIMESTAMP");
    await pool.query("UPDATE leads SET resume_issued_at = created_at WHERE resume_issued_at IS NULL");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_idempotency ON leads (idempotency_key) WHERE idempotency_key IS NOT NULL");
    await pool.query(`CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY, zip TEXT NOT NULL, name TEXT, email TEXT, phone TEXT, note TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_waitlist_zip_email ON waitlist (zip, lower(email)) WHERE email IS NOT NULL");
    await pool.query(`CREATE TABLE IF NOT EXISTS lead_reports (
      id SERIAL PRIMARY KEY, lead_id INTEGER REFERENCES leads(id), kind TEXT NOT NULL, note TEXT, created_at TIMESTAMP DEFAULT NOW(), resolved INTEGER DEFAULT 0)`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_lead_reports_lead ON lead_reports(lead_id)");
  }

  // Status links expire LEAD_LINK_DAYS (default 90) after they were issued. Expired links stop working everywhere
  // (status page, report button, photo upload) and can be re-sent to the email on file with POST /api/leads/recover.
  function linkExpired(lead) {
    const t = new Date(lead.resume_issued_at || lead.created_at).getTime();
    return !t || t + LINK_DAYS() * 864e5 < Date.now();
  }
  // Link recovery. Three layers of limits, and the visitor can never tell whether the email exists:
  //  1) 10 requests per hour per visitor address (a dedicated limiter; the general one allows 60 per 15 min),
  //  2) at most one email per address every 5 minutes (in memory; resets if the server restarts),
  //  3) the answer is sent BEFORE any lookup or email work, so response time does not reveal anything.
  // Every valid-looking request gets the identical 200 answer, whether the email is unknown, known, or throttled.
  const recoverLimiter = require("express-rate-limit")({ windowMs: 3600e3, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests. Please wait and try again later." } });
  const recent = new Map();
  async function sendRecovery(email) {
    const { rows } = await pool.query("SELECT id, resume_token, resume_issued_at, created_at, name FROM leads WHERE lower(email) = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 3", [email]);
    const links = [];
    for (const l of rows) {
      let token = l.resume_token;
      if (!token || linkExpired(l)) {
        token = crypto.randomBytes(20).toString("hex");
        await pool.query("UPDATE leads SET resume_token = $1, resume_issued_at = NOW() WHERE id = $2", [token, l.id]);
      }
      links.push({ id: l.id, url: `${FRONTEND_URL}/status.html?t=${token}` });
    }
    if (links.length) await sendEmail({ to: email, subject: "Your CanopyBid request status link",
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#14261B"><p>Here ${links.length > 1 ? "are the links" : "is the link"} to check on your tree-service request${links.length > 1 ? "s" : ""}. Only open it on a device you trust.</p>${links.map(x => `<p><a href="${esc(x.url)}">Request #${x.id}</a></p>`).join("")}<p style="font-size:13px;color:#76856E">If you did not ask for this, ignore this email.</p></div>` });
  }
  app.post("/api/leads/recover", limiter, recoverLimiter, (req, res) => {
    const generic = { ok: true, message: "If we have a request under that email address, we have just sent the link to it. Check your spam folder too." };
    const email = clip((req.body || {}).email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter the email address you used." });
    res.json(generic);                                                     // answer first: same body and timing for every address
    const last = recent.get(email);
    if (last && Date.now() - last < 5 * 60e3) return;
    recent.set(email, Date.now()); if (recent.size > 5000) recent.clear();
    sendRecovery(email).catch(e => console.error("[recover] Failed:", e.message));
  });

  // Is this ZIP served right now? Same rule as lead routing: ZIP belongs to an OFFERED territory that has an ELIGIBLE company.
  // Returns only covered / not covered. Never returns company details or why (no internal state leaks).
  // 'covered' | 'not_covered' | 'needs_address_check'. A ZIP that is not wholly inside one territory (status other than 'assigned',
  // e.g. split or overlapping) can never be confirmed from the ZIP alone, so it is never reported as covered or auto-routed.
  async function coverageState(zip) {
    const t = (await pool.query("SELECT t.id, t.offered, t.company_id, z.status AS zip_status FROM territory_zips z JOIN territories t ON t.id = z.territory_id WHERE z.zip = $1", [zip])).rows[0];
    if (!t || t.offered !== 1 || !t.company_id || t.zip_status === "held") return "not_covered";
    if (t.zip_status !== "assigned") return "needs_address_check";
    const c = (await pool.query(`SELECT ${ELIG_COLS} FROM companies WHERE id = $1`, [t.company_id])).rows[0];
    return !!c && R.eligibility(c).eligible ? "covered" : "not_covered";
  }
  const covered = async zip => (await coverageState(zip)) === "covered";

  // 200 {status:'covered'|'not_covered'}, 400 {status:'invalid_zip'}, 503 {status:'lookup_failed'}.
  // The three are different on purpose: the site says "we don't serve you yet" only for not_covered, and "try again" for lookup_failed.
  app.get("/api/coverage", limiter, async (req, res) => {
    const zip = clip(req.query.zip, 10).match(/^(\d{5})(?:-\d{4})?$/);
    if (!zip) return res.status(400).json({ status: "invalid_zip", error: "Enter a 5-digit ZIP code." });
    try { res.json({ status: await coverageState(zip[1]), zip: zip[1] }); }
    catch (e) { console.error("[coverage] Failed:", e.message); res.status(503).json({ status: "lookup_failed", error: "We could not check coverage right now. Please try again." }); }
  });

  app.post("/api/waitlist", limiter, async (req, res) => {
    const b = req.body || {};
    const zip = clip(b.zip, 10).match(/^(\d{5})(?:-\d{4})?$/);
    const email = clip(b.email, 200).toLowerCase(), phone = clip(b.phone, 40);
    if (!zip) return res.status(400).json({ error: "Enter a 5-digit ZIP code." });
    if (!b.consent) return res.status(400).json({ error: "Please confirm we may contact you when we reach your area." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Add an email or a phone number." });
    try {
      await pool.query("INSERT INTO waitlist (zip, name, email, phone, note) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (zip, lower(email)) WHERE email IS NOT NULL DO NOTHING",
        [zip[1], clip(b.name, 120) || null, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null, phone || null, clip(b.note, 300) || null]);
      res.status(201).json({ ok: true });
    } catch (e) { console.error("[waitlist] Failed:", e.message); res.status(500).json({ error: "Could not save that right now." }); }
  });

  // Validates and normalises the extra job details. Unknown keys are dropped; strings are clipped; enums are whitelisted.
  function cleanIntake(i) {
    if (!i || typeof i !== "object") return null;
    const h = i.hazards || {}, a = i.access || {};
    const out = {
      v: 1,
      hazards: {
        power_lines: pick(h.power_lines, ["none", "near", "touching", "unsure"]),
        structure: pick(h.structure, ["none", "close", "touching", "unsure"]),
        leaning_or_cracked: h.leaning_or_cracked === true ? true : h.leaning_or_cracked === false ? false : undefined,
        storm_damage: h.storm_damage === true ? true : h.storm_damage === false ? false : undefined,
        emergency: h.emergency === true
      },
      safe_distance_photos: i.safe_distance_photos === true,
      coverage_check: pick(i.coverage_check, ["confirmed", "skipped"]),
      contact_method: pick(i.contact_method, ["phone", "text", "email"]),
      best_time: pick(i.best_time, ["anytime", "morning", "afternoon", "evening"]),
      access: { gate: a.gate === true, narrow: a.narrow === true, pets: a.pets === true, steep: a.steep === true, notes: clip(a.notes, 300) || undefined },
      hauling: pick(i.hauling, ["haul_all", "leave_wood", "leave_chips", "unsure"]),
      flexible_scheduling: i.flexible_scheduling === true,
      flexible_note: clip(i.flexible_note, 200) || undefined,
      estimate_scope_version: clip(i.estimate_scope_version, 20) || undefined
    };
    return JSON.parse(JSON.stringify(out));
  }
  // A hazard answer that makes a photo-only price unsafe or meaningless sends the lead to inspection, regardless of what the browser computed.
  function needsInspection(intake) {
    const h = (intake && intake.hazards) || {};
    return h.emergency === true || h.power_lines === "touching" || h.power_lines === "near" || h.structure === "touching" || h.leaning_or_cracked === true || h.storm_damage === true;
  }
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const HAUL = { haul_all: "Haul everything away", leave_wood: "Leave the wood", leave_chips: "Leave the wood chips", unsure: "Not sure yet" };
  const HAZ_PL = { near: "Power lines near the tree", touching: "Power lines touching or very close" }, HAZ_ST = { close: "Close to a structure", touching: "Touching a structure" };
  // Short plain-text lines for emails and lead cards.
  function intakeLines(intake) {
    if (!intake) return [];
    const L = [], h = intake.hazards || {};
    if (h.emergency) L.push("EMERGENCY reported by homeowner");
    if (HAZ_PL[h.power_lines]) L.push(HAZ_PL[h.power_lines]);
    if (HAZ_ST[h.structure]) L.push(HAZ_ST[h.structure]);
    if (h.leaning_or_cracked) L.push("Leaning or cracked");
    if (h.storm_damage) L.push("Storm damage");
    if (intake.contact_method) L.push("Prefers " + intake.contact_method + (intake.best_time && intake.best_time !== "anytime" ? ", " + intake.best_time : ""));
    const a = intake.access || [], ac = [a.gate && "gate", a.narrow && "narrow access", a.pets && "pets", a.steep && "steep"].filter(Boolean);
    if (ac.length) L.push("Access: " + ac.join(", "));
    if (a.notes) L.push("Access notes: " + a.notes);
    if (intake.hauling && HAUL[intake.hauling]) L.push("Debris: " + HAUL[intake.hauling]);
    if (intake.flexible_scheduling) L.push("Flexible on scheduling" + (intake.flexible_note ? ": " + intake.flexible_note : ""));
    return L;
  }

  // Homeowner tells us something is wrong with their request. Surfaced in the admin queue; one per kind per lead per day.
  app.post("/api/leads/resume/:token/report", limiter, async (req, res) => {
    const kind = pick((req.body || {}).kind, ["no_response", "wrong_info", "wrong_company", "cancel"]);
    if (!kind) return res.status(400).json({ error: "Choose what happened." });
    try {
      const lead = (await pool.query("SELECT id, resume_issued_at, created_at FROM leads WHERE resume_token = $1 AND deleted_at IS NULL", [req.params.token])).rows[0];
      if (!lead) return res.status(404).json({ error: "This link isn't valid." });
      if (linkExpired(lead)) return res.status(410).json({ error: "This link has expired.", expired: true });
      const recent = (await pool.query("SELECT 1 FROM lead_reports WHERE lead_id = $1 AND kind = $2 AND created_at > NOW() - INTERVAL '24 hours'", [lead.id, kind])).rows[0];
      if (!recent) {
        await pool.query("INSERT INTO lead_reports (lead_id, kind, note) VALUES ($1,$2,$3)", [lead.id, kind, clip((req.body || {}).note, 500) || null]);
        await pool.query("INSERT INTO lead_status_history (lead_id, status, changed_by, note) SELECT id, status, 'homeowner', $2 FROM leads WHERE id = $1", [lead.id, "Homeowner report: " + kind]);
      }
      res.json({ ok: true, message: "Thanks. We have flagged this for our team to review." });
    } catch (e) { console.error("[report] Failed:", e.message); res.status(500).json({ error: "Could not send that right now." }); }
  });

  // The confirmation/status page payload. Says plainly whether a company has been assigned.
  async function statusPayload(lead) {
    const history = (await pool.query("SELECT status, CASE WHEN changed_by LIKE 'company:%' THEN note END AS note, created_at FROM lead_status_history WHERE lead_id = $1 AND NOT (changed_by = 'homeowner' AND note LIKE 'Homeowner report:%') ORDER BY created_at ASC, id ASC", [lead.id])).rows;
    let company = null;
    if (lead.assigned_company_id) company = (await pool.query("SELECT name, phone FROM companies WHERE id = $1", [lead.assigned_company_id])).rows[0] || null;
    let intake = null; try { intake = lead.intake_json ? JSON.parse(lead.intake_json) : null; } catch (e) { /* ignore */ }
    const inspection = !!lead.inspection_required || needsInspection(intake);
    const reports = (await pool.query("SELECT kind, created_at FROM lead_reports WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5", [lead.id])).rows;
    let assignment, next;
    if (company) {
      assignment = { state: "assigned", company: { name: company.name, phone: company.phone || null } };
      next = [`${company.name} has your request and will contact you${intake && intake.contact_method ? " by " + intake.contact_method : ""}.`,
        inspection ? "They will want to look at the tree in person before giving a firm price." : "They will confirm the details and give you a final quote, usually after seeing the tree in person.",
        "The range you saw is a preliminary estimate, not a quote.", "If you do not hear back, use the button below and we will look into it."];
    } else if (intake && intake.coverage_check === "skipped" || lead.routing_reason === "zip_overlap_review") {
      assignment = { state: "unconfirmed", company: null };
      next = ["We could not confirm that your address is in an area we serve, so your request has NOT been sent to any company and we cannot promise service.",
        "Our team will check your address by hand. If we can serve you, this page will show who has your request; if not, we will let you know.", "Nothing is being charged and no company has your details."];
    } else if (["zip_unassigned", "territory_draft"].includes(lead.routing_reason) || (lead.routing_status === "unassigned" && lead.routing_reason === "zip_missing")) {
      assignment = { state: "not_covered", company: null };
      next = ["We do not have a partner company for your ZIP code yet, so your request has not been sent to anyone.", "We keep your details so we can reach out if that changes."];
    } else {
      assignment = { state: "pending", company: null };
      next = ["Your request is saved, but no company has been assigned yet.", "A member of our team reviews requests that cannot be matched automatically. Check this page for updates.", "Nothing is being charged and no company has your details until one is assigned."];
    }
    return {
      name: lead.name, address: lead.address, status: lead.status, created_at: lead.created_at,
      quote_low: lead.quote_low, quote_high: lead.quote_high, inspection_required: inspection,
      services: JSON.parse(lead.services || "[]"), history, assignment, next_steps: next,
      details: { timeframe: lead.timeframe || null, contact_method: intake && intake.contact_method || null, best_time: intake && intake.best_time || null, hauling: intake && intake.hauling || null, flexible_scheduling: !!(intake && intake.flexible_scheduling) },
      reported: reports
    };
  }

  return { schema, linkExpired, coverageState, cleanIntake, needsInspection, intakeLines, statusPayload, covered, esc };
};

// Partner applications: a company is vetted BEFORE it can pay or bid.
//
// Flow
//   1. POST /api/applications            a tree company applies (self-reported details + the services/market it covers).
//                                        It gets a private STATUS link (view progress, upload documents). No payment link yet.
//   2. POST /api/applications/documents  it uploads the documents its market/services require (see requirements.js).
//   3. Admin verifies each document (/api/admin/applications/:id/verify), then approves (/decide).
//      Approval is REFUSED until every required document is verified and unexpired. Only then is a PAYMENT link issued.
//   4. The payment link (?partner=<token>) is what /api/checkout/create and /api/bids/create require.
//
// Link security
//   * 192-bit random tokens, stored only as SHA-256 hashes (a database leak does not leak usable links).
//   * The payment link expires (APPROVAL_LINK_DAYS, default 14), can be revoked or re-issued (re-issuing kills the old one),
//     and stops working if a required document is rejected or expires.
//   * One account per approval: once a company has been created from an application, the link cannot create another.
//   * The vetted identity (name, email, phone) comes from the application, never from the browser.
//   * Existing partners are identified by their API key instead of a link; they must still be eligible to receive leads.
// Set REQUIRE_COMPANY_APPROVAL=0 to switch the gate off (compatibility mode for the older site while deploying).
const crypto = require("crypto");
const R = require("./requirements");

module.exports = function initApplications(d) {
  const { app, pool, requireAdmin, limiter, logAudit, sendEmail, FRONTEND_URL, authCompany } = d;
  const REQUIRED = String(process.env.REQUIRE_COMPANY_APPROVAL || "1") !== "0";
  const LINK_DAYS = Number(process.env.APPROVAL_LINK_DAYS || 14);
  const STATUS_DAYS = 90;
  const MAX_DOC_BYTES = 6 * 1024 * 1024;
  const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "";
  const DAY = 24 * 3600 * 1000;
  const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ""));
  const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hash = t => crypto.createHash("sha256").update(String(t)).digest("hex");
  const newToken = () => crypto.randomBytes(24).toString("hex");
  const payLink = t => `${FRONTEND_URL}/canopybid-companies.html?partner=${t}`;
  const statusLink = t => `${FRONTEND_URL}/canopybid-companies.html?application=${t}`;
  const DOC_COLS = ["doc", "media_type", "filename", "status", "uploaded_at", "expiration", "verified_at"];
  const KNOWN_SERVICES = ["Removal", "Trimming / pruning", "Stump grinding", "Storm damage cleanup"];

  async function schema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS company_applications (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'application',
      name TEXT NOT NULL, contact_name TEXT, email TEXT NOT NULL, phone TEXT,
      market TEXT, services TEXT,
      license_number TEXT, insurance_carrier TEXT, crew_count INTEGER, notes TEXT,
      required_docs TEXT,
      license_doc TEXT, license_media_type TEXT, license_filename TEXT, license_status TEXT DEFAULT 'not_uploaded',
      license_uploaded_at TIMESTAMP, license_expiration DATE, license_verified_at TIMESTAMP,
      insurance_doc TEXT, insurance_media_type TEXT, insurance_filename TEXT, insurance_status TEXT DEFAULT 'not_uploaded',
      insurance_uploaded_at TIMESTAMP, insurance_expiration DATE, insurance_verified_at TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_note TEXT, decided_at TIMESTAMP,
      status_token_hash TEXT UNIQUE, status_token_expires_at TIMESTAMP,
      pay_token_hash TEXT UNIQUE, pay_token_issued_at TIMESTAMP, pay_token_expires_at TIMESTAMP, pay_token_revoked_at TIMESTAMP,
      used_at TIMESTAMP, company_id INTEGER REFERENCES companies(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_company_app_email ON company_applications (lower(email))");
    // one live application per email, enforced by the database (a race cannot create two)
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_company_app_live_email ON company_applications (lower(email)) WHERE status IN ('pending','approved')");
    // what a company must have verified, and when its documents were verified
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS required_docs TEXT");
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_verified_at TIMESTAMP");
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS insurance_verified_at TIMESTAMP");
    await grandfather();
  }

  // Companies that existed before the gate get an "approved" application record so the admin sees one list.
  // They keep working exactly as before (API key, matching, dashboard); nothing about their account changes.
  async function grandfather() {
    const { rows } = await pool.query("SELECT c.* FROM companies c WHERE NOT EXISTS (SELECT 1 FROM company_applications a WHERE a.company_id = c.id)");
    for (const c of rows) {
      await pool.query(
        `INSERT INTO company_applications (source, name, contact_name, email, phone, market, services, license_number, insurance_carrier, crew_count,
           required_docs, license_media_type, license_filename, license_status, license_uploaded_at, license_expiration, license_verified_at,
           insurance_media_type, insurance_filename, insurance_status, insurance_uploaded_at, insurance_expiration, insurance_verified_at,
           status, decision_note, decided_at, company_id, used_at, created_at)
         VALUES ('grandfathered',$1,$2,$3,$4,'Nashville','[]',$5,$6,$7, NULL, $8,$9,$10,$11,$12,$13, $14,$15,$16,$17,$18,$19,
           'approved','Existing partner before the approval gate. Document values copied as recorded; nothing was newly verified.',NOW(),$20,NOW(),$21)
         ON CONFLICT (lower(email)) WHERE status IN ('pending','approved') DO NOTHING`,
        [c.name, c.owner_name, c.email, c.phone, c.license_number, c.insurance_carrier, c.crew_count,
         c.license_media_type, c.license_filename, c.license_status || "not_uploaded", c.license_uploaded_at, c.license_expiration, c.license_verified_at,
         c.insurance_media_type, c.insurance_filename, c.insurance_status || "not_uploaded", c.insurance_uploaded_at, c.insurance_expiration, c.insurance_verified_at,
         c.id, c.created_at]);
    }
  }

  const servicesOf = a => { try { return JSON.parse(a.services || "[]"); } catch (e) { return []; } };
  const linkState = a => {
    if (!a.pay_token_hash) return "none";
    if (a.pay_token_revoked_at) return "revoked";
    if (a.pay_token_expires_at && new Date(a.pay_token_expires_at).getTime() < Date.now()) return "expired";
    return "issued";
  };

  // What the admin sees: self-reported details and verified documents kept apart. Never includes a document body or a token.
  function adminView(a) {
    const ds = R.documentStatus(a);
    const ls = linkState(a);
    return {
      id: a.id, source: a.source, status: a.status, created_at: a.created_at, decided_at: a.decided_at, decision_note: a.decision_note,
      name: a.name, contact_name: a.contact_name, email: a.email, phone: a.phone, market: a.market, services: servicesOf(a),
      self_reported: { license_number: a.license_number || null, insurance_carrier: a.insurance_carrier || null, crew_count: a.crew_count, notes: a.notes || null },
      documents: ds.items, required_docs: ds.required, pending: ds.pending,
      link: { state: ls, issued_at: a.pay_token_issued_at, expires_at: a.pay_token_expires_at },
      company_id: a.company_id,
      can_approve: !a.company_id && ds.documents_ok
    };
  }
  // What the applicant sees on their own status page.
  function applicantView(a) {
    const ds = R.documentStatus(a);
    const ls = linkState(a);
    let next;
    if (a.company_id) next = "Your account is open. Log in to your partner dashboard with your API key.";
    else if (a.status === "rejected") next = "We could not approve this application." + (a.decision_note ? " " + a.decision_note : "") + " You are welcome to apply again.";
    else if (a.status === "approved" && ls === "issued") next = "You are approved. Your private payment link was emailed to you.";
    else if (a.status === "approved") next = "You are approved, but your payment link is " + (ls === "expired" ? "expired" : "no longer active") + ". Contact us and we will send a new one.";
    else if (ds.pending.length) next = "Next step: " + ds.pending.map(p => p.state === "pending_review" ? p.label + " is being reviewed" : p.ask).join(" ");
    else next = "All required documents are verified. We are finishing our review and will email your private payment link.";
    return { name: a.name, status: a.status, documents: ds.items, pending: ds.pending, next_step: next, account_open: !!a.company_id };
  }

  // ---- requirements the form can show before anyone applies ----
  app.get("/api/applications/requirements", limiter, (req, res) => {
    const market = clip(req.query.market || "Nashville", 60);
    const services = String(req.query.services || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 8);
    const req_ = R.requiredFor(market, services);
    res.json({ market, services, required: req_, items: R.DOCS.map(k => ({ key: k, label: R.LABELS[k].name, required: req_.includes(k), ask: R.LABELS[k].ask })) });
  });
  app.get("/api/applications/required", (req, res) => res.json({ required: REQUIRED }));

  // ---- apply ----
  app.post("/api/applications", limiter, async (req, res) => {
    const b = req.body || {};
    const f = { name: clip(b.name, 120), contact_name: clip(b.contact_name, 120), email: clip(b.email, 200), phone: clip(b.phone, 40),
      market: clip(b.market || "Nashville", 60), license_number: clip(b.license_number, 80) || null, insurance_carrier: clip(b.insurance_carrier, 120) || null,
      notes: clip(b.notes, 1000) || null };
    f.services = (Array.isArray(b.services) ? b.services : []).map(s => clip(s, 60)).filter(Boolean).slice(0, 8);
    const crew = Number(b.crew_count); f.crew_count = Number.isInteger(crew) && crew >= 0 && crew <= 500 ? crew : null;
    const missing = [];
    if (f.name.length < 2) missing.push("company name");
    if (f.contact_name.length < 2) missing.push("contact name");
    if (!emailOk(f.email)) missing.push("a valid email");
    if (f.phone.replace(/\D/g, "").length < 10) missing.push("a phone number");
    if (missing.length) return res.status(400).json({ error: "Please add: " + missing.join(", ") + "." });
    try {
      const { rows: prior } = await pool.query("SELECT id, status, company_id FROM company_applications WHERE lower(email) = lower($1) AND status IN ('pending','approved') ORDER BY id DESC LIMIT 1", [f.email]);
      const dup = p => res.json({ ok: true, already: p.company_id ? "member" : p.status,
        message: p.company_id ? "You already have a CanopyBid partner account. Log in with your API key." : p.status === "approved" ? "You are already approved. Check your email for your approval link, or contact us for a new one." : "We already have your application. Check your email for your status link." });
      if (prior[0]) return dup(prior[0]);
      const st = newToken();
      let ins;
      try {
        ins = await pool.query(
          `INSERT INTO company_applications (name, contact_name, email, phone, market, services, license_number, insurance_carrier, crew_count, notes, required_docs, status_token_hash, status_token_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [f.name, f.contact_name, f.email, f.phone, f.market, JSON.stringify(f.services), f.license_number, f.insurance_carrier, f.crew_count, f.notes,
           JSON.stringify(R.requiredFor(f.market, f.services)), hash(st), new Date(Date.now() + STATUS_DAYS * DAY)]);
      } catch (e) { if (e.code === "23505") { const p = (await pool.query("SELECT id, status, company_id FROM company_applications WHERE lower(email) = lower($1) AND status IN ('pending','approved') LIMIT 1", [f.email])).rows[0]; if (p) return dup(p); } throw e; }
      await logAudit({ actorType: "public", action: "application_submitted", targetType: "application", targetId: ins.rows[0].id, detail: { name: f.name, market: f.market } });
      const need = R.requiredFor(f.market, f.services).map(k => R.LABELS[k].name.toLowerCase()).join(" and ");
      if (ADMIN_NOTIFY_EMAIL) await sendEmail({ to: ADMIN_NOTIFY_EMAIL, subject: `New partner application: ${f.name}`, html: `<p><strong>${esc(f.name)}</strong> applied (contact ${esc(f.contact_name)}, ${esc(f.email)}, ${esc(f.phone)}).</p><p>Review it on the admin page.</p>` });
      await sendEmail({ to: f.email, subject: "We received your CanopyBid application",
        html: `<p>Thanks, ${esc(f.contact_name)}. We received the application for <strong>${esc(f.name)}</strong>.</p>
<p><strong>Next step:</strong> upload your ${esc(need || "documents")} on your <a href="${statusLink(st)}">application status page</a>. We review each document before we send a payment link, so you never pay before we know you can receive leads. Nothing is charged until then.</p>` });
      res.status(201).json({ ok: true, status_token: st, status_link: statusLink(st), message: "Application received. Upload your documents next. Nothing is charged until you are approved." });
    } catch (e) { console.error("[applications] Failed:", e); res.status(500).json({ error: "Could not save your application." }); }
  });

  async function byStatusToken(t) {
    t = String(t || ""); if (t.length < 20) return null;
    const { rows } = await pool.query("SELECT * FROM company_applications WHERE status_token_hash = $1", [hash(t)]);
    const a = rows[0];
    if (!a || (a.status_token_expires_at && new Date(a.status_token_expires_at).getTime() < Date.now())) return null;
    return a;
  }

  app.get("/api/applications/status", limiter, async (req, res) => {
    try { const a = await byStatusToken(req.query.status_token); if (!a) return res.status(404).json({ error: "This link is not valid or has expired." }); res.json(applicantView(a)); }
    catch (e) { res.status(500).json({ error: "Could not load your application." }); }
  });

  // ---- applicant uploads a document (checked on the bytes, not on what the browser claims) ----
  function sniffDoc(buf) {
    if (buf.length > 8 && buf.slice(0, 5).toString() === "%PDF-") return "application/pdf";
    if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
    return null;
  }
  app.post("/api/applications/documents", limiter, async (req, res) => {
    try {
      const a = await byStatusToken(req.query.status_token || (req.body || {}).status_token);
      if (!a) return res.status(404).json({ error: "This link is not valid or has expired." });
      if (a.company_id) return res.status(409).json({ error: "Your account is already open. Upload documents in your partner dashboard." });
      const { doc_type, filename, data } = req.body || {};
      if (!R.DOCS.includes(doc_type)) return res.status(400).json({ error: "doc_type must be license or insurance." });
      const raw = String(data || "").replace(/^data:[^,]*,/, "");
      const buf = Buffer.from(raw, "base64");
      if (!buf.length) return res.status(400).json({ error: "No file received." });
      if (buf.length > MAX_DOC_BYTES) return res.status(413).json({ error: "That file is too large (limit 6 MB). Try a smaller scan or photo." });
      const type = sniffDoc(buf);
      if (!type) return res.status(415).json({ error: "Please upload a PDF, JPG, PNG or WebP file." });
      await pool.query(
        `UPDATE company_applications SET ${doc_type}_doc = $1, ${doc_type}_media_type = $2, ${doc_type}_filename = $3, ${doc_type}_status = 'pending',
           ${doc_type}_uploaded_at = NOW(), ${doc_type}_verified_at = NULL, ${doc_type}_expiration = NULL WHERE id = $4`,
        [raw, type, clip(filename, 160) || "document", a.id]);
      await logAudit({ actorType: "applicant", action: "application_document_uploaded", targetType: "application", targetId: a.id, detail: { doc_type } });
      const fresh = (await pool.query("SELECT * FROM company_applications WHERE id = $1", [a.id])).rows[0];
      res.json({ status: "pending", ...applicantView(fresh) });
    } catch (e) { console.error("[applications/documents] Failed:", e); res.status(500).json({ error: "Upload failed. Please try again." }); }
  });

  // ---- the gate used by checkout and bids ----
  // Returns { ok:true, app?, company? } or { ok:false, status, code, error, pending? }.
  async function authorize(req, { email } = {}) {
    if (!REQUIRED) return { ok: true, app: null, company: null };
    const asked = String(email || "").trim().toLowerCase();
    // existing partner: identified by API key, must be eligible to receive leads
    if (req.header("x-api-key")) {
      const co = await authCompany(req);
      if (!co) return { ok: false, status: 401, code: "bad_key", error: "Invalid API key." };
      const el = R.eligibility(co);
      if (!el.eligible) return { ok: false, status: 403, code: "not_eligible", pending: el.pending, error: "Your account cannot take on another territory yet. Pending: " + el.pending.map(p => p.label + " (" + p.state_text.toLowerCase() + ")").join(", ") + "." };
      if (asked && asked !== String(co.email).toLowerCase()) return { ok: false, status: 403, code: "email_mismatch", error: "Use the email address on your account." };
      return { ok: true, app: null, company: co };
    }
    const tok = String((req.body || {}).approval_token || "");
    if (tok.length < 20) return { ok: false, status: 403, code: "approval_required", error: "Partner approval is required before you can pay or bid. Apply on this page; once your documents are reviewed and accepted we email you a private link." };
    const a = (await pool.query("SELECT * FROM company_applications WHERE pay_token_hash = $1", [hash(tok)])).rows[0];
    if (!a || a.status !== "approved") return { ok: false, status: 403, code: "bad_link", error: "This approval link is not valid. Contact us if you think that is a mistake." };
    if (a.pay_token_revoked_at) return { ok: false, status: 403, code: "link_revoked", error: "This approval link was withdrawn. Contact us for a new one." };
    if (a.pay_token_expires_at && new Date(a.pay_token_expires_at).getTime() < Date.now()) return { ok: false, status: 403, code: "link_expired", error: "This approval link has expired. Contact us and we will send a new one." };
    if (a.company_id) return { ok: false, status: 409, code: "already_used", error: "This approval was already used to open an account. Log in to your partner dashboard; to add a territory, use your account's API key." };
    const ds = R.documentStatus(a);
    if (!ds.documents_ok) return { ok: false, status: 403, code: "documents_pending", pending: ds.pending, error: "A required document needs attention before you can pay: " + ds.pending.map(p => p.label + " (" + p.state_text.toLowerCase() + ")").join(", ") + "." };
    if (asked && asked !== String(a.email).toLowerCase()) return { ok: false, status: 403, code: "email_mismatch", error: "Use the same email address that was approved." };
    return { ok: true, app: a, company: null };
  }

  // GET /api/applications/pay-link?token=  the payment page asks "is my link usable, and who am I?"
  app.get("/api/applications/pay-link", limiter, async (req, res) => {
    try {
      const g = await authorize({ header: () => null, body: { approval_token: req.query.token } });
      if (!g.ok) return res.status(g.status).json({ error: g.error, code: g.code, pending: g.pending || undefined });
      if (!g.app) return res.json({ required: false });
      res.json({ status: "ready", name: g.app.name, email: g.app.email, phone: g.app.phone || "", expires_at: g.app.pay_token_expires_at });
    } catch (e) { res.status(500).json({ error: "Could not check your link." }); }
  });

  // Called inside the payment-confirmation transaction. Locks the application so one approval cannot create two accounts.
  async function beginRedeem(client, applicationId) {
    if (!applicationId) return { app: null, blocked: false, revoked: false };
    const a = (await client.query("SELECT * FROM company_applications WHERE id = $1 FOR UPDATE", [applicationId])).rows[0];
    if (!a) return { app: null, blocked: false, revoked: false };
    return { app: a, blocked: !!a.company_id, revoked: a.status !== "approved" || !!a.pay_token_revoked_at };
  }
  async function markUsed(client, applicationId, companyId) {
    if (!applicationId) return;
    await (client || pool).query("UPDATE company_applications SET used_at = COALESCE(used_at, NOW()), company_id = COALESCE(company_id, $2) WHERE id = $1", [applicationId, companyId]);
  }
  // A new company starts with the verified documents, requirements and self-reported details of whoever vetted it.
  async function inherit(client, companyId, { applicationId, sourceCompanyId }) {
    const cols = R.DOCS.flatMap(k => DOC_COLS.map(c => `${k}_${c}`));
    if (applicationId) {
      const a = (await client.query("SELECT * FROM company_applications WHERE id = $1", [applicationId])).rows[0]; if (!a) return;
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
      await client.query(`UPDATE companies SET ${set}, required_docs = $${cols.length + 1}, license_number = $${cols.length + 2}, insurance_carrier = $${cols.length + 3}, owner_name = $${cols.length + 4}, crew_count = COALESCE($${cols.length + 5}, crew_count) WHERE id = $${cols.length + 6}`,
        [...cols.map(c => a[c]), a.required_docs, a.license_number, a.insurance_carrier, a.contact_name, a.crew_count, companyId]);
    } else if (sourceCompanyId) {
      const s = (await client.query("SELECT * FROM companies WHERE id = $1", [sourceCompanyId])).rows[0]; if (!s) return;
      const more = ["required_docs", "license_number", "insurance_carrier", "insurance_policy_number", "owner_name", "crew_count"];
      const all = [...cols, ...more];
      await client.query(`UPDATE companies SET ${all.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${all.length + 1}`, [...all.map(c => s[c]), companyId]);
    }
  }

  // ---- admin ----
  app.get("/api/admin/applications", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { rows } = await pool.query("SELECT * FROM company_applications ORDER BY (status = 'pending') DESC, (source = 'grandfathered') ASC, id DESC LIMIT 300");
      res.json(rows.map(adminView));
    } catch (e) { res.status(500).json({ error: "Could not load applications." }); }
  });

  app.get("/api/admin/applications/:id/document", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const type = req.query.type; if (!R.DOCS.includes(type)) return res.status(400).json({ error: "Invalid type." });
    try {
      const a = (await pool.query(`SELECT ${type}_doc AS data, ${type}_media_type AS media_type, ${type}_filename AS filename FROM company_applications WHERE id = $1`, [Number(req.params.id)])).rows[0];
      if (!a || !a.data) return res.status(404).json({ error: "No document uploaded." });
      res.json(a);
    } catch (e) { res.status(500).json({ error: "Could not load the document." }); }
  });

  // verify or reject one document; verification records WHO-checked-WHEN and the document's expiry date
  app.post("/api/admin/applications/:id/verify", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { doc_type, status, expiration, note } = req.body || {};
    if (!R.DOCS.includes(doc_type)) return res.status(400).json({ error: "Invalid doc_type." });
    if (!["verified", "rejected"].includes(status)) return res.status(400).json({ error: "status must be verified or rejected." });
    try {
      const a = (await pool.query("SELECT * FROM company_applications WHERE id = $1", [Number(req.params.id)])).rows[0];
      if (!a) return res.status(404).json({ error: "Application not found." });
      if (!a[doc_type + "_media_type"]) return res.status(409).json({ error: "There is no uploaded document to " + (status === "verified" ? "verify" : "reject") + "." });
      let exp = null;
      if (status === "verified") {
        if (expiration) { const t = new Date(expiration); if (isNaN(t) || t.getTime() < Date.now()) return res.status(400).json({ error: "The expiration date must be a valid date in the future." }); exp = String(expiration).slice(0, 10); }
        else if (doc_type === "insurance") return res.status(400).json({ error: "Enter the insurance expiration date shown on the certificate." });
      }
      await pool.query(`UPDATE company_applications SET ${doc_type}_status = $1, ${doc_type}_expiration = $2, ${doc_type}_verified_at = ${status === "verified" ? "NOW()" : "NULL"} WHERE id = $3`, [status, exp, a.id]);
      await logAudit({ actorType: "admin", action: "application_document_" + status, targetType: "application", targetId: a.id, detail: { doc_type, expiration: exp, note: clip(note, 300) || null } });
      const fresh = (await pool.query("SELECT * FROM company_applications WHERE id = $1", [a.id])).rows[0];
      if (status === "rejected") await sendEmail({ to: a.email, subject: "A document needs another look", html: `<p>We could not accept your ${esc(R.LABELS[doc_type].name.toLowerCase())}.${note ? " " + esc(clip(note, 300)) : ""} Please upload a clearer or current copy on your application status page (the link in your first email; ask us if you need a new one).</p>` });
      res.json(adminView(fresh));
    } catch (e) { console.error("[applications/verify] Failed:", e); res.status(500).json({ error: "Could not save." }); }
  });

  // approve (issue the payment link), reissue (new link, old one dies), revoke, reject
  app.post("/api/admin/applications/:id/decide", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const decision = String((req.body || {}).decision || ""), note = clip((req.body || {}).note, 500);
    if (!["approve", "reissue", "revoke", "reject", "resend_status"].includes(decision)) return res.status(400).json({ error: "decision must be approve, reissue, revoke, reject or resend_status." });
    try {
      const a = (await pool.query("SELECT * FROM company_applications WHERE id = $1", [Number(req.params.id)])).rows[0];
      if (!a) return res.status(404).json({ error: "Application not found." });
      if (a.company_id && decision !== "revoke") return res.status(409).json({ error: "This company already has an account. Its documents are managed under Companies." });
      if (decision === "resend_status") {   // lost the status link: make a new one (the old one stops working) and email it
        const st = newToken();
        await pool.query("UPDATE company_applications SET status_token_hash = $1, status_token_expires_at = $2 WHERE id = $3", [hash(st), new Date(Date.now() + STATUS_DAYS * DAY), a.id]);
        await sendEmail({ to: a.email, subject: "Your CanopyBid application status link", html: `<p>Here is your new <a href="${statusLink(st)}">application status link</a>. Any earlier status link no longer works.</p>` });
        await logAudit({ actorType: "admin", action: "application_status_link_resent", targetType: "application", targetId: a.id });
        return res.json({ status: a.status, status_link: statusLink(st) });
      }
      if (decision === "approve" || decision === "reissue") {
        if (decision === "reissue" && a.status !== "approved") return res.status(409).json({ error: "Only an approved application can have its link re-issued." });
        const ds = R.documentStatus(a);
        if (!ds.documents_ok) return res.status(409).json({ error: "Verify the required documents first. Still pending: " + ds.pending.map(p => p.label + " (" + p.state_text.toLowerCase() + ")").join(", ") + ".", pending: ds.pending });
        const token = newToken(), expires = new Date(Date.now() + LINK_DAYS * DAY);
        await pool.query("UPDATE company_applications SET status = 'approved', pay_token_hash = $1, pay_token_issued_at = NOW(), pay_token_expires_at = $2, pay_token_revoked_at = NULL, decision_note = COALESCE($3, decision_note), decided_at = NOW() WHERE id = $4", [hash(token), expires, note || null, a.id]);
        await logAudit({ actorType: "admin", action: decision === "approve" ? "application_approved" : "application_link_reissued", targetType: "application", targetId: a.id, detail: { name: a.name, expires: expires.toISOString() } });
        const link = payLink(token);
        await sendEmail({ to: a.email, subject: "You are approved: choose your CanopyBid territories",
          html: `<p>Good news, ${esc(a.contact_name || a.name)}. <strong>${esc(a.name)}</strong> is approved to join CanopyBid. Your documents were reviewed and accepted, so you can receive leads as soon as you subscribe.</p>
<p><a href="${link}">Open your private payment link</a> to choose your territories and pay. After you pay, open your dashboard and accept the Tree Company Agreement: requests are not sent to you until you do. It works for ${LINK_DAYS} days (until ${expires.toUTCString()}), is only for ${esc(a.email)}, and opens a single account. Please do not forward it.</p>` });
        return res.json({ status: "approved", link, expires_at: expires, note: "This link is shown only once. Re-issue it if you lose it." });
      }
      if (decision === "revoke") {
        await pool.query("UPDATE company_applications SET pay_token_revoked_at = NOW(), decision_note = COALESCE($1, decision_note) WHERE id = $2", [note || null, a.id]);
        await logAudit({ actorType: "admin", action: "application_link_revoked", targetType: "application", targetId: a.id });
        return res.json({ status: a.status, link_state: "revoked" });
      }
      await pool.query("UPDATE company_applications SET status = 'rejected', pay_token_revoked_at = COALESCE(pay_token_revoked_at, NOW()), decision_note = $1, decided_at = NOW() WHERE id = $2", [note || null, a.id]);
      await logAudit({ actorType: "admin", action: "application_rejected", targetType: "application", targetId: a.id, detail: { name: a.name } });
      await sendEmail({ to: a.email, subject: "About your CanopyBid application", html: `<p>Thank you for applying for <strong>${esc(a.name)}</strong>. We are not able to approve it right now.${note ? " " + esc(note) : ""} You are welcome to apply again when your details change.</p>` });
      res.json({ status: "rejected" });
    } catch (e) { console.error("[applications/decide] Failed:", e); res.status(500).json({ error: "Could not save the decision." }); }
  });

  return { schema, grandfather, authorize, beginRedeem, markUsed, inherit, REQUIRED, LINK_DAYS };
};

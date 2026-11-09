// Homeowner data retention and deletion.
//
//  * Automatic cleanup: homeowner requests (and their photos/video) are erased RETENTION_MONTHS (default 12) after submission.
//    Runs daily. If an unusually large number is due at once (> RETENTION_AUTO_MAX, default 200) it does NOTHING except raise an
//    alert, so a clock or data error can never wipe the database: you then use the preview/confirm tool below.
//  * Erasing a request means: photos and video rows are DELETED from the database (photos are stored in Postgres, not in a file
//    store, so there is no second copy to chase), the person's name, phone, email, address, notes and tree details are blanked, and
//    the row is kept only as a non-identifying record (ZIP, territory, dates, estimate range, status) so territory statistics and
//    company billing history stay intact. Company dispute and audit records keep their type/outcome but lose free text.
//  * Admin tools (x-admin-key):
//      GET  /api/admin/retention/preview[?months=12]      what the bulk tool would delete, plus a one-time confirm token
//      POST /api/admin/retention/delete {confirm_token}   deletes exactly what the preview listed (token expires in 15 minutes)
//      GET  /api/admin/leads/by-email?email=              find a person's requests (ids, dates, ZIP, media counts only)
//      GET  /api/admin/leads/:id/erase-preview            what erasing one request would remove
//      POST /api/admin/leads/:id/erase {confirm_lead_id}  erase one request (and that person's waitlist / verification records)
//      POST /api/admin/privacy-requests {email, kind?, note?, received_at?}   log a request: starts the 30-day clock + alert
//      GET  /api/admin/privacy-requests                   open requests with due date, days left, overdue flag
//      POST /api/admin/privacy-requests/:id/complete {note}   close it (the email address is removed from the record)
// Company account and billing records are NOT touched by anything here.
const crypto = require("crypto");

module.exports = function initRetention(d) {
  const { app, pool, requireAdmin, logAudit, alerts, sendEmail } = d;
  const MONTHS = () => { const m = Number(process.env.RETENTION_MONTHS || 12); return Number.isFinite(m) && m >= 1 ? Math.floor(m) : 12; };
  const AUTO_MAX = () => Number(process.env.RETENTION_AUTO_MAX || 200);
  const RESPONSE_DAYS = 30;
  const COMPANY_CONFIRM_DAYS = Number(process.env.COMPANY_CONFIRM_DAYS || 14); // PROPOSED period (lawyer to confirm). It counts in calendar days from the day CanopyBid sends the notice (see markSent below).
  const NOTICE_REMIND_DAYS = 3;
  // Phone numbers are matched on their last 10 digits, so (615) 555-1234, 615.555.1234, +1 615 555 1234 and 1-615-555-1234 are the same number.
  const normPhone = p => { let x = String(p || "").replace(/\D/g, ""); if (x.length === 11 && x[0] === "1") x = x.slice(1); return x.length === 10 ? x : null; };
  const PH = col => `right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;
  const TOKEN_SECRET = crypto.randomBytes(32);
  const tokenFor = (ids, cutoff, exp) => crypto.createHmac("sha256", TOKEN_SECRET).update(`${ids.join(",")}|${cutoff}|${exp}`).digest("hex");

  async function schema() {
    await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP");
    // Company deletion notices: no homeowner personal data is stored here, only the request number and dates.
    await pool.query(`CREATE TABLE IF NOT EXISTS company_deletion_notices (
      id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, company_id INTEGER, company_name TEXT, company_email TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(), notified_at TIMESTAMP, due_at TIMESTAMP NOT NULL,
      confirmed_at TIMESTAMP, confirm_note TEXT, UNIQUE (lead_id, company_id))`);
    // Deletion log: one line per erased request, NO personal details (request number, submission time, erasure time, reason, company number).
    // Its purpose is to let an operator erase the same requests again after a database restore. A copy leaves the database by email (exportDeletionLog).
    await pool.query(`CREATE TABLE IF NOT EXISTS deletion_log (
      id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, submitted_text TEXT NOT NULL, erased_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reason TEXT, company_id INTEGER, exported_at TIMESTAMP, UNIQUE (lead_id, submitted_text))`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_leads_created_live ON leads (created_at) WHERE deleted_at IS NULL");
  }

  // ---- the one erase routine (single, bulk and automatic all use it) ----
  async function eraseLead(client, id, reason) {
    const lead = (await client.query("SELECT id, email, phone, deleted_at, assigned_company_id, to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS submitted_text FROM leads WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!lead) return null;
    const out = { lead_id: id, already_erased: !!lead.deleted_at, photos: 0, videos: 0, media_bytes: 0, waitlist: 0, verifications: 0 };
    const m = await client.query("DELETE FROM lead_media WHERE lead_id = $1 RETURNING kind, size_bytes", [id]);
    for (const r of m.rows) { if (r.kind === "video") out.videos++; else out.photos++; out.media_bytes += Number(r.size_bytes) || 0; }
    await client.query("DELETE FROM lead_status_history WHERE lead_id = $1", [id]);
    await client.query("DELETE FROM lead_reports WHERE lead_id = $1", [id]);
    await client.query("UPDATE lead_disputes SET detail = NULL WHERE lead_id = $1", [id]);
    await client.query("UPDATE routing_issues SET note = NULL WHERE lead_id = $1", [id]);
    await client.query("UPDATE admin_alerts SET title = kind, message = NULL, detail = NULL, email = NULL WHERE lead_id = $1", [id]);
    await client.query("UPDATE audit_log SET detail = NULL WHERE target_type = 'lead' AND target_id = $1", [String(id)]);
    const np = normPhone(lead.phone);
    if (np && !lead.deleted_at) out.waitlist += (await client.query(`DELETE FROM waitlist WHERE ${PH("phone")} = $1`, [np])).rowCount;
    if (lead.email && !lead.deleted_at) {
      const e = String(lead.email).trim().toLowerCase();
      out.waitlist += (await client.query("DELETE FROM waitlist WHERE lower(email) = $1", [e])).rowCount;
      out.verifications = (await client.query("DELETE FROM email_verifications WHERE lower(email) = $1", [e])).rowCount;
    }
    await client.query(
      `UPDATE leads SET name = '[deleted]', phone = NULL, email = NULL, address = NULL, access = NULL, species = NULL, height = NULL,
         dbh = NULL, crown = NULL, conditions_json = NULL, trees_json = NULL, intake_json = NULL, admin_notes = NULL, consent_ip = NULL,
         idempotency_key = NULL, resume_token = NULL, duplicate_reason = NULL, status = 'deleted', deleted_at = COALESCE(deleted_at, NOW())
       WHERE id = $1`, [id]);
    // Deletion log line (first erasure only). Contains no personal details.
    if (!lead.deleted_at) await client.query("INSERT INTO deletion_log (lead_id, submitted_text, reason, company_id) VALUES ($1,$2,$3,$4) ON CONFLICT (lead_id, submitted_text) DO NOTHING",
      [id, lead.submitted_text, String(reason || "erased").slice(0, 120), lead.assigned_company_id || null]);
    // Every path (one request, bulk, automatic) tells the assigned company, once. The notice holds no homeowner details.
    if (!lead.deleted_at && lead.assigned_company_id) {
      const co = (await client.query("SELECT id, name, email FROM companies WHERE id = $1", [lead.assigned_company_id])).rows[0];
      if (co) {
        const n = (await client.query(`INSERT INTO company_deletion_notices (lead_id, company_id, company_name, company_email, due_at)
          VALUES ($1,$2,$3,$4, NOW() + ($5 || ' days')::interval) ON CONFLICT (lead_id, company_id) DO NOTHING RETURNING id, due_at`,
          [id, co.id, co.name, co.email, String(COMPANY_CONFIRM_DAYS)])).rows[0];
        if (n) out.notice_id = n.id;
      }
    }
    return out;
  }

  async function eraseMany(ids, actor, why) {
    const totals = { leads: 0, photos: 0, videos: 0, media_bytes: 0, company_notices: 0 };
    for (const id of ids) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await eraseLead(client, id, why);
        await client.query("COMMIT");
        if (r && !r.already_erased) { totals.leads++; if (r.notice_id) totals.company_notices++; totals.photos += r.photos; totals.videos += r.videos; totals.media_bytes += r.media_bytes; }
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
    }
    // Give the freed space back so the deleted bytes are rewritten out of the table files (the table is small at pilot scale).
    if (totals.photos + totals.videos) await pool.query("VACUUM FULL lead_media").catch(e => console.error("[retention] vacuum failed:", e.message));
    await logAudit({ actorType: actor, action: "homeowner_data_erased", detail: { why, ...totals } });
    return totals;
  }

  const dueIds = async months => (await pool.query(
    "SELECT id FROM leads WHERE deleted_at IS NULL AND created_at < NOW() - ($1::int * INTERVAL '1 month') ORDER BY id", [months])).rows.map(r => r.id);

  // Old waitlist entries and expired email codes: small, but they are personal data too.
  async function sweepSmallTables(months) {
    const w = await pool.query("DELETE FROM waitlist WHERE created_at < NOW() - ($1::int * INTERVAL '1 month')", [months]);
    const v = await pool.query("DELETE FROM email_verifications WHERE created_at < NOW() - INTERVAL '30 days'");
    return { waitlist: w.rowCount, verifications: v.rowCount };
  }

  async function autoCleanup() {
    const months = MONTHS();
    const ids = await dueIds(months);
    let res = { due: ids.length, erased: 0, held_back: false };
    if (ids.length > AUTO_MAX()) {
      res.held_back = true;
      await alerts.raiseAndAnnounce({ kind: "retention_held_back", severity: "high", title: "Automatic cleanup paused: unusually many requests are due",
        message: `${ids.length} requests are older than ${months} months, more than the automatic limit of ${AUTO_MAX()}. Nothing was deleted. Open the retention preview in the admin tools, check the list, and confirm if it is right.`,
        dedupe: `retention_held_back:${new Date().toISOString().slice(0, 10)}` });
    } else if (ids.length) {
      const t = await eraseMany(ids, "system", `automatic ${months}-month cleanup`);
      res.erased = t.leads; res.photos = t.photos; res.videos = t.videos;
    }
    res.small = await sweepSmallTables(months);
    await privacyDueSweep();
    await companyNoticeSweep();
    return res;
  }

  // ---- privacy requests: 30-day clock, escalated by alert ----
  async function privacyDueSweep() {
    const { rows } = await pool.query("SELECT * FROM admin_alerts WHERE kind = 'privacy_request' AND status = 'open'");
    for (const a of rows) {
      let due; try { due = new Date(JSON.parse(a.detail).due_at); } catch (e) { continue; }
      const left = Math.ceil((due - Date.now()) / 864e5);
      if (left <= 7) {
        await alerts.raiseAndAnnounce({ kind: "privacy_request_due", severity: "high", title: left < 0 ? "Privacy request is OVERDUE" : "Privacy request is due soon",
          message: `A privacy request (alert #${a.id}) is ${left < 0 ? Math.abs(left) + " day(s) overdue" : "due in " + left + " day(s)"}. Complete it in the admin tools.`,
          dedupe: `privacy_due:${a.id}:${left < 0 ? "overdue" : "soon"}` });
      }
    }
  }

  // Company deletion notices: remind when not yet sent, alert when the company has not confirmed by the due date.
  async function companyNoticeSweep() {
    // One alert per company per week (not one per request), so a big cleanup cannot flood the admin.
    const week = Math.floor(Date.now() / (7 * 864e5));
    const { rows } = await pool.query("SELECT * FROM company_deletion_notices WHERE confirmed_at IS NULL ORDER BY company_id, id");
    const unsent = new Map(), overdue = new Map();
    for (const n of rows) {
      const key = n.company_id || 0;
      if (!n.notified_at && Date.now() - new Date(n.created_at) > NOTICE_REMIND_DAYS * 864e5) { (unsent.get(key) || unsent.set(key, []).get(key)).push(n); }
      else if (n.notified_at && new Date(n.due_at) < new Date()) { (overdue.get(key) || overdue.set(key, []).get(key)).push(n); }
    }
    const list = ns => ns.slice(0, 20).map(n => "#" + n.lead_id).join(", ") + (ns.length > 20 ? ` and ${ns.length - 20} more` : "");
    for (const [cid, ns] of unsent) await alerts.raiseAndAnnounce({ kind: "company_deletion_unsent", severity: "high", title: "Company has not been told to delete homeowner data",
      message: `${ns[0].company_name} has ${ns.length} deletion notice(s) not yet sent (requests ${list(ns)}). Run admin-company-deletions.sh to get the email text and send it.`, dedupe: `co_del_unsent:${cid}:${week}` });
    for (const [cid, ns] of overdue) await alerts.raiseAndAnnounce({ kind: "company_deletion_overdue", severity: "high", title: "Company has not confirmed deletion",
      message: `${ns[0].company_name} has not confirmed deleting ${ns.length} request(s) by the due date (requests ${list(ns)}). Follow up.`, dedupe: `co_del_overdue:${cid}:${week}` });
  }

  // ---- deletion log: copy out of the database, and re-apply after a restore ----
  const LOG_TO = () => process.env.DELETION_LOG_EMAIL || process.env.ADMIN_NOTIFY_EMAIL || "";
  const logLine = r => ({ request_number: r.lead_id, submitted_at: r.submitted_text, erased_at: new Date(r.erased_at).toISOString(), reason: r.reason, company_id: r.company_id });
  async function highWater() { return Number((await pool.query("SELECT COALESCE(MAX(id),0)::int AS m FROM leads")).rows[0].m); }

  // Emails every not-yet-exported line to a mailbox that lives OUTSIDE the database host. A line is marked exported only after the email provider accepted it.
  async function exportDeletionLog() {
    const rows = (await pool.query("SELECT * FROM deletion_log WHERE exported_at IS NULL ORDER BY id LIMIT 2000")).rows;
    if (!rows.length) return { exported: 0 };
    const to = LOG_TO();
    const day = new Date().toISOString().slice(0, 10);
    const fail = async why => { await alerts.raiseAndAnnounce({ kind: "deletion_log_not_exported", severity: "high", title: "Deletion log not saved outside the database",
      message: `${rows.length} deletion log line(s) could not be emailed (${why}). Until they are saved elsewhere, a database restore could not re-apply those deletions. Fix the email setting (DELETION_LOG_EMAIL or ADMIN_NOTIFY_EMAIL) or download the log from the admin tool.`, dedupe: `deletion_log_not_exported:${day}` }); return { exported: 0, failed: why }; };
    if (!to) return fail("no DELETION_LOG_EMAIL or ADMIN_NOTIFY_EMAIL set");
    const lines = [JSON.stringify({ type: "high_water", highest_request_number: await highWater(), at: new Date().toISOString() }), ...rows.map(r => JSON.stringify(logLine(r)))];
    const html = `<p>CanopyBid deletion log, ${day}. Keep this email: it is the copy that survives a database restore. It contains request numbers and dates only, no personal details.</p><p>After any restore, give these lines to the re-apply tool (admin-reapply-deletions.sh) before reopening the site.</p><pre style="font-size:12px">${lines.join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
    const r = await sendEmail({ to, subject: `CanopyBid deletion log ${day} (${rows.length} line${rows.length === 1 ? "" : "s"})`, html });
    if (!r || !r.success) return fail(r && r.skipped ? "email service not configured" : "the email provider refused it");
    await pool.query("UPDATE deletion_log SET exported_at = NOW() WHERE id = ANY($1)", [rows.map(x => x.id)]);
    return { exported: rows.length };
  }

  // Re-apply: for every logged line, erase the request again IF a request with the same number AND the same submission time exists and is not erased.
  async function reapplyDeletions(entries, confirm) {
    const items = []; let hw = 0;
    for (const e of entries || []) {
      if (!e || typeof e !== "object") continue;
      if (e.type === "high_water") { hw = Math.max(hw, Number(e.highest_request_number) || 0); continue; }
      const id = Number(e.request_number || e.lead_id);
      const when = String(e.submitted_at || e.submitted_text || "").replace(/Z$/, "");
      if (!Number.isInteger(id) || !/^\d{4}-\d\d-\d\dT[\d:.]+$/.test(when)) { items.push({ request_number: e.request_number, action: "invalid_line" }); continue; }
      hw = Math.max(hw, id);
      const row = (await pool.query("SELECT id, deleted_at, (created_at = $2::timestamp) AS same FROM leads WHERE id = $1", [id, when])).rows[0];
      let action = !row ? "not_found" : !row.same ? "different_request_skipped" : row.deleted_at ? "already_erased" : "will_erase";
      items.push({ request_number: id, action, reason: e.reason || null, company_id: e.company_id || null });
    }
    const out = { confirmed: !!confirm, to_erase: items.filter(i => i.action === "will_erase").length, items, highest_request_number: hw };
    if (!confirm) return out;
    let erased = 0;
    for (const it of items) {
      if (it.action !== "will_erase") continue;
      const client = await pool.connect();
      try { await client.query("BEGIN"); const r = await eraseLead(client, it.request_number, `re-applied after restore (${it.reason || "logged deletion"})`); await client.query("COMMIT"); if (r && !r.already_erased) { erased++; it.action = "erased"; } }
      catch (e) { await client.query("ROLLBACK").catch(() => {}); it.action = "error"; } finally { client.release(); }
    }
    if (erased) await pool.query("VACUUM FULL lead_media").catch(() => {});
    // The restored database may hand out request numbers that were already used before the restore. Move the counter past every number we know of.
    const seq = (await pool.query("SELECT pg_get_serial_sequence('leads','id') AS s")).rows[0].s;
    if (seq && hw) { const cur = Number((await pool.query(`SELECT last_value FROM ${seq}`)).rows[0].last_value); if (hw > cur) await pool.query("SELECT setval($1, $2)", [seq, hw]); out.counter_moved_to = Math.max(hw, cur); }
    await pool.query("UPDATE deletion_log SET exported_at = COALESCE(exported_at, NOW()) WHERE lead_id = ANY($1)", [items.filter(i => i.action === "erased").map(i => i.request_number)]);
    out.erased = erased;
    await logAudit({ actorType: "admin", action: "deletions_reapplied_after_restore", detail: { erased, lines: items.length, counter_moved_to: out.counter_moved_to || null } });
    return out;
  }

  function start() {
    if (process.env.RETENTION_AUTO === "0") return;
    const every = Number(process.env.RETENTION_INTERVAL_MS === undefined ? 24 * 3600e3 : process.env.RETENTION_INTERVAL_MS);
    const first = Number(process.env.RETENTION_STARTUP_DELAY_MS === undefined ? 120e3 : process.env.RETENTION_STARTUP_DELAY_MS);
    if (!every) return;
    const run = async () => {
      // One instance at a time even if the service is scaled out.
      const c = await pool.connect();
      try {
        const lock = (await c.query("SELECT pg_try_advisory_lock(727401) AS ok")).rows[0].ok;
        if (!lock) return;
        try { const r = await autoCleanup(); if (r.erased || r.held_back) console.log(`[retention] cleanup: ${r.erased} erased, held_back=${r.held_back}`); await exportDeletionLog().catch(e => console.error("[retention] log export failed:", e.message)); }
        finally { await c.query("SELECT pg_advisory_unlock(727401)"); }
      } catch (e) { console.error("[retention] cleanup failed:", e.message); } finally { c.release(); }
    };
    setTimeout(run, first).unref(); setInterval(run, every).unref();
  }

  // ---- routes ----
  app.get("/api/admin/retention/preview", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const months = req.query.months ? Math.max(1, Math.floor(Number(req.query.months))) : MONTHS();
      if (!Number.isFinite(months)) return res.status(400).json({ error: "months must be a number." });
      const ids = await dueIds(months);
      const cutoff = (await pool.query("SELECT (NOW() - ($1::int * INTERVAL '1 month'))::date AS d", [months])).rows[0].d.toISOString().slice(0, 10);
      const media = ids.length ? (await pool.query("SELECT COUNT(*)::int n, COALESCE(SUM(size_bytes),0)::bigint b FROM lead_media WHERE lead_id = ANY($1)", [ids])).rows[0] : { n: 0, b: 0 };
      const sample = ids.length ? (await pool.query("SELECT id, created_at, zip, status FROM leads WHERE id = ANY($1) ORDER BY id LIMIT 50", [ids])).rows : [];
      const exp = Date.now() + 15 * 60e3;
      res.json({ months, older_than: cutoff, requests: ids.length, media_files: media.n, media_megabytes: Math.round(Number(media.b) / 1048576 * 10) / 10,
        sample, sample_note: sample.length < ids.length ? `showing the first ${sample.length} of ${ids.length}` : undefined,
        confirm_token: ids.length ? `${exp}.${tokenFor(ids, months, exp)}` : null,
        warning: "Confirming permanently erases these requests' personal details and every photo and video. It cannot be undone." });
    } catch (e) { console.error("[retention/preview] Failed:", e); res.status(500).json({ error: "Could not build the preview." }); }
  });

  app.post("/api/admin/retention/delete", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const [expS, sig] = String((req.body || {}).confirm_token || "").split(".");
      const months = Math.max(1, Math.floor(Number((req.body || {}).months || MONTHS())));
      const exp = Number(expS);
      if (!exp || !sig || exp < Date.now()) return res.status(400).json({ error: "The confirmation expired or is missing. Run the preview again." });
      const ids = await dueIds(months);
      const good = tokenFor(ids, months, exp);
      if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)))
        return res.status(409).json({ error: "The list changed since the preview (or the months differ). Run the preview again and confirm that." });
      const t = await eraseMany(ids, "admin", `bulk cleanup older than ${months} months`);
      res.json({ erased_requests: t.leads, photos_deleted: t.photos, videos_deleted: t.videos });
    } catch (e) { console.error("[retention/delete] Failed:", e); res.status(500).json({ error: "Could not delete." }); }
  });

  // Lookup for a privacy request. Shows enough (name, street address, ZIP, date, photo count, assigned company) for you to confirm
  // it is the right person before anything is deleted; nothing is deleted by a lookup.
  async function lookup(where, param, waitWhere) {
    const { rows } = await pool.query(
      `SELECT l.id, l.created_at, l.name, l.address, l.zip, l.status, l.deleted_at, c.name AS company,
              (SELECT COUNT(*)::int FROM lead_media m WHERE m.lead_id = l.id) AS media_files
         FROM leads l LEFT JOIN companies c ON c.id = l.assigned_company_id WHERE ${where} ORDER BY l.id`, [param]);
    const wl = (await pool.query(`SELECT COUNT(*)::int n FROM waitlist WHERE ${waitWhere}`, [param])).rows[0].n;
    return { requests: rows, waitlist_entries: wl };
  }
  app.get("/api/admin/leads/by-email", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email.includes("@")) return res.status(400).json({ error: "email is required." });
    res.json(await lookup("lower(l.email) = $1", email, "lower(email) = $1"));
  });
  app.get("/api/admin/leads/by-phone", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const np = normPhone(req.query.phone);
    if (!np) return res.status(400).json({ error: "phone must have 10 digits (a leading 1 is ignored)." });
    res.json({ normalized: np, ...(await lookup(`${PH("l.phone")} = $1`, np, `${PH("phone")} = $1`)) });
  });

  app.get("/api/admin/leads/:id/erase-preview", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
    const l = (await pool.query("SELECT id, created_at, zip, status, deleted_at, lower(email) AS email, phone FROM leads WHERE id = $1", [id])).rows[0];
    if (!l) return res.status(404).json({ error: "Request not found." });
    const m = (await pool.query("SELECT COUNT(*) FILTER (WHERE kind <> 'video')::int photos, COUNT(*) FILTER (WHERE kind = 'video')::int videos FROM lead_media WHERE lead_id = $1", [id])).rows[0];
    const ph = normPhone(l.phone);
    const wl = (l.email ? (await pool.query("SELECT COUNT(*)::int n FROM waitlist WHERE lower(email) = $1", [l.email])).rows[0].n : 0)
             + (ph ? (await pool.query(`SELECT COUNT(*)::int n FROM waitlist WHERE ${PH("phone")} = $1`, [ph])).rows[0].n : 0);
    res.json({ id, created_at: l.created_at, zip: l.zip, already_erased: !!l.deleted_at, photos: m.photos, videos: m.videos, waitlist_entries: wl,
      will_do: "Deletes every photo and video, blanks name, phone, email, address, notes and tree details, and keeps only a non-identifying record (ZIP, territory, dates, estimate range).",
      to_confirm: `POST this URL's /api/admin/leads/${id}/erase with {"confirm_lead_id": ${id}}` });
  });

  app.post("/api/admin/leads/:id/erase", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
    if (Number((req.body || {}).confirm_lead_id) !== id) return res.status(400).json({ error: "Confirm by sending confirm_lead_id equal to the request id (see erase-preview)." });
    try {
      const exists = (await pool.query("SELECT 1 FROM leads WHERE id = $1", [id])).rowCount;
      if (!exists) return res.status(404).json({ error: "Request not found." });
      const client = await pool.connect(); let r;
      try { await client.query("BEGIN"); r = await eraseLead(client, id, "single request erased by admin"); await client.query("COMMIT"); }
      catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
      if (r.photos + r.videos) await pool.query("VACUUM FULL lead_media").catch(() => {});
      await logAudit({ actorType: "admin", action: "homeowner_request_erased", targetType: "lead", targetId: String(id), detail: { photos: r.photos, videos: r.videos } });
      const co = (await pool.query("SELECT c.name, c.email FROM leads l JOIN companies c ON c.id = l.assigned_company_id WHERE l.id = $1", [id])).rows[0];
      res.json({ erased: !r.already_erased, company_notice_id: r.notice_id || null, ask_company_to_delete: co ? { name: co.name, email: co.email, why: "This company received the person's details by email and in its dashboard. We cannot delete its copies; the privacy notice says we will ask it to." } : null, already_erased: r.already_erased, photos_deleted: r.photos, videos_deleted: r.videos, waitlist_deleted: r.waitlist, verifications_deleted: r.verifications });
    } catch (e) { console.error("[admin/erase] Failed:", e); res.status(500).json({ error: "Could not erase." }); }
  });

  app.post("/api/admin/privacy-requests", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const email = String(b.email || "").trim().toLowerCase();
    const phone = normPhone(b.phone);
    const kind = b.kind || "delete";
    if (!email.includes("@") && !phone) return res.status(400).json({ error: "an email address or a 10-digit phone number is required." });
    if (!["delete", "access", "other"].includes(kind)) return res.status(400).json({ error: "kind must be delete, access or other." });
    const received = b.received_at ? new Date(b.received_at) : new Date();
    if (isNaN(received)) return res.status(400).json({ error: "received_at is not a date." });
    const due = new Date(received.getTime() + RESPONSE_DAYS * 864e5);
    const row = await alerts.raise({ kind: "privacy_request", severity: "normal", title: `Privacy request (${kind}) from ${email.includes("@") ? email : phone}`,
      message: `Received ${received.toISOString().slice(0, 10)}. Respond by ${due.toISOString().slice(0, 10)} (${RESPONSE_DAYS} days).${b.note ? " Note: " + String(b.note).slice(0, 500) : ""}`,
      email: email.includes("@") ? email : null, detail: { due_at: due.toISOString(), received_at: received.toISOString(), kind, phone: phone || undefined } });
    await logAudit({ actorType: "admin", action: "privacy_request_logged", targetType: "alert", targetId: String(row.id), detail: { kind } });
    res.status(201).json({ id: row.id, due_at: due.toISOString() });
  });

  app.get("/api/admin/privacy-requests", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await pool.query("SELECT id, title, message, email, detail, status, created_at, resolved_at FROM admin_alerts WHERE kind = 'privacy_request' ORDER BY id DESC LIMIT 200");
    res.json(rows.map(r => { let d = {}; try { d = JSON.parse(r.detail) || {}; } catch (e) {}
      const left = d.due_at ? Math.ceil((new Date(d.due_at) - Date.now()) / 864e5) : null;
      return { id: r.id, status: r.status, email: r.email || d.phone || null, kind: d.kind, received_at: d.received_at, due_at: d.due_at, days_left: r.status === "open" ? left : null, overdue: r.status === "open" && left !== null && left < 0, resolved_at: r.resolved_at };
    }));
  });

  app.post("/api/admin/privacy-requests/:id/complete", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const r = await pool.query(
      `UPDATE admin_alerts SET status = 'resolved', resolved_at = NOW(), resolution_note = $2, email = NULL, title = 'Privacy request (completed)',
         message = NULL, detail = jsonb_build_object('kind', detail::jsonb->>'kind', 'received_at', detail::jsonb->>'received_at', 'due_at', detail::jsonb->>'due_at')::text
       WHERE id = $1 AND kind = 'privacy_request' RETURNING id`, [id, String((req.body || {}).note || "").slice(0, 500) || null]);
    if (!r.rowCount) return res.status(404).json({ error: "Privacy request not found." });
    await logAudit({ actorType: "admin", action: "privacy_request_completed", targetType: "alert", targetId: String(id) });
    res.json({ completed: true });
  });

  app.get("/api/admin/deletion-log", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const since = Math.max(0, Number(req.query.since_id) || 0);
    const rows = (await pool.query("SELECT * FROM deletion_log WHERE id > $1 ORDER BY id", [since])).rows;
    res.json({ highest_request_number: await highWater(), lines: rows.map(logLine), last_id: rows.length ? rows[rows.length - 1].id : since,
      not_yet_emailed: rows.filter(r => !r.exported_at).length });
  });
  app.post("/api/admin/deletion-log/export", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await exportDeletionLog()); } catch (e) { console.error("[deletion-log/export] Failed:", e); res.status(500).json({ error: "Could not export." }); }
  });
  // Without confirm:true this only lists what WOULD be erased. Body: { entries: [ ...lines from the emailed log ], confirm?: true }
  app.post("/api/admin/deletion-log/reapply", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    if (!Array.isArray(b.entries) || !b.entries.length) return res.status(400).json({ error: "entries must be the list of lines from the saved deletion log." });
    if (b.entries.length > 20000) return res.status(400).json({ error: "Too many lines in one call (limit 20000)." });
    try { res.json(await reapplyDeletions(b.entries, b.confirm === true)); } catch (e) { console.error("[deletion-log/reapply] Failed:", e); res.status(500).json({ error: "Could not re-apply." }); }
  });

  // ---- company deletion notices: did the company confirm it deleted its copy? ----
  const noticeRow = r => ({ id: r.id, request_number: r.lead_id, company_id: r.company_id, company: r.company_name, company_email: r.company_email, created_at: r.created_at, due_at: r.notified_at ? r.due_at : null, deadline_starts: "the day the notice is sent (marked sent)",
    notified_at: r.notified_at, confirmed_at: r.confirmed_at, confirm_note: r.confirm_note,
    status: r.confirmed_at ? "confirmed" : (!r.notified_at ? "to_send" : (new Date(r.due_at) < new Date() ? "overdue" : "waiting")) });

  app.get("/api/admin/company-deletions", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const open = req.query.all ? "" : "WHERE confirmed_at IS NULL";
    const { rows } = await pool.query(`SELECT * FROM company_deletion_notices ${open} ORDER BY id DESC LIMIT 200`);
    res.json({ notices: rows.map(noticeRow) });
  });

  // A ready-to-send email. It names the request by number, date and ZIP only (the homeowner's details are already erased here; the company finds the record by its number).
  app.get("/api/admin/company-deletions/:id/draft", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const n = (await pool.query("SELECT n.*, l.created_at AS lead_created, l.zip FROM company_deletion_notices n LEFT JOIN leads l ON l.id = n.lead_id WHERE n.id = $1", [Number(req.params.id)])).rows[0];
    if (!n) return res.status(404).json({ error: "Notice not found." });
    const due = new Date(Date.now() + COMPANY_CONFIRM_DAYS * 864e5).toISOString().slice(0, 10);   // if sent today; the real deadline is set when it is marked sent
    res.json({ to: n.company_email, subject: `Deletion request for CanopyBid request #${n.lead_id}`,
      body: `Hello ${n.company_name},\n\nThe homeowner who submitted CanopyBid request #${n.lead_id} (submitted ${n.lead_created ? new Date(n.lead_created).toISOString().slice(0, 10) : "unknown date"}, ZIP ${n.zip || "unknown"}) has asked us to delete their information. We have deleted ours.\n\nPlease delete everything you hold about this request: the name, phone number, address, request details and photos, including the email we sent you and any copy in your own systems, unless a law requires you to keep something. If you must keep any of it, tell us what and why.\n\nPlease delete and confirm within ${COMPANY_CONFIRM_DAYS} calendar days of the date of this email (by ${due}). We treat this email as received on the day we send it.\n\nIf you cannot find the record by the request number, date and ZIP code, write to hello@canopybid.com from your registered company email address. Do not send homeowner details by email; we will confirm which request you mean.\n\nThank you,\nCanopyBid\nhello@canopybid.com` });
  });

  app.post("/api/admin/company-deletions/:id/sent", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // The deadline starts now: the day CanopyBid sends the notice. Email delivery is not tracked, so the email is treated as received when sent.
    const r = await pool.query("UPDATE company_deletion_notices SET due_at = CASE WHEN notified_at IS NULL THEN NOW() + ($2 || ' days')::interval ELSE due_at END, notified_at = COALESCE(notified_at, NOW()) WHERE id = $1 RETURNING id", [Number(req.params.id), String(COMPANY_CONFIRM_DAYS)]);
    if (!r.rowCount) return res.status(404).json({ error: "Notice not found." });
    await logAudit({ actorType: "admin", action: "company_deletion_notice_sent", targetType: "notice", targetId: String(req.params.id) });
    res.json({ marked_sent: true });
  });

  app.post("/api/admin/company-deletions/:id/confirmed", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const r = await pool.query("UPDATE company_deletion_notices SET confirmed_at = COALESCE(confirmed_at, NOW()), notified_at = COALESCE(notified_at, NOW()), confirm_note = $2 WHERE id = $1 RETURNING id", [Number(req.params.id), String((req.body || {}).note || "").slice(0, 500) || null]);
    if (!r.rowCount) return res.status(404).json({ error: "Notice not found." });
    await logAudit({ actorType: "admin", action: "company_deletion_confirmed", targetType: "notice", targetId: String(req.params.id) });
    res.json({ confirmed: true });
  });

  // One email per company covering all of its unsent notices (useful after an automatic cleanup).
  app.get("/api/admin/company-deletions/company/:cid/draft", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await pool.query(`SELECT n.*, l.created_at AS lead_created, l.zip FROM company_deletion_notices n LEFT JOIN leads l ON l.id = n.lead_id
      WHERE n.company_id = $1 AND n.confirmed_at IS NULL AND n.notified_at IS NULL ORDER BY n.id`, [Number(req.params.cid)]);
    if (!rows.length) return res.status(404).json({ error: "No unsent notices for that company." });
    const due = new Date(Date.now() + COMPANY_CONFIRM_DAYS * 864e5).toISOString().slice(0, 10);
    const lines = rows.map(n => `  #${n.lead_id}  (submitted ${n.lead_created ? new Date(n.lead_created).toISOString().slice(0, 10) : "unknown"}, ZIP ${n.zip || "unknown"})`).join("\n");
    res.json({ to: rows[0].company_email, notice_ids: rows.map(n => n.id), subject: `Deletion of ${rows.length} CanopyBid request(s)`,
      body: `Hello ${rows[0].company_name},\n\nThe homeowners behind the CanopyBid requests listed below have asked us to delete their information, or the retention period for them has ended. We have deleted ours.\n\n${lines}\n\nPlease delete everything you hold about each of these requests: the name, phone number, address, request details and photos, including our emails and any copy in your own systems (CRM, spreadsheets, notes, phone), unless a law requires you to keep something. If you must keep any of it, tell us what and why.\n\nPlease delete and confirm within ${COMPANY_CONFIRM_DAYS} calendar days of the date of this email (by ${due}). We treat this email as received on the day we send it.\n\nIf you cannot find a record by the request number, date and ZIP code, write to hello@canopybid.com from your registered company email address. Do not send homeowner details by email; we will confirm which request you mean.\n\nThank you,\nCanopyBid\nhello@canopybid.com` });
  });

  app.post("/api/admin/company-deletions/company/:cid/sent", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const r = await pool.query("UPDATE company_deletion_notices SET notified_at = NOW(), due_at = NOW() + ($2 || ' days')::interval WHERE company_id = $1 AND notified_at IS NULL AND confirmed_at IS NULL", [Number(req.params.cid), String(COMPANY_CONFIRM_DAYS)]);
    await logAudit({ actorType: "admin", action: "company_deletion_notices_sent", targetType: "company", targetId: String(req.params.cid), detail: { count: r.rowCount } });
    res.json({ marked_sent: r.rowCount });
  });

  app.post("/api/admin/company-deletions/company/:cid/confirmed", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const r = await pool.query("UPDATE company_deletion_notices SET confirmed_at = NOW(), notified_at = COALESCE(notified_at, NOW()), confirm_note = $2 WHERE company_id = $1 AND confirmed_at IS NULL", [Number(req.params.cid), String((req.body || {}).note || "").slice(0, 500) || null]);
    await logAudit({ actorType: "admin", action: "company_deletions_confirmed", targetType: "company", targetId: String(req.params.cid), detail: { count: r.rowCount } });
    res.json({ confirmed: r.rowCount });
  });

  return { schema, start, autoCleanup, eraseLead, exportDeletionLog, reapplyDeletions };
};

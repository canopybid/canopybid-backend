// Admin alerts: things a human must look at. One table, shown prominently on the admin page and emailed to ADMIN_NOTIFY_EMAIL.
//   kinds: payment_duplicate, payment_after_revocation, payment_docs_not_current   (money taken, needs a decision: refund or reinstate)
//          doc_expired, doc_expiring                                               (a verified document ran out / is about to)
//          lead_unassigned                                                         (a homeowner request nobody was assigned)
// Alerts never change an account by themselves; eligibility is decided by requirements.js at the moment a lead is routed.
module.exports = function initAlerts({ app, pool, requireAdmin, limiter, sendEmail, R, ELIG_COLS, logAudit }) {
  const NOTIFY = () => process.env.ADMIN_NOTIFY_EMAIL || "";
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function schema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_alerts (
      id SERIAL PRIMARY KEY, kind TEXT NOT NULL, severity TEXT DEFAULT 'normal', title TEXT, message TEXT,
      company_id INTEGER, application_id INTEGER, lead_id INTEGER, session_id TEXT, email TEXT, detail TEXT,
      dedupe_key TEXT, status TEXT DEFAULT 'open', created_at TIMESTAMP DEFAULT NOW(), resolved_at TIMESTAMP, resolution_note TEXT)`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_alert_dedupe ON admin_alerts (dedupe_key) WHERE dedupe_key IS NOT NULL");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_admin_alerts_open ON admin_alerts (status, severity)");
  }

  // db = pool or a transaction client. Returns the new row, or null when the same event was already raised (dedupe_key).
  async function raise(a, db) {
    const r = await (db || pool).query(
      `INSERT INTO admin_alerts (kind, severity, title, message, company_id, application_id, lead_id, session_id, email, detail, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
      [a.kind, a.severity || "normal", a.title || a.kind, a.message || "", a.companyId || null, a.applicationId || null, a.leadId || null, a.sessionId || null, a.email || null, a.detail ? JSON.stringify(a.detail) : null, a.dedupe || null]);
    return r.rows[0] || null;
  }
  // Best effort, never throws. Call after the transaction that raised the alert has committed.
  async function announce(row) {
    try {
      if (!row || !NOTIFY()) return;
      if (row.severity !== "high") return;
      await sendEmail({ to: NOTIFY(), subject: `[ACTION NEEDED] ${row.title}`, html: `<p><strong>${esc(row.title)}</strong></p><p>${esc(row.message)}</p><p>Open the admin page, "Needs your attention", to resolve it.</p>` });
    } catch (e) { console.error("[alerts] announce failed:", e.message); }
  }
  async function raiseAndAnnounce(a) { try { const row = await raise(a); await announce(row); return row; } catch (e) { console.error("[alerts] raise failed:", e.message); return null; } }


  // The one explanation every company gets, before (expiring) and after (expired) new requests pause. Says plainly what changes,
  // what does not (billing, existing jobs), and how to restore. Kept in one place so the email, the dashboard and RELEASE.md agree.
  function companyNotice(c, it, exp, expired) {
    const doc = esc(it.label.toLowerCase());
    return `<div style="font-family:Arial,sans-serif;max-width:540px;color:#14261B;line-height:1.5"><p>Hi ${esc(c.name)},</p>
      <p>${expired ? `Your <strong>${doc}</strong> on file expired on ${esc(exp)}.` : `Your <strong>${doc}</strong> on file expires on <strong>${esc(exp)}</strong>.`}</p>
      <p><strong>What changes${expired ? "" : " if it is not replaced by then"}:</strong> ${expired ? "new" : "New"} homeowner requests in your territories are <strong>not</strong> sent to you automatically. They wait with our team instead.</p>
      <p><strong>What does not change:</strong> you can still log in, see and update your existing jobs, and open their photos. <strong>Your subscription continues and you are still billed as normal</strong> while requests are paused. Nothing is refunded or prorated automatically. Your territories stay yours.</p>
      <p><strong>How to ${expired ? "restore requests" : "avoid the pause"}:</strong></p>
      <ol><li>Log in to your partner dashboard.</li><li>Under your documents, upload a current copy of your ${doc}.</li><li>We review it and, if it is accepted, new requests start again. Check your dashboard to see its status.</li></ol>
      <p style="font-size:13px;color:#76856E">Questions? Reply to this email.</p></div>`;
  }
  const REVIEW_WINDOW = Number(process.env.DOC_REVIEW_BUSINESS_DAYS || 5);   // PROPOSED (company terms); owner and lawyer to confirm
  function addBusinessDays(from, n) { const d = new Date(from); let left = n; while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; } d.setUTCHours(23, 59, 59, 999); return d; }
  const fmt = d => { try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return String(d); } };
  // Finds required, previously verified documents of companies that own territories and have run out (or will within 14 days).
  async function scanExpiry() {
    const out = { expired: 0, expiring: 0 };
    const { rows } = await pool.query(`SELECT ${ELIG_COLS}, name, email FROM companies WHERE account_status = 'active' AND EXISTS (SELECT 1 FROM territories t WHERE t.company_id = companies.id)`);
    for (const c of rows) {
      const ds = R.documentStatus(c);
      for (const it of ds.items) {
        if (!it.required) continue;
        const exp = it.expiration ? fmt(it.expiration) : null;
        if (it.state === "expired") {
          const row = await raise({ kind: "doc_expired", severity: "high", companyId: c.id, email: c.email, dedupe: `doc_expired:${c.id}:${it.key}:${exp}`,
            title: `${c.name}: ${it.label} expired`, message: `${it.label} for ${c.name} expired on ${exp}. New requests in their territories are no longer sent to them automatically; they wait in the review queue until a current document is uploaded and verified. Existing jobs stay accessible to them.` });
          if (row) {
            out.expired++; await announce(row);
            await sendEmail({ to: c.email, subject: `Your ${it.label.toLowerCase()} has expired: new requests are paused`, html: companyNotice(c, it, exp, true) }).catch(() => {});
          }
        } else if (it.state === "verified" && it.expiration && new Date(it.expiration).getTime() < Date.now() + 14 * 864e5) {
          const row = await raise({ kind: "doc_expiring", severity: "normal", companyId: c.id, email: c.email, dedupe: `doc_expiring:${c.id}:${it.key}:${exp}`,
            title: `${c.name}: ${it.label} expires ${exp}`, message: `${it.label} for ${c.name} expires on ${exp}. After that, new requests will stop routing to them until a current one is reviewed and accepted.` });
          if (row) { out.expiring++; await sendEmail({ to: c.email, subject: `Your ${it.label.toLowerCase()} expires ${exp}: upload a new one to keep receiving requests`, html: companyNotice(c, it, exp, false) }).catch(() => {}); }
        }
      }
    }
    // Proposed review window (company terms): CanopyBid reviews complete replacement documents within REVIEW_WINDOW business days.
    // Business days are Monday to Friday; holidays are NOT excluded (to be decided). Warn two business days before the end, and again once late.
    out.review_due_soon = 0; out.review_overdue = 0;
    const pend = await pool.query(`SELECT ${ELIG_COLS}, name, email, license_uploaded_at, insurance_uploaded_at FROM companies WHERE account_status = 'active'`);
    for (const c of pend.rows) {
      for (const it of R.documentStatus(c).items) {
        if (!it.required || it.state !== "pending_review") continue;
        const up = c[it.key + "_uploaded_at"]; if (!up) continue;
        const deadline = addBusinessDays(up, REVIEW_WINDOW), warnAt = addBusinessDays(up, Math.max(0, REVIEW_WINDOW - 2));
        const tag = `${c.id}:${it.key}:${fmt(up)}`;
        if (Date.now() > deadline.getTime()) {
          const row = await raise({ kind: "doc_review_overdue", severity: "high", companyId: c.id, email: c.email, dedupe: `doc_review_overdue:${tag}`,
            title: `${c.name}: ${it.label} review is past the ${REVIEW_WINDOW}-business-day window`,
            message: `${c.name} uploaded its ${it.label.toLowerCase()} on ${fmt(up)}. The proposed review window ended ${fmt(deadline)}. Review it now (accept, or reject with a reason). If its requests are paused because of this delay, the company terms propose a credit of 1/30 of the monthly price of the paused territories for each day after the window; apply it by hand in Stripe and note it here.` });
          if (row) { out.review_overdue++; await announce(row); }
        } else if (Date.now() > warnAt.getTime()) {
          const row = await raise({ kind: "doc_review_due_soon", severity: "normal", companyId: c.id, email: c.email, dedupe: `doc_review_due:${tag}`,
            title: `${c.name}: ${it.label} must be reviewed by ${fmt(deadline)}`, message: `${c.name} uploaded its ${it.label.toLowerCase()} on ${fmt(up)}. Review it by ${fmt(deadline)} (${REVIEW_WINDOW} business days) to stay inside the proposed review window.` });
          if (row) out.review_due_soon++;
        }
      }
    }
    return out;
  }

  app.get("/api/admin/alerts", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const status = req.query.status === "resolved" ? "resolved" : "open";
      const { rows } = await pool.query(`SELECT * FROM admin_alerts WHERE status = $1 ORDER BY (severity = 'high') DESC, created_at DESC LIMIT 200`, [status]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: "Could not load alerts." }); }
  });
  app.post("/api/admin/alerts/:id/resolve", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const note = String((req.body || {}).note || "").slice(0, 500);
      const r = await pool.query("UPDATE admin_alerts SET status = 'resolved', resolved_at = NOW(), resolution_note = $2 WHERE id = $1 AND status = 'open' RETURNING id", [Number(req.params.id), note || null]);
      if (!r.rowCount) return res.status(404).json({ error: "Alert not found or already resolved." });
      await logAudit({ actorType: "admin", action: "alert_resolved", targetType: "alert", targetId: req.params.id, detail: { note } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "Could not resolve." }); }
  });
  app.post("/api/admin/alerts/scan", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await scanExpiry()); } catch (e) { console.error("[alerts/scan]", e); res.status(500).json({ error: "Scan failed." }); }
  });

  function startSweep() {
    const every = Number(process.env.ALERT_SWEEP_MS === undefined ? 6 * 3600e3 : process.env.ALERT_SWEEP_MS);
    if (!every) return;
    const run = () => scanExpiry().catch(e => console.error("[alerts] scan failed:", e.message));
    setTimeout(run, 30e3).unref && 0; setInterval(run, every).unref();
  }
  return { schema, raise, announce, raiseAndAnnounce, scanExpiry, startSweep };
};

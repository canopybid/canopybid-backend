// Outbid ("bid up") feature. Another company may bid a higher monthly price for a territory that is already claimed.
//
// Rules (all constants below):
//  * A bid must be at least MIN_STEP dollars/month above the territory's current price (or the highest open bid).
//  * The bidder saves a card through Stripe Checkout in SETUP mode. Nothing is charged at bid time.
//  * The owner has MATCH_HOURS from the first open bid to match it. Matching raises the owner's own subscription to the
//    bid price and the bid is closed ("matched").
//  * If the owner does not match in time, the bidder's card is charged by creating their subscription at the bid price.
//    Only if that succeeds does the territory move: the old owner's line is removed from their Stripe subscription
//    (cancelled outright if it was their only territory) and the territory, price and leads now route to the bidder.
//    If the card is declined, the bid fails and the owner keeps the territory.
//  * One territory can have only one open bid; a higher bid replaces the previous one (the clock keeps running).
//  * Bids can only be placed on a territory that is claimed, offered, not retired, and whose owner is not the bidder.
const crypto = require("crypto");
const apiKeys = require("./apikeys");

const MIN_STEP = 25;
const MATCH_HOURS = 72;
const SWEEP_MS = Number(process.env.BID_SWEEP_MS || 20000);   // minimum gap between lazy sweeps triggered by page loads

module.exports = function initBids(d) {
  const { app, pool, stripe, sendEmail, requireAdmin, authCompany, limiter, logAudit, basePrice, FRONTEND_URL, applications, alerts } = d;
  const when = x => new Date(x).toUTCString();
  const priceOf = t => t.current_price || basePrice(t.factor);
  const money = n => "$" + Number(n).toLocaleString("en-US") + "/month";
  const label = t => `${t.metro}: ${t.display_name || t.name}`;
  const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ""));

  async function schema() {
    await pool.query("ALTER TABLE territories ADD COLUMN IF NOT EXISTS current_price INTEGER");        // what the owner pays now (null = base price)
    await pool.query("ALTER TABLE territories ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT");   // subscription that carries this territory's line
    await pool.query(`CREATE TABLE IF NOT EXISTS bids (
      id SERIAL PRIMARY KEY,
      territory_id INTEGER NOT NULL REFERENCES territories(id),
      owner_company_id INTEGER REFERENCES companies(id),
      bidder_name TEXT NOT NULL, bidder_email TEXT NOT NULL, bidder_phone TEXT,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_setup',
      setup_session_id TEXT, stripe_customer_id TEXT, payment_method_id TEXT,
      match_deadline TIMESTAMP,
      resolved_note TEXT, won_company_id INTEGER REFERENCES companies(id),
      created_at TIMESTAMP DEFAULT NOW(), resolved_at TIMESTAMP
    )`);
    // database-level rule: at most one open bid per territory
    await pool.query("ALTER TABLE bids ADD COLUMN IF NOT EXISTS application_id INTEGER");      // the approved application this bid came from
    await pool.query("ALTER TABLE bids ADD COLUMN IF NOT EXISTS source_company_id INTEGER");   // or the existing partner who bid (API key)
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_bid ON bids (territory_id) WHERE status = 'pending_setup'");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_active_bid ON bids (territory_id) WHERE status IN ('active','resolving')");
  }

  // Stripe line item for one territory. The territory id travels in the product metadata so a single line can be found later.
  const lineItem = (t, amount) => ({
    price_data: { currency: "usd", recurring: { interval: "month" }, unit_amount: amount * 100,
      product_data: { name: `CanopyBid territory — ${label(t)}`, metadata: { territory_id: String(t.id) } } },
    quantity: 1
  });

  async function findItem(subId, territoryId) {
    const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price.product"] });
    const items = (sub.items && sub.items.data) || [];
    const item = items.find(i => i.price && i.price.product && i.price.product.metadata && String(i.price.product.metadata.territory_id) === String(territoryId));
    return { sub, items, item };
  }

  // Takes one territory's line off a subscription; cancels the whole subscription when it is the only line.
  async function removeTerritoryLine(subId, territoryId) {
    if (!subId) return { skipped: "no subscription recorded" };
    const { items, item } = await findItem(subId, territoryId);
    if (items.length <= 1) { await stripe.subscriptions.cancel(subId); return { cancelled: true }; }
    if (!item) return { skipped: "line not found; remove it in Stripe by hand" };
    await stripe.subscriptionItems.del(item.id, { proration_behavior: "none" });
    return { line_removed: true };
  }

  async function ownerOf(t) {
    if (!t.company_id) return null;
    return (await pool.query("SELECT * FROM companies WHERE id = $1", [t.company_id])).rows[0] || null;
  }

  // ---- 1. Place a bid -------------------------------------------------------------------------------------------
  app.post("/api/bids/create", limiter, async (req, res) => {
    if (!stripe) return res.status(500).json({ error: "Payments are not configured." });
    let name = String(req.body.name || "").trim().slice(0, 120), email = String(req.body.email || "").trim().slice(0, 200);
    let phone = String(req.body.phone || "").trim().slice(0, 40);
    const tid = Number(req.body.territory_id), amount = Number(req.body.amount);
    if (!name || !emailOk(email) || !Number.isInteger(tid) || !Number.isInteger(amount)) return res.status(400).json({ error: "Provide name, a valid email, territory_id and a whole-dollar amount." });
    try {
      // Only an approved partner may bid (private link, or an existing eligible partner's API key); payment alone never qualifies a company.
      const gate = await applications.authorize(req, { email });
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code, pending: gate.pending, approval_required: true });
      if (gate.app) { name = gate.app.name; email = gate.app.email; phone = gate.app.phone || phone; }
      else if (gate.company) { name = gate.company.name; email = gate.company.email; phone = gate.company.phone || phone; }
      await resolveDueBids();
      const client = await pool.connect();
      let bid, t, owner;
      try {
        await client.query("BEGIN");
        const tr = await client.query("SELECT * FROM territories WHERE id = $1 FOR UPDATE", [tid]);
        t = tr.rows[0];
        if (!t || t.retired === 1 || t.offered !== 1) { await client.query("ROLLBACK"); return res.status(400).json({ error: "That territory is not open for bids." }); }
        if (!t.company_id) { await client.query("ROLLBACK"); return res.status(400).json({ error: "That territory is not claimed. Buy it directly instead." }); }
        owner = (await client.query("SELECT * FROM companies WHERE id = $1", [t.company_id])).rows[0];
        if (owner && String(owner.email).toLowerCase() === email.toLowerCase()) { await client.query("ROLLBACK"); return res.status(400).json({ error: "You already own this territory." }); }
        const live = (await client.query("SELECT * FROM bids WHERE territory_id = $1 AND status IN ('active','resolving')", [tid])).rows[0];
        if (live && live.status === "resolving") { await client.query("ROLLBACK"); return res.status(409).json({ error: "This territory is being transferred right now. Try again in a few minutes." }); }
        const open = (await client.query("SELECT * FROM bids WHERE territory_id = $1 AND status = 'pending_setup'", [tid])).rows[0];
        const floor = Math.max(priceOf(t), live ? live.amount : 0);
        const min = floor + MIN_STEP;
        if (amount < min) { await client.query("ROLLBACK"); return res.status(400).json({ error: `Bids must be at least ${money(min)}.`, min_bid: min }); }
        if (amount > 5000) { await client.query("ROLLBACK"); return res.status(400).json({ error: "That amount is too high." }); }
        if (open) {   // someone else is mid-way through placing a bid: do not let two people race
          if (String(open.bidder_email).toLowerCase() !== email.toLowerCase() && new Date(open.created_at).getTime() > Date.now() - 35 * 60 * 1000) {
            await client.query("ROLLBACK"); return res.status(409).json({ error: "Another company is placing a bid on this territory right now. Try again in a few minutes." });
          }
          await client.query("UPDATE bids SET status = 'canceled', resolved_at = NOW(), resolved_note = 'replaced before card was saved' WHERE id = $1", [open.id]);
        }
        const ins = await client.query(
          "INSERT INTO bids (territory_id, owner_company_id, bidder_name, bidder_email, bidder_phone, amount, application_id, source_company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [tid, t.company_id, name, email, phone || null, amount, gate.app ? gate.app.id : null, gate.company ? gate.company.id : null]);
        bid = ins.rows[0];
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); if (e.code === "23505") return res.status(409).json({ error: "This territory already has a bid in progress. Try again shortly." }); throw e; }
      finally { client.release(); }

      let session;
      try {
        const customer = await stripe.customers.create({ email, name, metadata: { bid_id: String(bid.id) } });
        session = await stripe.checkout.sessions.create({
          mode: "setup", currency: "usd", customer: customer.id, payment_method_types: ["card"],
          expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
          success_url: `${FRONTEND_URL}/canopybid-companies.html?bid_session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${FRONTEND_URL}/canopybid-companies.html?bid_canceled=1`,
          metadata: { bid_id: String(bid.id) }
        });
        await pool.query("UPDATE bids SET setup_session_id = $1, stripe_customer_id = $2 WHERE id = $3", [session.id, customer.id, bid.id]);
      } catch (e) {
        await pool.query("UPDATE bids SET status = 'canceled', resolved_at = NOW(), resolved_note = 'stripe error' WHERE id = $1", [bid.id]);
        throw e;
      }
      res.json({ url: session.url, amount, territory: label(t), note: "Your card is saved now but charged only if the current owner does not match your bid within " + MATCH_HOURS + " hours." });
    } catch (err) {
      console.error("[bids/create] Failed:", err);
      res.status(500).json({ error: "Could not start your bid." });
    }
  });

  // ---- 2. Card saved -> bid becomes active; owner is told --------------------------------------------------------
  async function activateBidFromSession(session) {
    const bidId = Number(session.metadata && session.metadata.bid_id);
    if (!bidId || !session.setup_intent) return null;
    const si = await stripe.setupIntents.retrieve(typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id);
    const pm = si.payment_method && (typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id);
    if (!pm || si.status !== "succeeded") return null;
    const client = await pool.connect();
    let bid, t, owner, first;
    try {
      await client.query("BEGIN");
      bid = (await client.query("SELECT * FROM bids WHERE id = $1 FOR UPDATE", [bidId])).rows[0];
      if (!bid) { await client.query("ROLLBACK"); return null; }
      if (bid.status === "active") { await client.query("COMMIT"); return bid; }       // already activated (browser + webhook both arrive)
      if (bid.status !== "pending_setup") { await client.query("ROLLBACK"); return null; }
      t = (await client.query("SELECT * FROM territories WHERE id = $1 FOR UPDATE", [bid.territory_id])).rows[0];
      if (!t.company_id || t.company_id !== bid.owner_company_id) {   // territory changed hands or was released while the bidder was paying
        await client.query("UPDATE bids SET status = 'canceled', resolved_at = NOW(), resolved_note = 'territory changed before card was saved' WHERE id = $1", [bidId]);
        await client.query("COMMIT"); return null;
      }
      // Earlier active bid on this territory is replaced; the owner's clock keeps running from the first bid.
      if ((await client.query("SELECT 1 FROM bids WHERE territory_id = $1 AND status = 'resolving'", [bid.territory_id])).rowCount) { await client.query("UPDATE bids SET status = 'canceled', resolved_at = NOW(), resolved_note = 'territory was being transferred' WHERE id = $1", [bidId]); await client.query("COMMIT"); return null; }
      const prev = (await client.query("SELECT * FROM bids WHERE territory_id = $1 AND status = 'active' AND id <> $2 FOR UPDATE", [bid.territory_id, bidId])).rows[0];
      if (prev && prev.amount >= bid.amount) { await client.query("UPDATE bids SET status = 'canceled', resolved_at = NOW(), resolved_note = 'a higher bid was already active' WHERE id = $1", [bidId]); await client.query("COMMIT"); return null; }
      first = !prev;
      const deadline = prev ? prev.match_deadline : new Date(Date.now() + MATCH_HOURS * 3600 * 1000);
      if (prev) await client.query("UPDATE bids SET status = 'outbid', resolved_at = NOW(), resolved_note = 'replaced by a higher bid' WHERE id = $1", [prev.id]);
      await client.query("UPDATE bids SET status = 'active', payment_method_id = $1, match_deadline = $2 WHERE id = $3", [pm, deadline, bidId]);
      await stripe.customers.update(bid.stripe_customer_id, { invoice_settings: { default_payment_method: pm } });
      bid = (await client.query("SELECT * FROM bids WHERE id = $1", [bidId])).rows[0];
      owner = (await client.query("SELECT * FROM companies WHERE id = $1", [t.company_id])).rows[0];
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
    await logAudit({ actorType: "system", action: "bid_active", targetType: "territory", targetId: bid.territory_id, detail: { bid_id: bid.id, amount: bid.amount, first } });
    if (owner) await sendEmail({ to: owner.email, subject: `A company bid ${money(bid.amount)} for your ${label(t)} territory`,
      html: `<p>Another company has bid <strong>${money(bid.amount)}</strong> for <strong>${label(t)}</strong>. You currently pay ${money(priceOf(t))}.</p>
<p><strong>To keep the territory you must match ${money(bid.amount)}, the highest bid so far. Your decision is due by ${when(bid.match_deadline)}.</strong></p>
<p>If another company bids higher before then, you will get a new email with the higher amount to match. A later bid does not extend the deadline.</p>
<ul>
<li><strong>Match the bid:</strong> open your partner dashboard and choose <em>Match bid</em>. You keep the territory and your price becomes ${money(bid.amount)} from your next billing date (no extra charge now).</li>
<li><strong>Do nothing:</strong> at ${when(bid.match_deadline)} the territory transfers. New requests for it go to the new owner from that moment, and you are not billed for it again.</li>
<li><strong>Your existing leads stay with you.</strong> Every request already sent to you remains in your dashboard, and you can keep working those jobs and conversations after the transfer.</li>
</ul>`
    });
    await sendEmail({ to: bid.bidder_email, subject: `Your bid on ${label(t)} is in`,
      html: `<p>Your bid of <strong>${money(bid.amount)}</strong> for <strong>${label(t)}</strong> is active. Your card was saved but has not been charged.</p>
<ul>
<li><strong>Transfer date:</strong> if the owner does not match by ${when(bid.match_deadline)}, the territory becomes yours at that time and you are charged ${money(bid.amount)} for the first month.</li>
<li>If they match, nothing is charged and we will tell you.</li>
<li><strong>Existing leads:</strong> requests already sent to the current owner stay with them. You receive new requests from the transfer date, once your license and insurance documents are current and accepted.</li>
</ul>`
    });
    return bid;
  }

  app.get("/api/bids/confirm", async (req, res) => {
    if (!stripe) return res.status(500).json({ error: "Payments are not configured." });
    const sid = req.query.session_id;
    if (!sid) return res.status(400).json({ error: "Missing session_id." });
    try {
      const session = await stripe.checkout.sessions.retrieve(String(sid));
      if (session.mode !== "setup" || session.status !== "complete") return res.status(402).json({ error: "Your card was not saved." });
      const bid = await activateBidFromSession(session);
      if (!bid) return res.status(409).json({ error: "This bid is no longer open (the territory changed or a higher bid was already in)." });
      const t = (await pool.query("SELECT * FROM territories WHERE id = $1", [bid.territory_id])).rows[0];
      res.json({ ok: true, territory: label(t), amount: bid.amount, match_deadline: bid.match_deadline, transfer_if_unmatched_at: bid.match_deadline });
    } catch (err) {
      console.error("[bids/confirm] Failed:", err);
      res.status(500).json({ error: "Could not confirm your bid." });
    }
  });

  async function expireBidSession(session) {
    const bidId = Number(session.metadata && session.metadata.bid_id);
    if (bidId) await pool.query("UPDATE bids SET status = 'canceled', resolved_at = NOW(), resolved_note = 'checkout expired' WHERE id = $1 AND status = 'pending_setup'", [bidId]);
  }

  // ---- 3. Owner matches ----------------------------------------------------------------------------------------
  app.get("/api/companies/me/bids", async (req, res) => {
    const co = await authCompany(req);
    if (!co) return res.status(401).json({ error: "Invalid API key." });
    await resolveDueBids();
    const { rows } = await pool.query(`SELECT b.id, b.territory_id, b.amount, b.match_deadline, t.name, t.display_name, t.metro, t.current_price, t.factor
      FROM bids b JOIN territories t ON t.id = b.territory_id WHERE b.owner_company_id = $1 AND b.status = 'active' ORDER BY b.match_deadline`, [co.id]);
    res.json(rows.map(r => ({ id: r.id, territory_id: r.territory_id, territory: r.display_name || r.name, metro: r.metro, bid_amount: r.amount, your_price: priceOf(r), match_deadline: r.match_deadline, transfer_at: r.match_deadline, existing_leads_stay_with_you: true })));
  });

  app.post("/api/companies/me/bids/:id/match", async (req, res) => {
    const co = await authCompany(req);
    if (!co) return res.status(401).json({ error: "Invalid API key." });
    if (!stripe) return res.status(500).json({ error: "Payments are not configured." });
    const bidId = Number(req.params.id);
    const client = await pool.connect();
    let bid, t;
    try {
      await client.query("BEGIN");
      bid = (await client.query("SELECT * FROM bids WHERE id = $1 FOR UPDATE", [bidId])).rows[0];
      if (!bid || bid.owner_company_id !== co.id) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bid not found." }); }
      if (bid.status !== "active") { await client.query("ROLLBACK"); return res.status(409).json({ error: "This bid is no longer open." }); }
      if (new Date(bid.match_deadline).getTime() <= Date.now()) { await client.query("ROLLBACK"); return res.status(409).json({ error: "The matching window has closed." }); }
      t = (await client.query("SELECT * FROM territories WHERE id = $1 FOR UPDATE", [bid.territory_id])).rows[0];
      if (t.company_id !== co.id) { await client.query("ROLLBACK"); return res.status(409).json({ error: "You no longer own this territory." }); }
      const subId = t.stripe_subscription_id || co.stripe_subscription_id;
      if (!subId) { await client.query("ROLLBACK"); return res.status(409).json({ error: "No subscription on file for this territory. Contact support." }); }
      const { item } = await findItem(subId, t.id);
      if (!item) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Could not find this territory on your subscription. Contact support." }); }
      // Raise the owner's own price to the bid. No proration: the new price starts at the next billing date.
      // Products created inline by Checkout are inactive in Stripe and cannot take new prices, so make a fresh active product carrying the same territory tag.
      const prod = await stripe.products.create({ name: `CanopyBid territory — ${label(t)}`, metadata: { territory_id: String(t.id) } });
      await stripe.subscriptions.update(subId, { proration_behavior: "none", items: [{ id: item.id, price_data: { currency: "usd", recurring: { interval: "month" }, unit_amount: bid.amount * 100, product: prod.id } }] });
      await client.query("UPDATE territories SET current_price = $1 WHERE id = $2", [bid.amount, t.id]);
      await client.query("UPDATE bids SET status = 'matched', resolved_at = NOW(), resolved_note = 'owner matched' WHERE id = $1", [bid.id]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error("[bids/match] Failed:", e); return res.status(500).json({ error: "Could not match the bid." }); }
    finally { client.release(); }
    await logAudit({ actorType: "company", actorId: String(co.id), action: "bid_matched", targetType: "territory", targetId: bid.territory_id, detail: { bid_id: bid.id, amount: bid.amount } });
    await sendEmail({ to: bid.bidder_email, subject: `The owner matched your bid on ${label(t)}`, html: `<p>The current owner matched your bid of ${money(bid.amount)}, so the territory stays with them. Your card was not charged. You are welcome to bid higher.</p>` });
    res.json({ matched: true, new_price: bid.amount });
  });

  // ---- 4. Deadline passed -> takeover ---------------------------------------------------------------------------
  async function resolveBid(bidId) {
    const client = await pool.connect();
    let bid, t;
    try {
      await client.query("BEGIN");
      bid = (await client.query("SELECT * FROM bids WHERE id = $1 FOR UPDATE", [bidId])).rows[0];
      if (!bid || bid.status !== "active" || new Date(bid.match_deadline).getTime() > Date.now()) { await client.query("ROLLBACK"); return null; }
      await client.query("UPDATE bids SET status = 'resolving' WHERE id = $1", [bidId]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }

    t = (await pool.query("SELECT * FROM territories WHERE id = $1", [bid.territory_id])).rows[0];
    const oldOwner = await ownerOf(t);
    const fail = async (note, paymentFailed) => {
      await pool.query("UPDATE bids SET status = 'failed', resolved_at = NOW(), resolved_note = $1 WHERE id = $2", [note, bid.id]);
      await sendEmail({ to: bid.bidder_email, subject: `Your bid on ${label(t)} could not be completed`, html: `<p>We could not charge your card for ${money(bid.amount)}, so the territory stays with its current owner. You may place a new bid with another card.</p>` });
      // If the winning bidder's payment fails, the territory stays with the current holder, nothing is charged to anyone else automatically
      // (earlier, lower bids are not tried), and the holder is told so.
      if (paymentFailed && oldOwner && oldOwner.email) await sendEmail({ to: oldOwner.email, subject: `You keep ${label(t)}: the bid on it could not be completed`, html: `<p>The company that bid ${money(bid.amount)} for <strong>${label(t)}</strong> could not be charged, so that bid has ended and <strong>you keep the territory</strong> at your current price of ${money(priceOf(t))}. You do not need to do anything. We do not automatically move the territory to any other bidder. If a new bid arrives we will email you again.</p>` });
      return { bid: bid.id, result: "failed", note };
    };
    if (!t.company_id || t.company_id !== bid.owner_company_id) return fail("territory changed owners");

    // Charge the bidder first. If this fails, nothing else changes.
    let sub;
    try {
      // Subscriptions (unlike Checkout) cannot take an inline product, so make a real one carrying the territory tag.
      const prod = await stripe.products.create({ name: `CanopyBid territory — ${label(t)}`, metadata: { territory_id: String(t.id) } });
      sub = await stripe.subscriptions.create({
        customer: bid.stripe_customer_id, default_payment_method: bid.payment_method_id,
        items: [{ price_data: { currency: "usd", recurring: { interval: "month" }, unit_amount: bid.amount * 100, product: prod.id }, quantity: 1 }],
        payment_behavior: "error_if_incomplete"
      });
    } catch (e) { console.error("[bids/resolve] charge failed:", e.message); return fail("card declined or Stripe error", true); }

    let setupLink = null;
    const c2 = await pool.connect();
    let newCompanyId;
    try {
      await c2.query("BEGIN");
      const ins = await c2.query("INSERT INTO companies (name, email, phone, stripe_customer_id, stripe_subscription_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [bid.bidder_name, bid.bidder_email, bid.bidder_phone, bid.stripe_customer_id, sub.id]);
      newCompanyId = ins.rows[0].id;
      setupLink = await apiKeys.issueSetupLink(c2, newCompanyId, "setup");   // same one-time-link process as a checkout account; no key is emailed
      await applications.inherit(c2, newCompanyId, { applicationId: bid.application_id, sourceCompanyId: bid.source_company_id });
      if (bid.application_id) await applications.markUsed(c2, bid.application_id, newCompanyId);
      await c2.query("UPDATE territories SET company_id = $1, current_price = $2, stripe_subscription_id = $3 WHERE id = $4", [newCompanyId, bid.amount, sub.id, t.id]);
      await c2.query("UPDATE bids SET status = 'won', won_company_id = $1, resolved_at = NOW(), resolved_note = 'owner did not match' WHERE id = $2", [newCompanyId, bid.id]);
      if (oldOwner) {
        const left = await c2.query("SELECT COUNT(*)::int AS n FROM territories WHERE company_id = $1", [oldOwner.id]);
        if (left.rows[0].n === 0) await apiKeys.setStatus(c2, oldOwner.id, "inactive");   // lost its last territory: no new requests; dashboard access to existing requests stays
      }
      await c2.query("COMMIT");
    } catch (e) {
      await c2.query("ROLLBACK").catch(() => {});
      try { await stripe.subscriptions.cancel(sub.id); } catch (_) { /* surfaced below */ }
      await pool.query("UPDATE bids SET status = 'failed', resolved_at = NOW(), resolved_note = 'database error during takeover; bidder subscription cancelled' WHERE id = $1", [bid.id]);
      throw e;
    } finally { c2.release(); }

    // The territory is the bidder's now; end the old owner's billing for it. A Stripe hiccup here is logged for manual cleanup
    // rather than undoing the transfer, and the audit log records exactly what to fix.
    // Proposed policy: the former owner gets a prorated refund of the unused part of the paid period, to the original payment method. The software
    // works out the amount from Stripe's billing period BEFORE the line is removed and raises an admin alert; the refund itself is a manual step in Stripe.
    let refundNote = "work out the unused part of the paid period by hand";
    try {
      const sid0 = t.stripe_subscription_id || (oldOwner && oldOwner.stripe_subscription_id);
      if (sid0 && oldOwner) {
        const { sub: s0, item: it0 } = await findItem(sid0, t.id);
        const pend = Number((s0 && s0.current_period_end) || (it0 && it0.current_period_end)), pstart = Number((s0 && s0.current_period_start) || (it0 && it0.current_period_start));
        if (pend && pstart && pend > pstart) {
          const nowS = Date.now() / 1000, left = Math.max(0, Math.min(pend - nowS, pend - pstart)), price0 = priceOf(t);
          const amt = Math.round(price0 * 100 * left / (pend - pstart)) / 100;
          refundNote = `about $${amt.toFixed(2)} (${money(price0)} x ${(left / 86400).toFixed(1)} of ${((pend - pstart) / 86400).toFixed(0)} days left in the paid period ending ${new Date(pend * 1000).toISOString().slice(0, 10)}); check it against the invoice before refunding`;
        }
      }
    } catch (e) { console.error("[bids/resolve] could not work out the refund amount:", e.message); }
    let removal = null;
    try { removal = await removeTerritoryLine(t.stripe_subscription_id || (oldOwner && oldOwner.stripe_subscription_id), t.id); }
    catch (e) { removal = { error: String(e.message || e) }; console.error("[bids/resolve] could not remove old owner's line - FIX IN STRIPE:", t.id, removal); }
    if (oldOwner && alerts) await alerts.raiseAndAnnounce({ kind: "takeover_refund_due", severity: "high", companyId: oldOwner.id,
      title: `Refund due: ${oldOwner.name} lost ${label(t)} to a takeover`,
      message: `${oldOwner.name} (${oldOwner.email}) lost ${label(t)} to another company mid-period. Proposed policy: refund the unused part of the paid period to its original payment method. Amount: ${refundNote}. Steps: in Stripe open the latest paid invoice for subscription ${t.stripe_subscription_id || oldOwner.stripe_subscription_id || "(unknown)"}, choose Refund, enter that amount, reason "requested by customer / takeover"; tell the company by email; then resolve this alert.`,
      dedupe: `takeover_refund:${bid.id}` });
    await logAudit({ actorType: "system", action: "bid_won", targetType: "territory", targetId: t.id, detail: { bid_id: bid.id, amount: bid.amount, old_company: oldOwner && oldOwner.id, new_company: newCompanyId, removal } });
    if (oldOwner) await sendEmail({ to: oldOwner.email, subject: `You no longer hold ${label(t)}`, html: `<p>The matching window ended without a matching bid, so <strong>${label(t)}</strong> has moved to another company. New requests for it now go to the new owner, and you will not be billed for it again.</p><p><strong>Your existing requests stay with you.</strong> Everything already sent to you remains in your partner dashboard (sign in the same way as before) so you can finish those conversations and jobs, until our retention and deletion rules remove each request. If you hold no other territory you will not receive new requests. Thank you for being a CanopyBid partner.</p>` });
    await sendEmail({ to: bid.bidder_email, subject: `You won ${label(t)}`,
      html: `<p>You now hold <strong>${label(t)}</strong> at ${money(bid.amount)}. Your card was charged for the first month.</p><p><a href="${apiKeys.setupUrl(FRONTEND_URL, setupLink.token)}">Set up your dashboard (one-time sign-in link)</a></p><p>The link works once and expires in ${setupLink.hours} hours. If it has expired, ask for a new one on the dashboard sign-in page. We never email a reusable key.</p><p>You receive new requests for this territory from now on, once your license and insurance documents are current and accepted. Upload both in the partner dashboard. Requests already sent to the previous owner stay with them.</p>` });
    return { bid: bid.id, result: "won", new_company_id: newCompanyId, removal };
  }

  let lastSweep = 0, sweeping = null;
  async function resolveDueBids(force) {
    if (!force && Date.now() - lastSweep < SWEEP_MS) return [];
    if (sweeping) return sweeping;
    lastSweep = Date.now();
    sweeping = (async () => {
      const out = [];
      try {
        const { rows } = await pool.query("SELECT id FROM bids WHERE status = 'active' AND match_deadline <= NOW()");
        for (const r of rows) { try { const x = await resolveBid(r.id); if (x) out.push(x); } catch (e) { console.error("[bids/resolve] Failed:", r.id, e); } }
      } finally { sweeping = null; }
      return out;
    })();
    return sweeping;
  }

  app.post("/api/admin/bids/resolve", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      // Test shortcut: end one bid's 72-hour window now. Refused unless Stripe is in test mode, so it can never touch live money.
      const b = req.body || {};
      if (b.end_window_now) {
        if (!String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test_")) return res.status(403).json({ error: "Only available while Stripe is in test mode." });
        const u = await pool.query("UPDATE bids SET match_deadline = NOW() - INTERVAL '1 second' WHERE id = $1 AND status = 'active'", [Number(b.bid_id)]);
        if (!u.rowCount) return res.status(404).json({ error: "No active bid with that id." });
      }
      res.json({ resolved: await resolveDueBids(true) });
    } catch (e) { res.status(500).json({ error: "Could not resolve bids." }); }
  });
  app.get("/api/admin/bids", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await pool.query("SELECT id, territory_id, owner_company_id, bidder_name, bidder_email, amount, status, match_deadline, resolved_note, created_at FROM bids ORDER BY id DESC LIMIT 200");
    res.json(rows);
  });

  // Public summary used by the territory list: the price a new bid must beat, and whether a bid is open.
  async function publicBidInfo() {
    const { rows } = await pool.query("SELECT territory_id, amount FROM bids WHERE status = 'active'");
    const m = {}; rows.forEach(r => { m[r.territory_id] = r.amount; });
    return m;
  }

  setInterval(() => { resolveDueBids(true).catch(e => console.error("[bids] sweep failed:", e)); }, 5 * 60 * 1000).unref();
  return { schema, activateBidFromSession, expireBidSession, resolveDueBids, publicBidInfo, priceOf, MIN_STEP, MATCH_HOURS };
};

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("node:crypto");
const { pool, initDb } = require("./db");

const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());

// Rate limiting on public-facing endpoints — someone hammering the leads or
// checkout endpoints (bot or otherwise) shouldn't be able to flood the DB or
// run up your Anthropic/Stripe bills.
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes and try again." }
});

async function logAudit({ actorType, actorId, action, targetType, targetId, detail }) {
  try {
    await pool.query(
      "INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6)",
      [actorType, actorId ? String(actorId) : null, action, targetType || null, targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null]
    );
  } catch (err) {
    console.error("[audit] Failed to log:", err);
  }
}
// Stripe webhook: needs the RAW request body to verify the signature, so it is mounted BEFORE the JSON parser.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => stripeWebhook(req, res));
app.use(express.json({ limit: "50mb" })); // photos come through as base64, so raise the default limit

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CHECKOUT_HOLD_MINUTES = 35;   // a territory is held for one buyer while their Stripe checkout is open (Stripe sessions expire after 31 min)
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5500";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "CanopyBid <onboarding@resend.dev>";

// Sends an email via Resend. Never throws — a notification failure should
// never block a lead submission or checkout from succeeding.
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn(`[email] RESEND_API_KEY not set — skipping email to ${to} ("${subject}").`);
    return { skipped: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[email] Failed to send to ${to}:`, data);
      return { error: data };
    }
    console.log(`[email] Sent to ${to}: "${subject}"`);
    return { success: true, id: data.id };
  } catch (err) {
    console.error(`[email] Failed to send to ${to}:`, err);
    return { error: String(err) };
  }
}

function companyLeadEmailHtml(l, company, matchedTerritory) {
  const treeCount = (l.trees || []).length || 1;
  const priceLine = l.quote_low ? `$${Number(l.quote_low).toLocaleString()} – $${Number(l.quote_high).toLocaleString()}` : "Inspection needed before pricing";
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #14261B;">
      <div style="background:#14261B; padding:18px 24px; border-radius:10px 10px 0 0;">
        <span style="color:#F3EFE4; font-size:18px; font-weight:bold;">New lead in ${matchedTerritory || l.territory_name}</span>
      </div>
      <div style="border:1px solid #eee; border-top:none; padding:22px 24px; border-radius:0 0 10px 10px;">
        <p style="font-size:15px; margin:0 0 14px;">A homeowner just accepted a preliminary estimate in your territory. Fast responses win more jobs — most homeowners contact more than one option if they don't hear back quickly.</p>
        <table style="width:100%; font-size:14px; border-collapse:collapse;">
          <tr><td style="padding:4px 0; color:#76856E;">Name</td><td style="padding:4px 0; font-weight:bold;">${l.name}</td></tr>
          <tr><td style="padding:4px 0; color:#76856E;">Phone</td><td style="padding:4px 0; font-weight:bold;">${l.phone}</td></tr>
          <tr><td style="padding:4px 0; color:#76856E;">Address</td><td style="padding:4px 0;">${l.address || "—"}</td></tr>
          <tr><td style="padding:4px 0; color:#76856E;">Trees</td><td style="padding:4px 0;">${treeCount}</td></tr>
          <tr><td style="padding:4px 0; color:#76856E;">Services</td><td style="padding:4px 0;">${(l.services || []).join(", ")}</td></tr>
          <tr><td style="padding:4px 0; color:#76856E;">Preliminary range</td><td style="padding:4px 0; font-weight:bold;">${priceLine}</td></tr>
        </table>
        <p style="font-size:12.5px; color:#76856E; margin-top:18px;">Log into your CanopyBid account for full photos and AI analysis on each tree.</p>
      </div>
    </div>`;
}

function homeownerConfirmationEmailHtml(l, matched) {
  const priceLine = l.quote_low ? `$${Number(l.quote_low).toLocaleString()} – $${Number(l.quote_high).toLocaleString()}` : "Pending on-site inspection";
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #14261B;">
      <div style="background:#14261B; padding:18px 24px; border-radius:10px 10px 0 0;">
        <span style="color:#F3EFE4; font-size:18px; font-weight:bold;">We've got your request</span>
      </div>
      <div style="border:1px solid #eee; border-top:none; padding:22px 24px; border-radius:0 0 10px 10px;">
        <p style="font-size:15px; margin:0 0 14px;">Hi ${l.name}, thanks for using CanopyBid. Here's a copy of what you submitted.</p>
        <table style="width:100%; font-size:14px; border-collapse:collapse;">
          <tr><td style="padding:4px 0; color:#76856E;">Address</td><td style="padding:4px 0;">${l.address || "—"}</td></tr>
          <tr><td style="padding:4px 0; color:#76856E;">Services</td><td style="padding:4px 0;">${(l.services || []).join(", ")}</td></tr>
          <tr><td style="padding:4px 0; color:#76856E;">Preliminary range</td><td style="padding:4px 0; font-weight:bold;">${priceLine}</td></tr>
        </table>
        <p style="font-size:13px; margin-top:18px;">${matched ? "A local tree company covering your area has been notified and should reach out soon." : "Our team will review your request and follow up with next steps."} This is a preliminary estimate, not a final price — the company will confirm details on-site.</p>
      </div>
    </div>`;
}

function requireAdmin(req, res) {
  if (!ADMIN_API_KEY) {
    res.status(500).json({ error: "Server is missing ADMIN_API_KEY. Set it in your .env file." });
    return false;
  }
  const key = req.header("x-admin-key");
  if (!key || key !== ADMIN_API_KEY) {
    res.status(401).json({ error: "Invalid or missing admin key." });
    return false;
  }
  return true;
}
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

// Monthly territory price scales with the location factor already used for
// homeowner pricing — territories with more lead value cost more to claim.
// $199/mo is a placeholder base rate; adjust freely.
function territoryMonthlyPrice(factor) {
  return Math.round((199 * factor) / 5) * 5;
}

// ---------------------------------------------------------------------------
// POST /api/analyze
// Proxies the photo analysis call to Anthropic. The API key lives here on the
// server, never in the browser. This is the piece the standalone frontend
// file couldn't do safely on its own.
// ---------------------------------------------------------------------------
app.post("/api/analyze", publicLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your .env file." });
  }

  const { images, services } = req.body;
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Send at least one image as { images: [{slot, media_type, data}] }." });
  }

  const slotLabels = {
    full: "Full tree, entire height visible",
    base: "Trunk at ground level — the homeowner was asked to press their palm flat against the bark, facing the camera, for scale",
    canopy: "Looking up into the canopy",
    house: "Tree in relation to the house",
    access: "Path from the street or driveway to the tree",
    lines: "Nearby power lines"
  };

  const systemPrompt = `You analyze homeowner-submitted photos of a tree for a tree-service estimating tool called CanopyBid. Each photo below is preceded by a text label describing what it shows. Respond with ONLY valid JSON, no markdown fences, no other text, matching exactly this shape:
{
  "species": {"common_name": string, "confidence_pct": number, "alternates": [string, string]},
  "measurements": {"height_range_ft": [number, number], "dbh_range_in": [number, number], "crown_width_range_ft": [number, number], "scale_reference_present": boolean},
  "conditions": [{"text": string, "severity": "ok" | "watch" | "severe"}],
  "notes": string
}
Rules on sizing, which matters most:
- Look closely at the "Trunk at ground level" photo for a hand pressed flat against the bark. A typical adult palm is roughly 3.5-4 inches wide across the base of the fingers. If a hand is visible flat against the trunk, use it to calculate height and DBH from the pixel proportions as precisely as you can, and keep the range reasonably tight (roughly ±10-15%). Set scale_reference_present to true.
- If the hand looks held out toward the camera rather than flat against the bark (it will look noticeably larger relative to the trunk than a flat palm would), treat the reference as unreliable rather than using it directly.
- If no hand or other reference is visible against the trunk, DO NOT default to "typical" size for the species. Instead, say so explicitly in "notes", set scale_reference_present to false, and widen both ranges substantially (at least ±40%) to reflect real uncertainty.
- Never present a confident-looking narrow range when you are actually guessing from species norms rather than measuring the photo.
Other rules:
- List 2 to 5 conditions.
- Use "severe" ONLY for these specific conditions, and nothing else: contact with or very close proximity to power lines, the tree leaning onto or already touching a structure, a major trunk crack or split union, visible root plate movement or lifting, a hanging or suspended broken limb, or a large cavity with uncertain internal decay. If a condition isn't clearly one of these, it is not "severe," even if it sounds serious.
- Use "watch" for everything else that's a real but non-emergency concern, including: included bark, co-dominant stems, weak branch unions, deadwood, minor lean, canopy dieback, a tree close to (but not touching) a structure, or a confined root zone. These should still get a price, just a wider and clearly caveated one — do not escalate them to "severe."
- When genuinely unsure whether something is "severe" or "watch," choose "watch." Routing to an on-site inspection stops a homeowner from getting any price at all, so reserve it for cases where giving a number would be actively unsafe or meaningless, not for every structural imperfection.
- Use "ok" when no concerns are visible.
- This is a preliminary photo-based read only, not a certified arborist assessment.`;

  async function callAnthropicOnce() {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) throw new Error("No text content returned by the model.");

    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned); // throws if the model didn't return clean JSON
  }

  const content = [];
  images.slice(0, 7).forEach(img => {
    const label = slotLabels[img.slot] || "Additional photo";
    content.push({ type: "text", text: `Photo: ${label}` });
    content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  });
  content.push({ type: "text", text: `Requested service(s): ${services || "not specified"}. Analyze the tree shown above.` });

  console.log(`\n[analyze] Received ${images.length} photo(s): ${images.map(i => i.slot).join(", ")}`);

  let parsed;
  try {
    parsed = await callAnthropicOnce();
  } catch (firstErr) {
    console.warn("[analyze] First attempt failed, retrying once:", firstErr.message);
    try {
      parsed = await callAnthropicOnce();
    } catch (secondErr) {
      console.error("[analyze] Retry also failed:", secondErr);
      return res.status(502).json({ error: "The vision model call failed after a retry.", detail: String(secondErr) });
    }
  }

  try {
    console.log(`[analyze] Result: ${parsed.species.common_name} (${parsed.species.confidence_pct}%), height ${parsed.measurements.height_range_ft}, scale reference present: ${parsed.measurements.scale_reference_present}\n`);
    res.json(parsed);
  } catch (err) {
    console.error("[analyze] Failed:", err);
    res.status(500).json({ error: "Analysis failed.", detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/territories
// Lists territories and whether each is claimed by a company.
// ---------------------------------------------------------------------------
app.get("/api/territories", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.state, t.metro, t.name, t.factor, t.offered, t.boundary_version, t.display_name, t.current_price, c.name AS company_name
      FROM territories t
      LEFT JOIN companies c ON c.id = t.company_id
      WHERE COALESCE(t.retired, 0) = 0
      ORDER BY t.metro, t.name
    `);
    await bids.resolveDueBids().catch(() => {});   // overdue match windows are settled whenever the list is loaded (the server may have been asleep)
    const open = await bids.publicBidInfo();
    const withPricing = rows.map(r => {
      const price = bids.priceOf(r), claimed = !!r.company_name;
      const { current_price, ...pub } = r;
      return { ...pub, offered: r.offered === 1, monthly_price: price,
        min_bid: claimed ? Math.max(price, open[r.id] || 0) + bids.MIN_STEP : null, bid_open: claimed && open[r.id] != null };
    });
    res.json(withPricing);
  } catch (err) {
    console.error("[territories] Failed:", err);
    res.status(500).json({ error: "Could not load territories." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/territories/:id/performance?range=30d|90d|all
// Public, aggregate-only activity for one territory (no homeowner details).
// - qualified lead: owner_confirmed, consent recorded, not flagged duplicate; counted once per lead row
//   (a lead keeps the territory it was routed to at submission time, so history is not rewritten
//   if boundaries change later), filtered by the lead's created_at.
// - estimated project value: sum of the preliminary ranges shown to homeowners. It is NOT revenue.
// - jobs won / booked sales / collected revenue are not tracked yet and are reported as null.
// ---------------------------------------------------------------------------
const readLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes and try again." } });

app.get("/api/territories/:id/performance", readLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const range = String(req.query.range || "30d");
  const days = { "30d": 30, "90d": 90, all: null }[range];
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid territory id." });
  if (days === undefined) return res.status(400).json({ error: "range must be 30d, 90d or all." });
  try {
    const { rows: tr } = await pool.query("SELECT id, name, metro, offered FROM territories WHERE id = $1", [id]);
    if (!tr[0]) return res.status(404).json({ error: "Territory not found." });
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n, COUNT(quote_low) AS priced,
              COALESCE(SUM(quote_low), 0) AS lo, COALESCE(SUM(quote_high), 0) AS hi
         FROM leads
        WHERE territory_id = $1 AND owner_confirmed = 1 AND consent_timestamp IS NOT NULL
          AND COALESCE(duplicate_flag, 0) = 0
          AND ($2::int IS NULL OR created_at >= NOW() - ($2::int * INTERVAL '1 day'))`,
      [id, days]
    );
    const r = rows[0], priced = Number(r.priced);
    res.json({
      territory_id: id, name: tr[0].name, range, offered: tr[0].offered === 1,
      qualified_leads: Number(r.n),
      priced_leads: priced,
      estimated_value_low: priced ? Number(r.lo) : null,
      estimated_value_high: priced ? Number(r.hi) : null,
      jobs_won: null, booked_sales: null, collected_revenue: null,
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error("[performance] Failed:", err);
    res.status(500).json({ error: "Could not load territory activity." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/checkout/create
// Starts a real payment: builds a Stripe subscription checkout for the
// territories a company wants, one line item per territory. Nothing is
// claimed yet — that only happens after payment is confirmed.
// ---------------------------------------------------------------------------
app.post("/api/checkout/create", publicLimiter, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Server is missing STRIPE_SECRET_KEY. Set it in your .env file." });

  const { name, email, phone, territory_ids } = req.body;
  if (!name || !email || !Array.isArray(territory_ids) || territory_ids.length === 0) {
    return res.status(400).json({ error: "Provide name, email, and at least one territory_id." });
  }

  try {
    const { rows: territories } = await pool.query("SELECT * FROM territories WHERE id = ANY($1)", [territory_ids]);
    // Server-side guard: draft (not yet offered) territories can never be purchased, whatever the browser sends.
    const requested = [...new Set(territory_ids.map(Number))];
    const notOffered = territories.filter(t => t.offered !== 1 || t.retired === 1);
    if (territories.length !== requested.length || notOffered.length > 0) {
      return res.status(400).json({
        error: "One or more selected territories are not available for purchase yet.",
        not_available: notOffered.map(t => t.name)
      });
    }
    const available = territories.filter(t => !t.company_id);
    const unavailable = territories.filter(t => t.company_id);

    if (available.length === 0) {
      return res.status(400).json({ error: "All selected territories are already claimed.", unavailable: unavailable.map(t => t.name) });
    }

    // Hold the territories for this buyer so nobody else can start paying for the same ones. The partial unique
    // index on checkout_reservations makes this race-proof even when two buyers click at the same instant.
    const holdId = "hold_" + crypto.randomBytes(8).toString("hex");
    // A buyer who abandoned an earlier checkout and tries again must not be blocked by their own old hold: close it first.
    const { rows: mine } = await pool.query("SELECT DISTINCT session_id FROM checkout_reservations WHERE status = 'pending' AND lower(buyer_email) = lower($1)", [email]);
    for (const m of mine) {
      if (m.session_id && m.session_id.startsWith("cs_")) { try { await stripe.checkout.sessions.expire(m.session_id); } catch (e) { /* already completed or expired */ } }
      await pool.query("UPDATE checkout_reservations SET status = 'released' WHERE session_id = $1 AND status = 'pending'", [m.session_id]);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE checkout_reservations SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()");
      for (const t of available) {
        await client.query(
          "INSERT INTO checkout_reservations (session_id, buyer_email, territory_id, expires_at) VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)",
          [holdId, email, t.id, String(CHECKOUT_HOLD_MINUTES)]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") {
        return res.status(409).json({ error: "One of those territories is being purchased by someone else right now. Please try again in a few minutes.", reserved: true });
      }
      throw e;
    } finally { client.release(); }

    const line_items = available.map(t => ({
      price_data: {
        currency: "usd",
        recurring: { interval: "month" },
        unit_amount: territoryMonthlyPrice(t.factor) * 100,
        product_data: { name: `CanopyBid territory — ${t.metro}: ${t.display_name || t.name}`, metadata: { territory_id: String(t.id) } }
      },
      quantity: 1
    }));

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items,
        customer_email: email,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        success_url: `${FRONTEND_URL}/canopybid-companies.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/canopybid-companies.html?canceled=1`,
        metadata: {
          name, email, phone: phone || "",
          territory_ids: JSON.stringify(available.map(t => t.id))
        }
      });
    } catch (e) {
      await pool.query("UPDATE checkout_reservations SET status = 'released' WHERE session_id = $1 AND status = 'pending'", [holdId]);
      throw e;
    }
    await pool.query("UPDATE checkout_reservations SET session_id = $1 WHERE session_id = $2", [session.id, holdId]);

    res.json({ url: session.url, skipped_unavailable: unavailable.map(t => t.name) });
  } catch (err) {
    console.error("[checkout/create] Failed:", err);
    res.status(500).json({ error: "Could not start checkout.", detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/checkout/confirm
// Called when Stripe redirects back after a successful payment. Verifies the
// session actually paid, THEN creates the company and claims the territories.
// ---------------------------------------------------------------------------
app.get("/api/checkout/confirm", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Server is missing STRIPE_SECRET_KEY." });

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Missing session_id." });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid" && session.status !== "complete") {
      return res.status(402).json({ error: "Payment not completed for this session." });
    }

    const result = await fulfilSession(session);
    res.json(result);
  } catch (err) {
    console.error("[checkout/confirm] Failed:", err);
    res.status(500).json({ error: "Could not confirm payment.", detail: String(err) });
  }
});

// Turns a PAID checkout session into a company + claimed territories. Safe to call any number of times and from two
// places at once (the buyer's browser returning AND Stripe's webhook): a per-session advisory lock plus a unique
// checkout-session column guarantee exactly one company per payment.
async function fulfilSession(session) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [session.id]);
    const { rows: existingRows } = await client.query("SELECT * FROM companies WHERE stripe_checkout_session_id = $1", [session.id]);
    if (existingRows[0]) {
      const existing = existingRows[0];
      const { rows: territories } = await client.query("SELECT name, metro FROM territories WHERE company_id = $1", [existing.id]);
      await client.query("COMMIT");
      return { company_id: existing.id, api_key: existing.api_key, claimed_territories: territories, failed_to_claim: [] };
    }
    const { name, email, phone, territory_ids } = session.metadata || {};
    const ids = JSON.parse(territory_ids || "[]").map(Number);
    const apiKey = crypto.randomBytes(24).toString("hex");
    const ins = await client.query(
      "INSERT INTO companies (name, email, phone, api_key, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [name, email, phone || null, apiKey, session.customer, session.subscription, session.id]
    );
    const companyId = ins.rows[0].id;
    const claimed = [], failedToClaim = [];
    for (const tId of ids) {
      const r = await client.query("UPDATE territories SET company_id = $1, stripe_subscription_id = $3, current_price = NULL WHERE id = $2 AND company_id IS NULL AND offered = 1 RETURNING id", [companyId, tId, session.subscription || null]);
      (r.rowCount > 0 ? claimed : failedToClaim).push(tId);
    }
    await client.query("UPDATE checkout_reservations SET status = 'completed' WHERE session_id = $1", [session.id]);
    const { rows: territories } = claimed.length ? await client.query("SELECT name, metro FROM territories WHERE id = ANY($1)", [claimed]) : { rows: [] };
    const { rows: failedNames } = failedToClaim.length ? await client.query("SELECT name, metro FROM territories WHERE id = ANY($1)", [failedToClaim]) : { rows: [] };
    await client.query("COMMIT");
    if (failedNames.length) console.error(`[fulfil] WARNING: company ${companyId} (${email}) paid for territory already claimed: ${failedNames.map(t => t.name).join(", ")}. Manual refund needed for that portion.`);
    await logAudit({ actorType: "stripe", actorId: session.id, action: "checkout_fulfilled", targetType: "company", targetId: companyId, detail: { claimed, failedToClaim } });
    return { company_id: companyId, api_key: apiKey, claimed_territories: territories, failed_to_claim: failedNames };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

// POST /api/stripe/webhook: keeps our records in step with Stripe even when the buyer never returns to the site.
async function stripeWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).json({ error: "Webhook is not configured (STRIPE_WEBHOOK_SECRET missing)." });
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).json({ error: "Invalid signature." }); }
  try {
    const seen = await pool.query("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id", [event.id, event.type]);
    if (!seen.rowCount) return res.json({ received: true, duplicate: true });
    try {
      const obj = event.data.object;
      if (event.type === "checkout.session.completed" && obj.mode === "setup") {
        await bids.activateBidFromSession(obj);                       // a bidder saved their card
      } else if (event.type === "checkout.session.expired" && obj.mode === "setup") {
        await bids.expireBidSession(obj);
      } else if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        if (obj.payment_status === "paid") await fulfilSession(obj);
      } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
        await pool.query("UPDATE checkout_reservations SET status = 'expired' WHERE session_id = $1 AND status = 'pending'", [obj.id]);
      } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        const status = event.type === "customer.subscription.deleted" ? "canceled" : obj.status;
        const { rows } = await pool.query("SELECT id, account_status, suspended_by_billing FROM companies WHERE stripe_subscription_id = $1", [obj.id]);
        const c = rows[0];
        if (c) {
          let next = null, flag = c.suspended_by_billing;
          if (status === "canceled") { next = "canceled"; flag = 0; }
          else if (status === "past_due" || status === "unpaid") { if (c.account_status === "active") { next = "suspended"; flag = 1; } }
          else if (status === "active" && c.suspended_by_billing === 1) { next = "active"; flag = 0; }
          if (next) {
            await pool.query("UPDATE companies SET account_status = $1, suspended_by_billing = $2 WHERE id = $3", [next, flag, c.id]);
            await logAudit({ actorType: "stripe", actorId: event.id, action: "account_status_" + next, targetType: "company", targetId: c.id, detail: { subscription_status: status } });
          }
        }
      }
    } catch (e) {
      await pool.query("DELETE FROM stripe_events WHERE id = $1", [event.id]);   // let Stripe retry this event
      throw e;
    }
    res.json({ received: true });
  } catch (e) {
    console.error("[stripe webhook] Failed:", e);
    res.status(500).json({ error: "Webhook handling failed." });
  }
}

// Reads the ZIP used for routing. Only two sources count: the form's zip field and a ZIP that follows the state
// in the address ("... TN 37027"). If both exist and disagree, or neither exists, the ZIP cannot be trusted.
function resolveLeadZip(l) {
  const norm = v => { const m = String(v == null ? "" : v).trim().match(/^(\d{5})(?:-\d{4})?$/); return m ? m[1] : null; };
  const field = norm(l.zip);
  const m = String(l.address || "").match(/\b(?:TN|Tennessee)\.?,?\s+(\d{5})(?:-\d{4})?\b/i);
  const fromAddress = m ? m[1] : null;
  if (field && fromAddress && field !== fromAddress) return { zip: null, reason: "zip_conflict" };
  const zip = field || fromAddress;
  return zip ? { zip } : { zip: null, reason: "zip_missing" };
}

// A company receives automatic leads only if its account is active, it is accepting leads, an admin has verified BOTH
// its license and insurance, and neither has expired.
function companyEligible(c) {
  if (!c || c.accepting_leads === 0) return false;
  if ((c.account_status || "active") !== "active") return false;
  if (c.license_status !== "verified" || c.insurance_status !== "verified") return false;
  const now = Date.now();
  for (const d of [c.license_expiration, c.insurance_expiration]) if (d && new Date(d).getTime() < now) return false;
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/leads
// Stores an accepted estimate as a lead and, if the territory is claimed,
// attaches it to that company.
// ---------------------------------------------------------------------------
app.post("/api/leads", publicLimiter, async (req, res) => {
  const l = req.body;

  // Qualified-lead rules: reject incomplete submissions outright rather than
  // silently accepting them. This is deliberately strict per the "qualified
  // lead" definition — a company should never be notified about a lead that
  // doesn't actually meet the bar.
  const missing = [];
  if (!l.name) missing.push("name");
  if (!l.phone) missing.push("phone");
  if (!l.address) missing.push("address");
  if (!Array.isArray(l.trees) || l.trees.length === 0) missing.push("at least one tree submission");
  if (!l.owner_confirmed) missing.push("confirmation that they own or control the property");
  if (!l.consent_given) missing.push("consent to be contacted");
  if (missing.length > 0) {
    return res.status(400).json({ error: "This isn't a qualified lead yet — missing: " + missing.join(", ") });
  }

  try {
    // ROUTING (ZIP only). The city/territory name sent by the form is never used to pick a territory.
    // A lead is routed automatically only when its ZIP belongs to a CONFIRMED (offered) territory that has an
    // ELIGIBLE company. Everything else is stored as unassigned and goes to the admin manual-review queue.
    const zr = resolveLeadZip(l);
    let territory = null, routingBasis = "zip", routingStatus = "unassigned", routingReason = zr.reason || null, company = null;
    if (zr.zip) {
      const { rows } = await pool.query(
        "SELECT t.* FROM territory_zips z JOIN territories t ON t.id = z.territory_id WHERE z.zip = $1", [zr.zip]);
      const t = rows[0];
      if (!t) routingReason = "zip_unassigned";
      else if (t.offered !== 1) routingReason = "territory_draft";
      else {
        territory = t;
        if (!t.company_id) routingReason = "no_company";
        else {
          const { rows: cr } = await pool.query("SELECT * FROM companies WHERE id = $1", [t.company_id]);
          company = cr[0] || null;
          if (!companyEligible(company)) { routingReason = "company_ineligible"; company = null; }
          else { routingStatus = "assigned"; routingReason = null; }
        }
      }
    } else routingBasis = "none";
    const routedName = territory ? territory.name : null;
    const routedMetro = territory ? territory.metro : null;

    // Duplicate/fraud flagging: same phone or same address submitted again
    // recently gets flagged for admin review, but is never silently dropped.
    const { rows: dupeRows } = await pool.query(
      `SELECT id FROM leads WHERE (phone = $1 OR address = $2) AND created_at > NOW() - INTERVAL '24 hours'`,
      [l.phone, l.address]
    );
    const duplicateFlag = dupeRows.length > 0;
    const duplicateReason = duplicateFlag ? `Matches ${dupeRows.length} lead(s) with the same phone or address in the last 24 hours.` : null;

    const resumeToken = crypto.randomBytes(20).toString("hex");
    const consentVersion = l.consent_version || "v1";

    const insertResult = await pool.query(`
      INSERT INTO leads (
        name, phone, email, address, zip, state, metro, territory_name, territory_id,
        services, timeframe, insurance, access, species, height, dbh, crown,
        conditions_json, inspection_required, quote_low, quote_high,
        confidence_label, lead_quality, trees_json, owner_confirmed,
        consent_version, consent_timestamp, consent_ip, duplicate_flag, duplicate_reason, resume_token
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW(),$27,$28,$29,$30)
      RETURNING id
    `, [
      l.name, l.phone, l.email || null, l.address || null, zr.zip || (l.zip ? String(l.zip).slice(0, 10) : null), l.state || null, routedMetro,
      routedName, territory ? territory.id : null,
      JSON.stringify(l.services || []), l.timeframe || null, l.insurance ? 1 : 0, l.access || null,
      l.species || null, l.height || null, l.dbh || null, l.crown || null,
      JSON.stringify(l.conditions || []), l.inspection_required ? 1 : 0,
      l.quote_low ?? null, l.quote_high ?? null, l.confidence_label || null, l.lead_quality || null,
      JSON.stringify(l.trees || []), 1,
      consentVersion, req.ip || null, duplicateFlag ? 1 : 0, duplicateReason, resumeToken
    ]);
    const leadId = insertResult.rows[0].id;
    await pool.query(
      "UPDATE leads SET routing_basis = $1, routing_status = $2, routing_reason = $3, assigned_company_id = $4, submitted_territory_hint = $5 WHERE id = $6",
      [routingBasis, routingStatus, routingReason, company ? company.id : null, l.territory_name ? String(l.territory_name).slice(0, 80) : null, leadId]
    );

    await pool.query(
      "INSERT INTO lead_status_history (lead_id, status, changed_by, note) VALUES ($1, 'submitted', 'homeowner', $2)",
      [leadId, duplicateFlag ? "Flagged as possible duplicate at submission." : null]
    );

    let matchedCompany = null;
    if (company) {
      matchedCompany = { name: company.name, email: company.email, phone: company.phone };
      await pool.query("UPDATE leads SET status = 'assigned' WHERE id = $1", [leadId]);
      await pool.query("INSERT INTO lead_status_history (lead_id, status, changed_by) VALUES ($1, 'assigned', 'system')", [leadId]);
    } else {
      await pool.query(
        "INSERT INTO lead_status_history (lead_id, status, changed_by, note) VALUES ($1, 'submitted', 'system', $2)",
        [leadId, `Unassigned, needs manual review: ${routingReason}`]
      );
    }

    // Best-effort notifications — sendEmail never throws, so a failed send
    // here can't break the lead submission response.
    if (matchedCompany && matchedCompany.email) {
      await sendEmail({
        to: matchedCompany.email,
        subject: `New lead: ${l.name} — ${routedName}`,
        html: companyLeadEmailHtml(l, matchedCompany, routedName)
      });
    }
    if (l.email) {
      await sendEmail({
        to: l.email,
        subject: "We've got your tree estimate request",
        html: homeownerConfirmationEmailHtml(l, !!matchedCompany)
      });
    }

    res.status(201).json({
      lead_id: leadId,
      territory_claimed: !!matchedCompany,
      routing_status: routingStatus,
      matched_company: matchedCompany,
      resume_token: resumeToken
    });
  } catch (err) {
    console.error("[leads] Failed:", err);
    res.status(500).json({ error: "Could not save lead." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/companies/leads
// A company fetches its own leads using its API key.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /api/companies/me
// A company's own profile, including license/insurance upload status.
// ---------------------------------------------------------------------------
app.get("/api/companies/me", async (req, res) => {
  const apiKey = req.header("x-api-key");
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header." });

  try {
    const { rows } = await pool.query(`
      SELECT id, name, email, phone,
             license_filename, license_status, license_uploaded_at, license_number, license_expiration,
             insurance_filename, insurance_status, insurance_uploaded_at, insurance_carrier, insurance_policy_number, insurance_expiration,
             legal_name, dba, owner_name, business_address, website, years_in_business,
             equipment_notes, crew_count, weekly_lead_capacity, desired_response_minutes, accepting_leads
      FROM companies WHERE api_key = $1
    `, [apiKey]);
    const company = rows[0];
    if (!company) return res.status(401).json({ error: "Invalid API key." });
    res.json(company);
  } catch (err) {
    console.error("[companies/me] Failed:", err);
    res.status(500).json({ error: "Could not load account." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/companies/upload-document
// Uploads (or replaces) a license or insurance document. Any new upload
// resets status to "pending" — it needs a human to actually review it before
// the company is shown as verified anywhere on the site.
// ---------------------------------------------------------------------------
app.post("/api/companies/upload-document", async (req, res) => {
  const apiKey = req.header("x-api-key");
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header." });

  const { doc_type, filename, media_type, data } = req.body;
  if (!["license", "insurance"].includes(doc_type)) {
    return res.status(400).json({ error: "doc_type must be 'license' or 'insurance'." });
  }
  if (!filename || !media_type || !data) {
    return res.status(400).json({ error: "Missing filename, media_type, or data." });
  }

  try {
    const { rows } = await pool.query("SELECT id FROM companies WHERE api_key = $1", [apiKey]);
    const company = rows[0];
    if (!company) return res.status(401).json({ error: "Invalid API key." });

    // doc_type is checked against a fixed whitelist above, so it's safe to
    // interpolate into the column name here.
    await pool.query(
      `UPDATE companies
       SET ${doc_type}_doc = $1, ${doc_type}_media_type = $2, ${doc_type}_filename = $3,
           ${doc_type}_status = 'pending', ${doc_type}_uploaded_at = NOW()
       WHERE id = $4`,
      [data, media_type, filename, company.id]
    );
    console.log(`[upload-document] Company ${company.id} uploaded a new ${doc_type} document (${filename}) — needs manual review.`);
    res.json({ status: "pending", filename });
  } catch (err) {
    console.error("[upload-document] Failed:", err);
    res.status(500).json({ error: "Upload failed." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/companies/document?type=license|insurance
// Fetches the raw document data so the account page can preview/download it.
// ---------------------------------------------------------------------------
app.get("/api/companies/document", async (req, res) => {
  const apiKey = req.header("x-api-key");
  const type = req.query.type;
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header." });
  if (!["license", "insurance"].includes(type)) return res.status(400).json({ error: "Invalid type." });

  try {
    const { rows } = await pool.query(
      `SELECT ${type}_doc AS data, ${type}_media_type AS media_type, ${type}_filename AS filename
       FROM companies WHERE api_key = $1`,
      [apiKey]
    );
    const row = rows[0];
    if (!row || !row.data) return res.status(404).json({ error: "No document uploaded." });
    res.json(row);
  } catch (err) {
    console.error("[companies/document] Failed:", err);
    res.status(500).json({ error: "Could not load document." });
  }
});

app.get("/api/companies/leads", async (req, res) => {
  const apiKey = req.header("x-api-key");
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header." });

  try {
    const { rows: compRows } = await pool.query("SELECT * FROM companies WHERE api_key = $1", [apiKey]);
    const company = compRows[0];
    if (!company) return res.status(401).json({ error: "Invalid API key." });

    const { rows: leads } = await pool.query(`
      SELECT leads.* FROM leads
      WHERE leads.assigned_company_id = $1
      ORDER BY leads.created_at DESC
    `, [company.id]);

    res.json({ company: { id: company.id, name: company.name }, leads });
  } catch (err) {
    console.error("[companies/leads] Failed:", err);
    res.status(500).json({ error: "Could not load leads." });
  }
});

// Shared helper: resolve the company behind an x-api-key header.
async function authCompany(req) {
  const apiKey = req.header("x-api-key");
  if (!apiKey) return null;
  const { rows } = await pool.query("SELECT * FROM companies WHERE api_key = $1", [apiKey]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// PATCH /api/leads/:id/status
// A company (or admin) moves a lead through the pipeline. Every change is
// recorded in lead_status_history, not just overwritten.
// ---------------------------------------------------------------------------
const VALID_STATUSES = [
  "submitted", "needs_more_info", "assigned", "notified", "contacted",
  "inspection_scheduled", "final_quote_delivered", "accepted", "declined",
  "job_completed", "lost", "disputed"
];
app.patch("/api/leads/:id/status", async (req, res) => {
  const { status, note } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status.", valid: VALID_STATUSES });

  const company = await authCompany(req);
  if (!company) return res.status(401).json({ error: "Invalid or missing x-api-key header." });

  try {
    const { rows } = await pool.query(`
      SELECT leads.id FROM leads
      WHERE leads.id = $1 AND leads.assigned_company_id = $2
    `, [req.params.id, company.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Lead not found for this company." });

    await pool.query("UPDATE leads SET status = $1 WHERE id = $2", [status, req.params.id]);
    await pool.query(
      "INSERT INTO lead_status_history (lead_id, status, changed_by, note) VALUES ($1, $2, $3, $4)",
      [req.params.id, status, `company:${company.id}`, note || null]
    );
    await logAudit({ actorType: "company", actorId: company.id, action: "status_change", targetType: "lead", targetId: req.params.id, detail: { status, note } });
    res.json({ status });
  } catch (err) {
    console.error("[leads/status] Failed:", err);
    res.status(500).json({ error: "Could not update status." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/leads/resume/:token
// Public status page for a homeowner — no login, just the private link they
// were emailed. Shows where their request stands.
// ---------------------------------------------------------------------------
app.get("/api/leads/resume/:token", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM leads WHERE resume_token = $1", [req.params.token]);
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: "This link isn't valid or has expired." });

    const { rows: history } = await pool.query(
      "SELECT status, note, created_at FROM lead_status_history WHERE lead_id = $1 ORDER BY created_at ASC",
      [lead.id]
    );
    res.json({
      name: lead.name, address: lead.address, status: lead.status,
      quote_low: lead.quote_low, quote_high: lead.quote_high,
      inspection_required: !!lead.inspection_required,
      services: JSON.parse(lead.services || "[]"),
      history
    });
  } catch (err) {
    console.error("[leads/resume] Failed:", err);
    res.status(500).json({ error: "Could not load this request." });
  }
});

// ---------------------------------------------------------------------------
// Price book: a company's own labor/equipment costs. Stored now; wiring this
// into the live homeowner pricing calculation (replacing the flat starter
// price book) is the natural next step once a company actually fills one in.
// ---------------------------------------------------------------------------
app.get("/api/companies/price-book", async (req, res) => {
  const company = await authCompany(req);
  if (!company) return res.status(401).json({ error: "Invalid or missing x-api-key header." });
  try {
    const { rows } = await pool.query("SELECT * FROM price_books WHERE company_id = $1", [company.id]);
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "Could not load price book." });
  }
});

app.post("/api/companies/price-book", async (req, res) => {
  const company = await authCompany(req);
  if (!company) return res.status(401).json({ error: "Invalid or missing x-api-key header." });
  const b = req.body;
  try {
    await pool.query(`
      INSERT INTO price_books (company_id, crew_rate, bucket_truck_rate, crane_rate, climber_rate, disposal_rate, stump_rate_per_inch, minimum_charge, travel_rate, permit_cost, margin_pct, emergency_multiplier, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (company_id) DO UPDATE SET
        crew_rate=$2, bucket_truck_rate=$3, crane_rate=$4, climber_rate=$5, disposal_rate=$6,
        stump_rate_per_inch=$7, minimum_charge=$8, travel_rate=$9, permit_cost=$10, margin_pct=$11,
        emergency_multiplier=$12, updated_at=NOW()
    `, [
      company.id, b.crew_rate ?? null, b.bucket_truck_rate ?? null, b.crane_rate ?? null, b.climber_rate ?? null,
      b.disposal_rate ?? null, b.stump_rate_per_inch ?? null, b.minimum_charge ?? null, b.travel_rate ?? null,
      b.permit_cost ?? null, b.margin_pct ?? null, b.emergency_multiplier ?? null
    ]);
    res.json({ saved: true });
  } catch (err) {
    console.error("[price-book] Failed:", err);
    res.status(500).json({ error: "Could not save price book." });
  }
});

// ---------------------------------------------------------------------------
// Expanded company profile — the fuller application info beyond just
// name/email/phone collected at checkout.
// ---------------------------------------------------------------------------
app.post("/api/companies/me/profile", async (req, res) => {
  const company = await authCompany(req);
  if (!company) return res.status(401).json({ error: "Invalid or missing x-api-key header." });
  const p = req.body;
  try {
    await pool.query(`
      UPDATE companies SET
        legal_name=$1, dba=$2, owner_name=$3, business_address=$4, website=$5,
        years_in_business=$6, equipment_notes=$7, crew_count=$8, weekly_lead_capacity=$9,
        desired_response_minutes=$10, accepting_leads=$11,
        license_number=$12, license_expiration=$13,
        insurance_carrier=$14, insurance_policy_number=$15, insurance_expiration=$16
      WHERE id=$17
    `, [
      p.legal_name || null, p.dba || null, p.owner_name || null, p.business_address || null, p.website || null,
      p.years_in_business || null, p.equipment_notes || null, p.crew_count || null, p.weekly_lead_capacity || null,
      p.desired_response_minutes || null, p.accepting_leads === false ? 0 : 1,
      p.license_number || null, p.license_expiration || null,
      p.insurance_carrier || null, p.insurance_policy_number || null, p.insurance_expiration || null,
      company.id
    ]);
    res.json({ saved: true });
  } catch (err) {
    console.error("[companies/me/profile] Failed:", err);
    res.status(500).json({ error: "Could not save profile." });
  }
});

// ---------------------------------------------------------------------------
// Email verification (OTP). Phone/SMS verification needs a service like
// Twilio; this covers the email half without any new account beyond Resend.
// ---------------------------------------------------------------------------
app.post("/api/verify/email/request", publicLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email." });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await pool.query(
      "INSERT INTO email_verifications (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')",
      [email, code]
    );
    await sendEmail({
      to: email,
      subject: "Your CanopyBid verification code",
      html: `<div style="font-family:Arial,sans-serif;"><p>Your verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p><p style="font-size:12px;color:#76856E;">Expires in 15 minutes.</p></div>`
    });
    res.json({ sent: true });
  } catch (err) {
    console.error("[verify/email/request] Failed:", err);
    res.status(500).json({ error: "Could not send verification code." });
  }
});

app.post("/api/verify/email/confirm", publicLimiter, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Missing email or code." });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM email_verifications WHERE email = $1 AND code = $2 AND expires_at > NOW() AND verified = 0 ORDER BY created_at DESC LIMIT 1",
      [email, code]
    );
    if (rows.length === 0) return res.status(400).json({ error: "Invalid or expired code." });
    await pool.query("UPDATE email_verifications SET verified = 1 WHERE id = $1", [rows[0].id]);
    res.json({ verified: true });
  } catch (err) {
    res.status(500).json({ error: "Could not confirm code." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/companies
// Lists every company with their document status and owned territories, for
// the admin review page. Requires the admin key, not a company API key.
// ---------------------------------------------------------------------------
app.get("/api/admin/companies", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows: companies } = await pool.query(`
      SELECT id, name, email, phone,
             license_filename, license_status, license_uploaded_at,
             insurance_filename, insurance_status, insurance_uploaded_at,
             created_at
      FROM companies ORDER BY created_at DESC
    `);
    const { rows: territories } = await pool.query(`
      SELECT company_id, state, metro, name FROM territories WHERE company_id IS NOT NULL
    `);
    const byCompany = {};
    territories.forEach(t => {
      byCompany[t.company_id] = byCompany[t.company_id] || [];
      byCompany[t.company_id].push(`${t.metro} — ${t.name}`);
    });
    const result = companies.map(c => ({ ...c, territories: byCompany[c.id] || [] }));
    res.json(result);
  } catch (err) {
    console.error("[admin/companies] Failed:", err);
    res.status(500).json({ error: "Could not load companies." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/document?company_id=X&type=license|insurance
// Fetches a company's raw document for the admin to review.
// ---------------------------------------------------------------------------
app.get("/api/admin/document", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { company_id, type } = req.query;
  if (!["license", "insurance"].includes(type)) return res.status(400).json({ error: "Invalid type." });
  if (!company_id) return res.status(400).json({ error: "Missing company_id." });

  try {
    const { rows } = await pool.query(
      `SELECT ${type}_doc AS data, ${type}_media_type AS media_type, ${type}_filename AS filename
       FROM companies WHERE id = $1`,
      [company_id]
    );
    const row = rows[0];
    if (!row || !row.data) return res.status(404).json({ error: "No document uploaded." });
    res.json(row);
  } catch (err) {
    console.error("[admin/document] Failed:", err);
    res.status(500).json({ error: "Could not load document." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/verify
// Approves or rejects a company's license or insurance document.
// ---------------------------------------------------------------------------
app.post("/api/admin/verify", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { company_id, doc_type, status } = req.body;
  if (!["license", "insurance"].includes(doc_type)) return res.status(400).json({ error: "Invalid doc_type." });
  if (!["verified", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  if (!company_id) return res.status(400).json({ error: "Missing company_id." });

  try {
    // doc_type is checked against a fixed whitelist above, so it's safe to
    // interpolate into the column name here.
    await pool.query(`UPDATE companies SET ${doc_type}_status = $1 WHERE id = $2`, [status, company_id]);
    await logAudit({ actorType: "admin", actorId: "admin", action: "verify_document", targetType: "company", targetId: company_id, detail: { doc_type, status } });
    console.log(`[admin/verify] Company ${company_id}'s ${doc_type} marked ${status}.`);
    res.json({ status });
  } catch (err) {
    console.error("[admin/verify] Failed:", err);
    res.status(500).json({ error: "Could not update status." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/leads
// The exception queue: unassigned, flagged-duplicate, or stale leads —
// the things that actually need a human's attention.
// ---------------------------------------------------------------------------
app.get("/api/admin/leads", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, name, phone, address, zip, territory_name, territory_id, status, routing_status, routing_reason,
             assigned_company_id, submitted_territory_hint, duplicate_flag,
             duplicate_reason, admin_reviewed, quote_low, quote_high, inspection_required, created_at
      FROM leads ${req.query.unassigned === "1" ? "WHERE routing_status = 'unassigned'" : ""}
      ORDER BY created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Could not load leads." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/leads/:id/review
// Manual estimate review — override the AI's range, confidence, hazard
// flag, or status, and mark the lead as admin-reviewed.
// ---------------------------------------------------------------------------
app.post("/api/admin/leads/:id/review", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { quote_low, quote_high, confidence_label, inspection_required, status, admin_notes } = req.body;
  try {
    await pool.query(`
      UPDATE leads SET
        quote_low = COALESCE($1, quote_low),
        quote_high = COALESCE($2, quote_high),
        confidence_label = COALESCE($3, confidence_label),
        inspection_required = COALESCE($4, inspection_required),
        status = COALESCE($5, status),
        admin_notes = COALESCE($6, admin_notes),
        admin_reviewed = 1
      WHERE id = $7
    `, [quote_low ?? null, quote_high ?? null, confidence_label || null,
        inspection_required === undefined ? null : (inspection_required ? 1 : 0),
        status || null, admin_notes || null, req.params.id]);

    if (status) {
      await pool.query(
        "INSERT INTO lead_status_history (lead_id, status, changed_by, note) VALUES ($1, $2, 'admin', $3)",
        [req.params.id, status, admin_notes || null]
      );
    }
    await logAudit({ actorType: "admin", actorId: "admin", action: "manual_review", targetType: "lead", targetId: req.params.id, detail: req.body });
    res.json({ reviewed: true });
  } catch (err) {
    console.error("[admin/leads/review] Failed:", err);
    res.status(500).json({ error: "Could not update lead." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/analytics
// A basic funnel using data we already collect — submitted, assigned,
// accepted, completed — plus flags that need attention.
// ---------------------------------------------------------------------------
app.get("/api/admin/analytics", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const counts = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
    const [totalLeads, assigned, accepted, completed, flaggedDuplicates, needsReview, unassigned, expiredDocs] = await Promise.all([
      counts("SELECT COUNT(*) AS n FROM leads"),
      counts("SELECT COUNT(*) AS n FROM leads WHERE status != 'submitted'"),
      counts("SELECT COUNT(*) AS n FROM leads WHERE status = 'accepted'"),
      counts("SELECT COUNT(*) AS n FROM leads WHERE status = 'job_completed'"),
      counts("SELECT COUNT(*) AS n FROM leads WHERE duplicate_flag = 1"),
      counts("SELECT COUNT(*) AS n FROM leads WHERE admin_reviewed = 0"),
      counts("SELECT COUNT(*) AS n FROM leads WHERE routing_status = 'unassigned'"),
      counts("SELECT COUNT(*) AS n FROM companies WHERE license_expiration < NOW() OR insurance_expiration < NOW()")
    ]);
    res.json({ totalLeads, assigned, accepted, completed, flaggedDuplicates, needsReview, unassigned, expiredDocs });
  } catch (err) {
    console.error("[admin/analytics] Failed:", err);
    res.status(500).json({ error: "Could not load analytics." });
  }
});

// ---------------------------------------------------------------------------
// Disputes: a company can flag a lead as fake, duplicate, or out of area;
// an admin resolves it. This is the credit/dispute queue, not an automated
// refund system — a human still decides.
// ---------------------------------------------------------------------------
app.post("/api/leads/:id/dispute", async (req, res) => {
  const company = await authCompany(req);
  if (!company) return res.status(401).json({ error: "Invalid or missing x-api-key header." });
  const { reason, detail } = req.body;
  if (!reason) return res.status(400).json({ error: "Missing reason." });
  try {
    const { rows: own } = await pool.query("SELECT id FROM leads WHERE id = $1 AND assigned_company_id = $2", [req.params.id, company.id]);
    if (!own.length) return res.status(404).json({ error: "Lead not found for this company." });
    await pool.query(
      "INSERT INTO lead_disputes (lead_id, company_id, reason, detail) VALUES ($1, $2, $3, $4)",
      [req.params.id, company.id, reason, detail || null]
    );
    await pool.query("UPDATE leads SET status = 'disputed' WHERE id = $1", [req.params.id]);
    res.status(201).json({ filed: true });
  } catch (err) {
    res.status(500).json({ error: "Could not file dispute." });
  }
});

app.get("/api/admin/disputes", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT d.*, l.name AS lead_name, c.name AS company_name
      FROM lead_disputes d
      JOIN leads l ON l.id = d.lead_id
      JOIN companies c ON c.id = d.company_id
      ORDER BY d.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Could not load disputes." });
  }
});

app.post("/api/admin/disputes/:id/resolve", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { status } = req.body;
  if (!["credited", "denied"].includes(status)) return res.status(400).json({ error: "Status must be 'credited' or 'denied'." });
  try {
    await pool.query("UPDATE lead_disputes SET status = $1, resolved_at = NOW() WHERE id = $2", [status, req.params.id]);
    await logAudit({ actorType: "admin", actorId: "admin", action: "resolve_dispute", targetType: "dispute", targetId: req.params.id, detail: { status } });
    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: "Could not resolve dispute." });
  }
});

// ---------------------------------------------------------------------------
// Admin: territory ZIP assignments and offering (x-admin-key required)
// ---------------------------------------------------------------------------
// POST /api/admin/territory-zips/import
//   body: { zips?: [{zip, territory_id, status}], boundary_version? }
//   With no "zips", loads the bundled data/nashville_zips.json draft. Upserts ZIP assignments only;
//   it does NOT make any territory purchasable.
app.post("/api/admin/territory-zips/import", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const fs = require("node:fs");
    const body = req.body || {};
    const src = Array.isArray(body.zips) ? { zips: body.zips, version: body.boundary_version } : JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "data", "nashville_zips.json"), "utf8"));
    const version = body.boundary_version || src.version || "unversioned";
    const rows = src.zips.filter(z => /^\d{5}$/.test(String(z.zip)) && Number.isInteger(Number(z.territory_id)));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const z of rows) {
        await client.query(
          `INSERT INTO territory_zips (zip, territory_id, status, boundary_version) VALUES ($1,$2,$3,$4)
           ON CONFLICT (zip) DO UPDATE SET territory_id = EXCLUDED.territory_id, status = EXCLUDED.status, boundary_version = EXCLUDED.boundary_version`,
          [String(z.zip), Number(z.territory_id), z.status || null, version]
        );
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    await logAudit({ actorType: "admin", action: "territory_zips_import", detail: { count: rows.length, version } });
    res.json({ imported: rows.length, boundary_version: version });
  } catch (err) {
    console.error("[admin/territory-zips/import] Failed:", err);
    res.status(500).json({ error: "Could not import ZIP assignments." });
  }
});

// POST /api/admin/leads/:id/assign   body: { territory_id }
//   Manual-review queue action: a person routes an unassigned lead to a territory whose company is eligible.
app.post("/api/admin/leads/:id/assign", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const tid = Number(req.body.territory_id);
  if (!Number.isInteger(tid)) return res.status(400).json({ error: "Provide territory_id." });
  try {
    const { rows: tr } = await pool.query("SELECT * FROM territories WHERE id = $1", [tid]);
    const t = tr[0];
    if (!t || !t.company_id) return res.status(400).json({ error: "That territory has no company." });
    const { rows: cr } = await pool.query("SELECT * FROM companies WHERE id = $1", [t.company_id]);
    if (!companyEligible(cr[0])) return res.status(400).json({ error: "That territory's company is not eligible (verified license and insurance, accepting leads)." });
    const { rowCount } = await pool.query(
      "UPDATE leads SET territory_id = $1, territory_name = $2, metro = $3, assigned_company_id = $4, routing_status = 'assigned', routing_reason = NULL, routing_basis = 'manual', status = 'assigned' WHERE id = $5 AND routing_status = 'unassigned'",
      [t.id, t.name, t.metro, t.company_id, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Lead not found or already assigned." });
    await pool.query("INSERT INTO lead_status_history (lead_id, status, changed_by, note) VALUES ($1, 'assigned', 'admin', 'Manually assigned from review queue')", [req.params.id]);
    await logAudit({ actorType: "admin", action: "lead_manual_assign", targetType: "lead", targetId: req.params.id, detail: { territory_id: t.id } });
    res.json({ assigned: true, company_id: t.company_id });
  } catch (err) {
    console.error("[admin/leads/assign] Failed:", err);
    res.status(500).json({ error: "Could not assign lead." });
  }
});

// POST /api/admin/companies/:id/status   body: { status: "active" | "suspended" | "canceled" }
//   Manual account state (e.g. after a cancelled subscription). Non-active companies receive no automatic leads.
app.post("/api/admin/companies/:id/status", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const status = req.body.status;
  if (!["active", "suspended", "canceled"].includes(status)) return res.status(400).json({ error: "status must be active, suspended or canceled." });
  try {
    const { rowCount } = await pool.query("UPDATE companies SET account_status = $1 WHERE id = $2", [status, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Company not found." });
    await logAudit({ actorType: "admin", action: "company_status", targetType: "company", targetId: req.params.id, detail: { status } });
    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: "Could not update company status." });
  }
});

// POST /api/admin/territories/display-names   body: { names: { "1": "Nashville / Davidson County", ... } }
//   Display names are cosmetic. Ids, names (routing keys) and ZIP assignments are untouched.
// POST /api/admin/territories/merge  { from_ids: [2,4], into_id: 3, display_name?: "Williamson County" }
// Folds territories into one. ZIP assignments, lead activity and routing move to into_id; the old territory rows are kept
// (history) but retired: hidden, never offered, never sold. Refused if a retired-to-be territory already has a company.
app.post("/api/admin/territories/merge", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const from = [...new Set((req.body.from_ids || []).map(Number))], into = Number(req.body.into_id);
  if (!from.length || !Number.isInteger(into) || from.includes(into) || from.some(n => !Number.isInteger(n))) return res.status(400).json({ error: "Provide from_ids (array) and into_id; into_id must not be in from_ids." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: ts } = await client.query("SELECT id, company_id, retired FROM territories WHERE id = ANY($1) FOR UPDATE", [[...from, into]]);
    if (ts.length !== from.length + 1) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Unknown territory id." }); }
    if (ts.some(t => t.retired === 1)) { await client.query("ROLLBACK"); return res.status(409).json({ error: "A territory involved is already retired." }); }
    if (ts.some(t => from.includes(t.id) && t.company_id)) { await client.query("ROLLBACK"); return res.status(409).json({ error: "A territory being merged already has a company. Resolve ownership first." }); }
    const z = await client.query("UPDATE territory_zips SET territory_id = $1 WHERE territory_id = ANY($2)", [into, from]);
    const l = await client.query("UPDATE leads SET territory_id = $1 WHERE territory_id = ANY($2)", [into, from]);
    await client.query("UPDATE territories SET retired = 1, offered = 0 WHERE id = ANY($1)", [from]);
    await client.query("UPDATE territories SET offered = 0 WHERE id = $1", [into]);   // the merged territory must be re-approved
    if (typeof req.body.display_name === "string" && req.body.display_name.trim()) await client.query("UPDATE territories SET display_name = $1 WHERE id = $2", [req.body.display_name.trim().slice(0, 80), into]);
    await client.query("COMMIT");
    await logAudit({ actorType: "admin", action: "territories_merged", targetType: "territory", targetId: into, detail: { from, zips_moved: z.rowCount, leads_moved: l.rowCount } });
    res.json({ merged_into: into, retired: from, zips_moved: z.rowCount, leads_moved: l.rowCount });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[territories/merge] Failed:", err);
    res.status(500).json({ error: "Could not merge territories." });
  } finally { client.release(); }
});

app.post("/api/admin/territories/display-names", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const names = req.body.names || {};
  try {
    let n = 0;
    for (const [id, name] of Object.entries(names)) {
      if (!Number.isInteger(Number(id)) || typeof name !== "string" || name.length > 80) continue;
      n += (await pool.query("UPDATE territories SET display_name = $1 WHERE id = $2", [name.trim() || null, Number(id)])).rowCount;
    }
    await logAudit({ actorType: "admin", action: "territory_display_names", detail: names });
    res.json({ updated: n });
  } catch (err) {
    res.status(500).json({ error: "Could not update display names." });
  }
});

// POST /api/admin/territories/offer   body: { territory_ids: [..], offered: true|false, boundary_version? }
//   Confirms (or withdraws) territories. A territory can only be offered once it has ZIP assignments.
//   Withdrawing never touches territories that are already claimed.
// POST /api/admin/territories/release   body: { territory_id, offered?: false }
//   Takes a territory back from its company (e.g. removing a test purchase). If that leaves the company with no territories,
//   its Stripe subscription is cancelled and the account marked canceled. Leads already assigned keep their history.
app.post("/api/admin/territories/release", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const tid = Number(req.body.territory_id);
  if (!Number.isInteger(tid)) return res.status(400).json({ error: "Provide territory_id." });
  try {
    const { rows } = await pool.query("SELECT id, name, company_id FROM territories WHERE id = $1", [tid]);
    if (!rows.length) return res.status(404).json({ error: "Territory not found." });
    const companyId = rows[0].company_id;
    if (!companyId) return res.status(409).json({ error: "Territory has no company." });
    await pool.query("UPDATE territories SET company_id = NULL, offered = $1, current_price = NULL, stripe_subscription_id = NULL WHERE id = $2", [req.body.offered === true ? 1 : 0, tid]);
    await pool.query("UPDATE bids SET status = 'canceled', resolved_at = NOW(), resolved_note = 'territory released by admin' WHERE territory_id = $1 AND status IN ('pending_setup','active')", [tid]);
    const left = await pool.query("SELECT COUNT(*)::int AS n FROM territories WHERE company_id = $1", [companyId]);
    let cancelled = false, stripeNote = null;
    if (left.rows[0].n === 0) {
      await pool.query("UPDATE companies SET account_status = 'canceled' WHERE id = $1", [companyId]);
      const c = await pool.query("SELECT stripe_subscription_id FROM companies WHERE id = $1", [companyId]);
      const sub = c.rows[0] && c.rows[0].stripe_subscription_id;
      if (sub && stripe) { try { await stripe.subscriptions.cancel(sub); cancelled = true; } catch (e) { stripeNote = "Could not cancel the Stripe subscription: " + e.message; } }
    }
    await logAudit({ actorType: "admin", action: "territory_released", targetType: "territory", targetId: tid, detail: { company_id: companyId, subscription_cancelled: cancelled } });
    res.json({ released: tid, company_id: companyId, subscription_cancelled: cancelled, note: stripeNote });
  } catch (err) {
    console.error("[admin/territories/release] Failed:", err);
    res.status(500).json({ error: "Could not release territory." });
  }
});

app.post("/api/admin/territories/offer", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ids = Array.isArray(req.body.territory_ids) ? [...new Set(req.body.territory_ids.map(Number))] : [];
  if (!ids.length || ids.some(n => !Number.isInteger(n))) return res.status(400).json({ error: "Provide territory_ids." });
  const offered = req.body.offered === true;
  try {
    if (offered) {
      const { rows } = await pool.query("SELECT territory_id, COUNT(*) AS n FROM territory_zips WHERE territory_id = ANY($1) GROUP BY territory_id", [ids]);
      const have = new Set(rows.map(r => r.territory_id));
      const missing = ids.filter(i => !have.has(i));
      if (missing.length) return res.status(400).json({ error: "These territories have no ZIP assignments yet.", territory_ids: missing });
    } else {
      const { rows } = await pool.query("SELECT name FROM territories WHERE id = ANY($1) AND company_id IS NOT NULL", [ids]);
      if (rows.length) return res.status(400).json({ error: "Cannot withdraw territories that are already claimed.", names: rows.map(r => r.name) });
    }
    const { rowCount } = await pool.query("UPDATE territories SET offered = $1, boundary_version = COALESCE($2, boundary_version) WHERE id = ANY($3)", [offered ? 1 : 0, req.body.boundary_version || null, ids]);
    await logAudit({ actorType: "admin", action: offered ? "territories_offered" : "territories_withdrawn", detail: { ids, boundary_version: req.body.boundary_version || null } });
    res.json({ updated: rowCount, offered });
  } catch (err) {
    console.error("[admin/territories/offer] Failed:", err);
    res.status(500).json({ error: "Could not update territories." });
  }
});

const bids = require("./bids")({ app, pool, stripe, sendEmail, requireAdmin, authCompany, limiter: publicLimiter, logAudit, basePrice: territoryMonthlyPrice, FRONTEND_URL });

app.get("/", (req, res) => {
  res.json({ status: "CanopyBid backend is running." });
});

initDb()
  .then(() => bids.schema())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CanopyBid backend listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });

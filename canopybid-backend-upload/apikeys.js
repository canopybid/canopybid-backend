// Company dashboard keys.
//  * A key is 48 random hex characters (192 bits). Only a keyed hash (HMAC-SHA-256) is stored, plus the first 6 characters to tell keys apart.
//    A copy of the database or of a backup therefore does not contain working keys.
//  * A new key is shown once (payment-complete screen, rotation, or to the admin when reissued). It cannot be shown again.
//  * Rotation: the company replaces its own key from the dashboard; the old key stops working at once.
//  * Revocation: an admin can revoke a key (lost laptop, departed employee, closed account). A canceled account's key is revoked automatically.
//  * Migration of keys stored the old way: ALLOW_LEGACY_API_KEYS (default on) still accepts the old plain-text column until the admin
//    migration (POST /api/admin/keys/migrate) has filled in the hashes and then blanked the plain-text keys.
//  * API_KEY_PEPPER (optional env): an extra secret mixed into the hash so a database copy alone cannot be used to test guesses. Never change it
//    after keys exist (every key would stop working).
const crypto = require("crypto");
const pepper = () => process.env.API_KEY_PEPPER || "canopybid-key-v1";
const hashKey = k => crypto.createHmac("sha256", pepper()).update(String(k)).digest("hex");
const newKey = () => { const key = crypto.randomBytes(24).toString("hex"); return { key, hash: hashKey(key), prefix: key.slice(0, 6) }; };
const legacyOk = () => String(process.env.ALLOW_LEGACY_API_KEYS || "1") !== "0";

async function schema(pool) {
  await pool.query("ALTER TABLE companies ALTER COLUMN api_key DROP NOT NULL");
  for (const c of ["api_key_hash TEXT", "api_key_prefix TEXT", "api_key_created_at TIMESTAMP", "api_key_revoked_at TIMESTAMP", "api_key_revoked_reason TEXT", "api_key_last_used_at TIMESTAMP", "api_key_reveal TEXT", "api_key_reveal_expires TIMESTAMP"])
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ${c}`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_api_key_hash ON companies (api_key_hash) WHERE api_key_hash IS NOT NULL");
  await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS key_established_at TIMESTAMP");
  // Companies that already have a working key have, by definition, finished setting up.
  await pool.query("UPDATE companies SET key_established_at = COALESCE(api_key_created_at, NOW()) WHERE key_established_at IS NULL AND (api_key_hash IS NOT NULL OR api_key IS NOT NULL)");
  await pool.query(`CREATE TABLE IF NOT EXISTS setup_links (
    id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP NOT NULL, used_at TIMESTAMP, revoked_at TIMESTAMP, revoked_reason TEXT)`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_setup_links_company ON setup_links (company_id)");
}

// ---- Account states -------------------------------------------------------------------------------------------------------------------
//  active     takes new requests, dashboard works.
//  inactive   lost its last territory: takes NO new requests, the dashboard still works for existing requests (retention and deletion rules still run).
//  suspended  closed by us or by billing for now: dashboard access, sessions and unused sign-in links are revoked at once.
//  canceled   closed for good: same revocation.
// Coming back from suspended/canceled is possible only through reinstate() (an explicit admin action) and only with fresh credentials.
const OPEN = ["active", "inactive"];
const isOpen = s => OPEN.includes(s || "active");

// Returns the company row for a presented key, or null (unknown, revoked, malformed). `cols` are extra columns to select ("*" selects all).
async function findCompany(pool, presented, cols) {
  const key = typeof presented === "string" ? presented.trim() : "";
  if (key.length < 20 || key.length > 200) return null;
  const sel = !cols || cols === "*" ? "*" : `id, ${cols}`;
  let row = (await pool.query(`SELECT ${sel} FROM companies WHERE api_key_hash = $1 AND api_key_revoked_at IS NULL AND COALESCE(account_status, 'active') IN ('active','inactive')`, [hashKey(key)])).rows[0];
  if (!row && legacyOk()) row = (await pool.query(`SELECT ${sel} FROM companies WHERE api_key = $1 AND api_key IS NOT NULL AND api_key_revoked_at IS NULL AND COALESCE(account_status, 'active') IN ('active','inactive')`, [key])).rows[0];
  if (row) pool.query("UPDATE companies SET api_key_last_used_at = NOW() WHERE id = $1 AND (api_key_last_used_at IS NULL OR api_key_last_used_at < NOW() - INTERVAL '10 minutes')", [row.id]).catch(() => {});
  return row || null;
}

// One-time reveal. When a company is created by the Stripe webhook, the browser may not have come back yet, and the key can only be shown to the
// browser once. For up to 24 hours the new key is kept ENCRYPTED (AES-256-GCM, key derived from server secrets that are not in the database),
// handed to the checkout-return page once, then erased. After that (or after 24 hours) nothing recoverable remains and an admin must reissue.
const revealKey = () => crypto.createHash("sha256").update("canopybid-reveal|" + (process.env.API_KEY_PEPPER || process.env.STRIPE_WEBHOOK_SECRET || process.env.ADMIN_API_KEY || "dev")).digest();
function seal(key) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", revealKey(), iv); const ct = Buffer.concat([c.update(key, "utf8"), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString("base64")).join("."); }
function unseal(s) { try { const [iv, tag, ct] = String(s).split(".").map(x => Buffer.from(x, "base64")); const d = crypto.createDecipheriv("aes-256-gcm", revealKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString("utf8"); } catch (e) { return null; } }
const REVEAL_SQL = "api_key_reveal = $1, api_key_reveal_expires = NOW() + INTERVAL '24 hours'";
// Returns the key once (and erases it), or null.
async function takeReveal(db, companyId) {
  const row = (await db.query("SELECT api_key_reveal AS sealed FROM companies WHERE id = $1 AND api_key_reveal IS NOT NULL AND api_key_reveal_expires > NOW() FOR UPDATE", [companyId])).rows[0];
  if (!row) return null;
  await db.query("UPDATE companies SET api_key_reveal = NULL, api_key_reveal_expires = NULL WHERE id = $1", [companyId]);
  return unseal(row.sealed);
}
const purgeReveals = pool => pool.query("UPDATE companies SET api_key_reveal = NULL, api_key_reveal_expires = NULL WHERE api_key_reveal IS NOT NULL AND (api_key_reveal_expires IS NULL OR api_key_reveal_expires < NOW())");


// ---- One-time sign-in / setup links ---------------------------------------------------------------------------------------------------
// The link carries a random token (256 bits). Only an HMAC of it is stored. A link expires (SETUP_LINK_HOURS, default 72), works once, and is
// replaced (never added to) when a new one is issued. Opening it asks the company to confirm, then creates the company's dashboard key in the
// browser; nothing reusable is ever emailed. A link never works for a suspended or canceled account.
const linkHours = () => Math.max(1, Number(process.env.SETUP_LINK_HOURS) || 72);
const hashToken = t => crypto.createHmac("sha256", pepper()).update("setup-link|" + String(t)).digest("hex");
async function issueSetupLink(db, companyId, purpose) {
  await db.query("UPDATE setup_links SET revoked_at = NOW(), revoked_reason = 'replaced by a newer link' WHERE company_id = $1 AND used_at IS NULL AND revoked_at IS NULL", [companyId]);
  const token = crypto.randomBytes(32).toString("base64url");
  const r = await db.query("INSERT INTO setup_links (company_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3, NOW() + ($4::int * INTERVAL '1 hour')) RETURNING expires_at", [companyId, hashToken(token), purpose, linkHours()]);
  return { token, expiresAt: r.rows[0].expires_at, hours: linkHours() };
}
// Returns { key, companyId, purpose } on success, or { error: "invalid"|"used"|"expired"|"revoked"|"closed" }. Atomic: two simultaneous attempts cannot both win.
async function redeemSetupLink(pool, token) {
  const t = typeof token === "string" ? token.trim() : "";
  if (t.length < 30 || t.length > 200) return { error: "invalid" };
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const l = (await c.query("SELECT l.id, l.company_id, l.purpose, l.used_at, l.revoked_at, (l.expires_at <= NOW()) AS expired, co.account_status FROM setup_links l JOIN companies co ON co.id = l.company_id WHERE l.token_hash = $1 FOR UPDATE OF l", [hashToken(t)])).rows[0];
    if (!l) { await c.query("ROLLBACK"); return { error: "invalid" }; }
    const bad = l.used_at ? "used" : l.revoked_at ? "revoked" : l.expired ? "expired" : !isOpen(l.account_status) ? "closed" : null;
    if (bad) { await c.query("ROLLBACK"); return { error: bad, companyId: l.company_id }; }
    const nk = newKey();
    await c.query("UPDATE setup_links SET used_at = NOW() WHERE id = $1", [l.id]);
    await c.query("UPDATE companies SET api_key = NULL, api_key_hash = $1, api_key_prefix = $2, api_key_created_at = NOW(), api_key_revoked_at = NULL, api_key_revoked_reason = NULL, api_key_last_used_at = NULL, api_key_reveal = NULL, api_key_reveal_expires = NULL, key_established_at = NOW() WHERE id = $3", [nk.hash, nk.prefix, l.company_id]);
    await c.query("COMMIT");
    return { key: nk.key, companyId: l.company_id, purpose: l.purpose };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
// Ends every way into the dashboard: the key (and so every session that uses it), pending setup links, any held one-time reveal.
async function revokeAccess(db, companyId, reason) {
  await db.query("UPDATE companies SET api_key_revoked_at = COALESCE(api_key_revoked_at, NOW()), api_key_revoked_reason = COALESCE($2, api_key_revoked_reason), api_key_reveal = NULL, api_key_reveal_expires = NULL WHERE id = $1", [companyId, reason || null]);
  await db.query("UPDATE setup_links SET revoked_at = NOW(), revoked_reason = $2 WHERE company_id = $1 AND used_at IS NULL AND revoked_at IS NULL", [companyId, reason || "account closed"]);
}
// The ONLY place account_status changes (apart from creation). Closing (suspended/canceled) revokes access in the same transaction.
// Moving OUT of suspended/canceled is refused here: use reinstate().
async function setStatus(db, companyId, status, reason) {
  if (!["active", "inactive", "suspended", "canceled"].includes(status)) throw new Error("bad status");
  const cur = (await db.query("SELECT account_status FROM companies WHERE id = $1 FOR UPDATE", [companyId])).rows[0];
  if (!cur) return { notFound: true };
  const from = cur.account_status || "active";
  if (!isOpen(from) && isOpen(status)) return { refused: "reinstate_required", from };
  await db.query("UPDATE companies SET account_status = $1 WHERE id = $2", [status, companyId]);
  if (!isOpen(status)) await revokeAccess(db, companyId, reason || "account " + status);
  return { from, to: status, changed: from !== status };
}
// Explicit admin action. Old credentials stay dead: the stored key hash is erased, so even the revoked key cannot come back.
async function reinstate(db, companyId) {
  const cur = (await db.query("SELECT account_status FROM companies WHERE id = $1 FOR UPDATE", [companyId])).rows[0];
  if (!cur) return { notFound: true };
  const from = cur.account_status || "active";
  if (isOpen(from)) return { refused: "not_closed", from };
  const n = (await db.query("SELECT COUNT(*)::int AS n FROM territories WHERE company_id = $1", [companyId])).rows[0].n;
  const to = n > 0 ? "active" : "inactive";
  await db.query("UPDATE companies SET account_status = $1, suspended_by_billing = 0, api_key = NULL, api_key_hash = NULL, api_key_prefix = NULL, api_key_reveal = NULL, api_key_reveal_expires = NULL, api_key_revoked_at = NOW(), api_key_revoked_reason = 'reinstated: fresh credentials required', key_established_at = NULL WHERE id = $2", [to, companyId]);
  const link = await issueSetupLink(db, companyId, "reinstate");
  return { from, to, link };
}
const setupEmail = (kind, name, url, hours) => {
  const intro = kind === "reinstate" ? "Your CanopyBid account has been reinstated. Your old dashboard access was ended when the account was closed, so you need to set up new access."
    : kind === "replacement" ? "You asked for a new sign-in link."
    : kind === "admin" ? "We sent you a new sign-in link."
    : "Welcome to CanopyBid. Use the link below to set up your dashboard.";
  return `<p>Hello ${String(name || "").replace(/[<>&]/g, "")},</p><p>${intro}</p><p><a href="${url}">Open my one-time sign-in link</a></p><p>The link works <strong>once</strong> and expires in ${hours} hours. If it has expired or was used, ask for a new one on the dashboard sign-in page; we never email a reusable key or password. If you did not expect this email, ignore it: nothing happens unless the link is opened.</p><p>Questions: hello@canopybid.com</p>`;
};
const setupUrl = (base, token) => `${base}/canopybid-companies.html#setup=${token}`;

module.exports = { OPEN, isOpen, issueSetupLink, redeemSetupLink, revokeAccess, setStatus, reinstate, setupEmail, setupUrl, hashToken, hashKey, newKey, findCompany, schema, legacyOk, seal, takeReveal, purgeReveals, REVEAL_SQL };

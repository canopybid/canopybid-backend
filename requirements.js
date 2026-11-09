// Partner document requirements and lead eligibility, in one place.
//
// What a company must have VERIFIED before it can receive automatic leads is configuration, not code:
//   data/partner_requirements.json  (or the PARTNER_REQUIREMENTS_JSON env var, same shape)
// Rule for each document type (license, insurance):
//   required = (market override ?? default) OR any selected service that requires it.
// Nothing in that file is legal advice; set it to what your market actually requires.
//
// Two different things are tracked, and never mixed:
//   * SELF-REPORTED: what the company typed (license number, insurance carrier). Shown as "self-reported".
//   * VERIFIED: a document an admin has opened and approved (status = verified, with an expiry date).
// Only verified documents count toward eligibility.
//
// Companies created before this existed have required_docs = NULL and keep the original rule: license AND insurance verified.
const fs = require("fs");
const path = require("path");

const DOCS = ["license", "insurance"];
const FALLBACK = {
  version: 1,
  defaults: { license: { required: false }, insurance: { required: true } },
  markets: {},
  services: {}
};
const LABELS = {
  license: { name: "License document", short: "License", ask: "Upload a copy of your business or contractor license." },
  insurance: { name: "Insurance certificate", short: "Insurance", ask: "Upload your certificate of liability insurance." }
};

function loadConfig() {
  try {
    const raw = process.env.PARTNER_REQUIREMENTS_JSON || fs.readFileSync(path.join(__dirname, "data", "partner_requirements.json"), "utf8");
    const c = JSON.parse(raw);
    return { ...FALLBACK, ...c, defaults: { ...FALLBACK.defaults, ...(c.defaults || {}) } };
  } catch (e) { console.warn("[requirements] using built-in defaults:", e.message); return FALLBACK; }
}
const cfg = loadConfig();

// Which documents a company with this market and these services must have verified.
function requiredFor(market, services) {
  const mk = (cfg.markets || {})[market] || {};
  const out = [];
  for (const d of DOCS) {
    let req = (mk[d] && typeof mk[d].required === "boolean") ? mk[d].required : !!(cfg.defaults[d] && cfg.defaults[d].required);
    for (const s of services || []) if (((cfg.services || {})[s] || {})[d] && cfg.services[s][d].required === true) req = true;
    if (req) out.push(d);
  }
  return out;
}

// The documents a company must have verified. NULL (older companies) means both, as before.
function requiredDocsOf(row) {
  if (row && row.required_docs) { try { const a = JSON.parse(row.required_docs); if (Array.isArray(a)) return a.filter(d => DOCS.includes(d)); } catch (e) { /* fall through */ } }
  return DOCS.slice();
}

function docState(row, d, now) {
  const st = row[d + "_status"] || "not_uploaded";
  if (st === "verified") {
    const exp = row[d + "_expiration"];
    if (exp && new Date(exp).getTime() < (now || Date.now())) return "expired";
    return "verified";
  }
  return st === "pending" ? "pending_review" : st;   // not_uploaded | pending_review | rejected
}
const STATE_TEXT = {
  not_uploaded: "Not uploaded yet",
  pending_review: "Uploaded, waiting for review",
  rejected: "Rejected, upload a new copy",
  expired: "Expired, upload a current copy",
  verified: "Reviewed and accepted"
};

// What is verified and what is still pending, for a company or an application row.
function documentStatus(row, now) {
  const required = requiredDocsOf(row);
  const items = DOCS.map(d => {
    const state = docState(row, d, now);
    return { key: d, label: LABELS[d].name, required: required.includes(d), state, state_text: STATE_TEXT[state], ask: state === "verified" ? null : LABELS[d].ask,
      expiration: row[d + "_expiration"] || null, verified_at: row[d + "_verified_at"] || null, filename: row[d + "_filename"] || null };
  });
  const pending = items.filter(i => i.required && i.state !== "verified");
  return { required, items, pending, documents_ok: pending.length === 0 };
}

// The tree-company agreement a company must accept before it receives real homeowner requests.
// The text is a DRAFT for lawyer review (company-agreement.html). When the lawyer's final text is in place, change this version
// string (COMPANY_AGREEMENT_VERSION) and every company must accept the new version before requests are sent again.
// REQUIRE_COMPANY_AGREEMENT=0 switches the gate off (test environments only).
const AGREEMENT_VERSION = process.env.COMPANY_AGREEMENT_VERSION || "draft-2026-10-27";
const agreementRequired = () => String(process.env.REQUIRE_COMPANY_AGREEMENT || "1") !== "0";

// Full lead eligibility for a company row: documents plus account state.
function eligibility(c, now) {
  if (!c) return { eligible: false, pending: [{ key: "account", label: "Account", state: "missing", state_text: "No account" }], items: [], required: [] };
  const ds = documentStatus(c, now);
  const pending = ds.pending.slice();
  if ((c.account_status || "active") !== "active") pending.push({ key: "account", label: "Account status", state: c.account_status, state_text: c.account_status === "inactive" ? "You hold no territory, so no new requests are sent. Your existing requests stay available here until our retention and deletion rules remove them." : "Account is " + c.account_status });
  if (agreementRequired() && c.agreement_version !== AGREEMENT_VERSION) pending.push({ key: "agreement", label: "Company agreement", state: "not_accepted", state_text: c.agreement_version ? "A new version needs your acceptance" : "Not accepted yet" });
  if (c.accepting_leads === 0) pending.push({ key: "accepting", label: "Accepting leads", state: "off", state_text: "Turned off in your profile" });
  return { eligible: pending.length === 0, pending, items: ds.items, required: ds.required };
}

module.exports = { AGREEMENT_VERSION, agreementRequired, cfg, DOCS, LABELS, requiredFor, requiredDocsOf, documentStatus, eligibility, docState };

// db.js
// Hosted Postgres, via the DATABASE_URL your hosting provider gives you
// (Render, Railway, Supabase, Neon all work). This replaces the local
// SQLite file used during development — SQLite doesn't survive a real
// deploy, since most hosts wipe local disk on every restart.

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most hosted Postgres providers require SSL but use a certificate chain
  // your Node install may not have — this is the standard workaround.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      api_key TEXT NOT NULL UNIQUE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      license_doc TEXT,
      license_media_type TEXT,
      license_filename TEXT,
      license_status TEXT DEFAULT 'not_uploaded',
      license_uploaded_at TIMESTAMP,
      license_number TEXT,
      license_expiration DATE,
      insurance_doc TEXT,
      insurance_media_type TEXT,
      insurance_filename TEXT,
      insurance_status TEXT DEFAULT 'not_uploaded',
      insurance_uploaded_at TIMESTAMP,
      insurance_carrier TEXT,
      insurance_policy_number TEXT,
      insurance_expiration DATE,
      legal_name TEXT,
      dba TEXT,
      owner_name TEXT,
      business_address TEXT,
      website TEXT,
      years_in_business INTEGER,
      equipment_notes TEXT,
      crew_count INTEGER,
      weekly_lead_capacity INTEGER,
      desired_response_minutes INTEGER,
      accepting_leads INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS territories (
      id SERIAL PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'TN',
      metro TEXT NOT NULL,
      name TEXT NOT NULL,
      factor REAL NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      status TEXT DEFAULT 'available',
      pilot INTEGER DEFAULT 0,
      UNIQUE(state, metro, name)
    );
  `);

  // --- Nashville-focus additions (all idempotent; safe to run on every start) ---
  // A territory is purchasable only when offered = 1 (its boundary has been confirmed by an admin).
  await pool.query("ALTER TABLE territories ADD COLUMN IF NOT EXISTS offered INTEGER DEFAULT 0");
  await pool.query("ALTER TABLE territories ADD COLUMN IF NOT EXISTS boundary_version TEXT");
  // Customer-facing name. Routing never reads it; ids and ZIPs decide everything.
  await pool.query("ALTER TABLE territories ADD COLUMN IF NOT EXISTS display_name TEXT");
  await pool.query("ALTER TABLE territories ADD COLUMN IF NOT EXISTS retired INTEGER DEFAULT 0");   // merged into another territory: kept for history, never listed or sold
  // ZIP -> territory assignments used for lead routing (one territory per ZIP).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS territory_zips (
      zip TEXT PRIMARY KEY,
      territory_id INTEGER NOT NULL REFERENCES territories(id),
      status TEXT,
      boundary_version TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_territory_zips_territory ON territory_zips(territory_id)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      zip TEXT,
      state TEXT,
      metro TEXT,
      territory_name TEXT,
      territory_id INTEGER REFERENCES territories(id),
      services TEXT,
      timeframe TEXT,
      insurance INTEGER DEFAULT 0,
      access TEXT,
      species TEXT,
      height TEXT,
      dbh TEXT,
      crown TEXT,
      conditions_json TEXT,
      inspection_required INTEGER DEFAULT 0,
      quote_low INTEGER,
      quote_high INTEGER,
      confidence_label TEXT,
      lead_quality TEXT,
      trees_json TEXT,
      status TEXT DEFAULT 'submitted',
      owner_confirmed INTEGER DEFAULT 0,
      consent_version TEXT,
      consent_timestamp TIMESTAMP,
      consent_ip TEXT,
      duplicate_flag INTEGER DEFAULT 0,
      duplicate_reason TEXT,
      admin_reviewed INTEGER DEFAULT 0,
      admin_notes TEXT,
      resume_token TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // --- payments hardening: reservations while a buyer is paying, Stripe webhook de-duplication, billing-driven suspension ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkout_reservations (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      buyer_email TEXT,
      territory_id INTEGER NOT NULL REFERENCES territories(id),
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // At most ONE live reservation per territory, enforced by the database itself (safe under concurrent checkouts).
  await pool.query("ALTER TABLE checkout_reservations ADD COLUMN IF NOT EXISTS buyer_email TEXT");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_pending ON checkout_reservations (territory_id) WHERE status = 'pending'");
  await pool.query("CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT, received_at TIMESTAMP DEFAULT NOW())");
  await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended_by_billing INTEGER DEFAULT 0");
  await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_company_checkout_session ON companies (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL");
  await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_basis TEXT");
  // Company account state for lead eligibility: active | suspended | canceled. Set by an admin (no Stripe webhook yet).
  await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active'");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_leads_territory_created ON leads(territory_id, created_at)");
  // Routing outcome, recorded on every lead. territory_name/metro on a lead now mean the territory it was ROUTED to
  // (null when unassigned); what the form guessed is kept only as an informational hint.
  await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_status TEXT");
  await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_reason TEXT");
  await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_company_id INTEGER REFERENCES companies(id)");
  await pool.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS submitted_territory_hint TEXT");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_leads_assigned_company ON leads(assigned_company_id)");
  // One-time backfill for leads that existed before these columns (touches only rows still null).
  await pool.query(`UPDATE leads SET assigned_company_id = t.company_id FROM territories t
                     WHERE leads.territory_id = t.id AND leads.assigned_company_id IS NULL
                       AND leads.status <> 'submitted' AND t.company_id IS NOT NULL`);
  await pool.query(`UPDATE leads SET routing_status = CASE WHEN assigned_company_id IS NOT NULL THEN 'assigned' ELSE 'unassigned' END,
                           routing_reason = CASE WHEN assigned_company_id IS NOT NULL THEN NULL ELSE 'legacy' END
                     WHERE routing_status IS NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_status_history (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id),
      status TEXT NOT NULL,
      changed_by TEXT,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_books (
      company_id INTEGER PRIMARY KEY REFERENCES companies(id),
      crew_rate REAL,
      bucket_truck_rate REAL,
      crane_rate REAL,
      climber_rate REAL,
      disposal_rate REAL,
      stump_rate_per_inch REAL,
      minimum_charge REAL,
      travel_rate REAL,
      permit_cost REAL,
      margin_pct REAL,
      emergency_multiplier REAL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      actor_type TEXT,
      actor_id TEXT,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_disputes (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id),
      company_id INTEGER REFERENCES companies(id),
      reason TEXT,
      detail TEXT,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Seed territories once. Organized by state so adding a new state later is
  // just a new block here (and a matching price book on the frontend) —
  // nothing about the schema or the app's logic needs to change.
  const territorySeed = {
    TN: [
      ["Nashville", "Nashville Core", 1.04],
      ["Nashville", "Williamson North", 1.03],
      ["Nashville", "Williamson Central", 1.03],
      ["Nashville", "Williamson South", 1.06],
      ["Nashville", "Rutherford", 1.00],
      ["Nashville", "Wilson", 1.02],
      ["Nashville", "Sumner", 1.02],
      ["Nashville", "Robertson/Cheatham", 1.05],
      ["Nashville", "Dickson", 1.08],
      ["Memphis", "Memphis Core", 0.95],
      ["Memphis", "Germantown", 0.97],
      ["Memphis", "Collierville", 0.98],
      ["Memphis", "Bartlett", 0.94],
      ["Memphis", "Northeast Shelby", 0.98],
      ["Memphis", "North Shelby", 0.98],
      ["Memphis", "South Shelby", 0.93],
      ["Memphis", "Fayette County", 1.03],
      ["Chattanooga", "Chattanooga Core", 0.99],
      ["Chattanooga", "East Chattanooga", 0.98],
      ["Chattanooga", "North Hamilton", 1.00],
      ["Chattanooga", "Mountain Territory", 1.13],
      ["Chattanooga", "Southeast Hamilton", 1.01],
      ["Chattanooga", "Bradley County", 1.03],
      ["Knoxville", "Knoxville Core", 0.98],
      ["Knoxville", "West Knoxville", 1.00],
      ["Knoxville", "Farragut", 1.01],
      ["Knoxville", "North Knox", 1.00],
      ["Knoxville", "Anderson County", 1.03],
      ["Knoxville", "Blount County", 1.03],
      ["Knoxville", "Sevier County", 1.09],
      ["Knoxville", "Mountain Territory", 1.20]
    ]
    // Next state goes here, e.g.:
    // GA: [ ["Atlanta", "Atlanta Core", 1.05], ... ]
  };

  const { rows } = await pool.query("SELECT COUNT(*) AS n FROM territories");
  if (Number(rows[0].n) === 0) {
    let count = 0;
    for (const [state, territories] of Object.entries(territorySeed)) {
      for (const [metro, name, factor] of territories) {
        await pool.query(
          "INSERT INTO territories (state, metro, name, factor) VALUES ($1, $2, $3, $4)",
          [state, metro, name, factor]
        );
        count++;
      }
    }
    console.log(`Seeded ${count} territories.`);
  }
}

module.exports = { pool, initDb };

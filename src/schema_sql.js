// Auto-generated from schema.sql. Do not edit here; edit schema.sql and regenerate.
export default `-- ============================================================
-- BERESPRO API — D1 schema (prepaid wallet model)
-- Money is stored in CENTS (integer) everywhere. Never floats.
-- Payments are held by a LICENSED PSP (authorize -> capture -> split payout).
-- Berespro never touches customer funds.
-- ============================================================

-- ---------- migrations (safe to re-run; /setup skips "duplicate column") ----------
-- CREATE TABLE IF NOT EXISTS does not add columns to a table that already
-- exists, so any new column added to an existing table needs an explicit ALTER
-- here. Each one is its own statement so a partial failure doesn't cascade.
ALTER TABLE payments ADD COLUMN card_fp TEXT;

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- usr_xxx
  firebase_uid  TEXT UNIQUE,                -- from verified Firebase token
  phone         TEXT UNIQUE,
  email         TEXT,
  name          TEXT NOT NULL DEFAULT 'New user',
  avatar_hue    INTEGER NOT NULL DEFAULT 214,
  mode          TEXT NOT NULL DEFAULT 'customer',  -- customer | partner
  city          TEXT DEFAULT 'Kuala Lumpur',
  lat           REAL DEFAULT 3.139,
  lng           REAL DEFAULT 101.687,
  skills        TEXT DEFAULT '[]',          -- JSON array (partner)
  id_verified   INTEGER NOT NULL DEFAULT 0,
  suspended     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_firebase ON users(firebase_uid);

-- ---------- sessions (refresh tokens) ----------
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,           -- ses_xxx
  user_id       TEXT NOT NULL,
  refresh_hash  TEXT NOT NULL,             -- sha256 of refresh token
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------- tasks ----------
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,          -- tsk_xxx
  customer_id    TEXT NOT NULL,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL,
  city           TEXT NOT NULL,
  addr           TEXT,
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  budget_cents   INTEGER NOT NULL,
  date_label     TEXT,
  time_slot      TEXT,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'open',  -- open | inprogress | completed | cancelled
  accepted_bid_id TEXT,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id);
-- bounding-box prefilter for the geo feed:
CREATE INDEX IF NOT EXISTS idx_tasks_geo ON tasks(status, lat, lng);

-- ---------- bids ----------
CREATE TABLE IF NOT EXISTS bids (
  id            TEXT PRIMARY KEY,           -- bid_xxx
  task_id       TEXT NOT NULL,
  partner_id    TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | lost
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (partner_id) REFERENCES users(id),
  UNIQUE(task_id, partner_id)              -- one bid per partner per task
);
CREATE INDEX IF NOT EXISTS idx_bids_task ON bids(task_id);
CREATE INDEX IF NOT EXISTS idx_bids_partner ON bids(partner_id);

-- ---------- reviews ----------
CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,           -- rev_xxx
  task_id       TEXT NOT NULL,
  rater_id      TEXT NOT NULL,             -- who wrote it
  ratee_id      TEXT NOT NULL,             -- who is rated
  rating        INTEGER NOT NULL,          -- 1..5
  text          TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  UNIQUE(task_id, rater_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_ratee ON reviews(ratee_id);

-- ---------- wallet transactions (immutable ledger) ----------

-- ---------- devices (FCM push) ----------
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  fcm_token     TEXT NOT NULL,
  platform      TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(user_id, fcm_token)
);

-- ---------- notifications ----------
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,           -- ntf_xxx
  user_id       TEXT NOT NULL,
  type          TEXT NOT NULL,             -- bid | job | pay | star
  title         TEXT NOT NULL,
  body          TEXT,
  read          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_ntf_user ON notifications(user_id, created_at);

-- ---------- partner payout accounts (PSP sub-merchant) ----------
CREATE TABLE IF NOT EXISTS partner_merchants (
  user_id         TEXT PRIMARY KEY,
  psp_merchant_id TEXT,                       -- id returned by PSP
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | active | rejected
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ---------- payments (PSP-held escrow) ----------
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,           -- pay_xxx
  task_id       TEXT NOT NULL,
  bid_id        TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  partner_id    TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,           -- gross (bid amount)
  fee_cents     INTEGER NOT NULL,           -- platform 20%
  net_cents     INTEGER NOT NULL,           -- partner 80%
  discount_cents INTEGER NOT NULL DEFAULT 0, -- voucher discount (absorbed by platform fee)
  voucher_code  TEXT,
  psp_ref       TEXT,                        -- PSP transaction id
  card_fp       TEXT,                        -- stable card fingerprint from the PSP (same physical
                                             -- card = same value, across tokens AND accounts).
                                             -- Used to spot one card farming many accounts.
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | held | captured | refunded | failed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (bid_id) REFERENCES bids(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_task ON payments(task_id);
CREATE INDEX IF NOT EXISTS idx_payments_pspref ON payments(psp_ref);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_cardfp ON payments(card_fp);

-- ---------- KYC submissions (partner identity verification) ----------
-- We store DOCUMENT REFERENCES and masked identifiers only — never raw IC numbers.
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id             TEXT PRIMARY KEY,          -- kyc_xxx
  user_id        TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  ic_last4       TEXT NOT NULL,             -- last 4 digits only (masked)
  doc_front_url  TEXT NOT NULL,             -- R2/Storage reference
  doc_back_url   TEXT,
  selfie_url     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reject_reason  TEXT,
  created_at     INTEGER NOT NULL,
  reviewed_at    INTEGER,
  reviewed_by    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_submissions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_submissions(status);

-- ---------- disputes (freeze escrow release until resolved) ----------
CREATE TABLE IF NOT EXISTS disputes (
  id           TEXT PRIMARY KEY,            -- dsp_xxx
  task_id      TEXT NOT NULL,
  opened_by    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',   -- open | resolved_refund | resolved_release
  resolved_by  TEXT,
  resolution_note TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_disputes_task ON disputes(task_id, status);

-- ---------- audit log (immutable trail of sensitive actions) ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,     -- e.g. bid.accept, payment.capture, kyc.approve, dispute.resolve
  ref         TEXT,              -- related entity id
  meta        TEXT,              -- JSON details
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);

-- ---------- rate limits (simple fixed-window) ----------
CREATE TABLE IF NOT EXISTS rate_limits (
  rl_key        TEXT PRIMARY KEY,   -- e.g. "bids:usr_x:day" or "auth:1.2.3.4:10m"
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);

-- ---------- vouchers (marketing; discount absorbed by PLATFORM FEE, never partner) ----------
CREATE TABLE IF NOT EXISTS vouchers (
  id                 TEXT PRIMARY KEY,      -- vch_xxx
  code               TEXT UNIQUE NOT NULL,  -- e.g. BERES10
  type               TEXT NOT NULL,         -- percent | fixed
  value              INTEGER NOT NULL,      -- percent: basis points (1000=10%); fixed: cents
  min_amount_cents   INTEGER NOT NULL DEFAULT 0,
  max_discount_cents INTEGER,               -- cap per redemption (nullable)
  usage_limit        INTEGER,               -- total redemptions allowed (nullable = unlimited)
  per_user_limit     INTEGER NOT NULL DEFAULT 1,
  expires_at         INTEGER,               -- unix (nullable)
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id             TEXT PRIMARY KEY,
  voucher_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  payment_id     TEXT NOT NULL,
  discount_cents INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id)
);
CREATE INDEX IF NOT EXISTS idx_vred_voucher ON voucher_redemptions(voucher_id);
CREATE INDEX IF NOT EXISTS idx_vred_user ON voucher_redemptions(voucher_id, user_id);

-- ---------- cancellations (rolling record; drives partner strikes) ----------
CREATE TABLE IF NOT EXISTS cancellations (
  id          TEXT PRIMARY KEY,             -- can_xxx
  task_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,                -- who cancelled
  role        TEXT NOT NULL,                -- customer | partner
  stage       TEXT NOT NULL,                -- open | accepted | inprogress
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_cancel_user ON cancellations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cancel_task ON cancellations(task_id);

-- ---------- settings (tunable platform parameters incl. feed algorithm) ----------
CREATE TABLE IF NOT EXISTS settings (
  s_key   TEXT PRIMARY KEY,
  s_value TEXT NOT NULL
);
-- defaults are applied in code when a key is missing:
--   algo_w_distance=50, algo_w_recency=30, algo_w_budget=20 (recommended-feed weights)
--   commission_bps=2000 (overrides env if set)
`;

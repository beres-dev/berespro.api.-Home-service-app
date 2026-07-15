# Berespro — Security Posture & Checklist

Practical security documentation for the Berespro API. This is the engineering
companion to the legal policies.

## Implemented in code (this repo)
| Control | Where | Protects |
|---|---|---|
| Firebase RS256 token verification (aud/iss/exp/signature vs Google JWKS) | lib/auth.js | Account takeover via forged tokens |
| Short-lived access JWT (1h) + rotating refresh (30d, hashed at rest) | routes/auth.js | Token theft blast radius |
| PSP webhook signature verification + idempotent state transitions | routes/payments.js | Forged "paid/held/captured" events, double-crediting |
| Money as integer cents, server-computed 80/20 split | all payment paths | Rounding/float manipulation, client-side price tampering |
| KYC gate before bidding; document refs + IC last-4 only in DB | routes/kyc.js | User safety; identity data minimisation |
| Dispute freeze: no capture/refund while contested | routes/disputes.js, jobs.js | Unilateral fund grabs by either party |
| Ownership checks on every read/write (task owner, bid partner, payment party) | all routes | IDOR / horizontal privilege escalation |
| Admin allow-list (ADMIN_IDS) for KYC review, dispute resolution, verification | kyc/disputes/partners | Privilege escalation |
| Input validation: length caps, numeric bounds, coordinate ranges | lib/guard.js + routes | Injection payload size, garbage data, absurd amounts |
| Parameterised SQL everywhere (D1 bind) | all routes | SQL injection |
| Rate limits: auth 10/10min/IP, tasks 20/day, bids 60/day, KYC 3/day, max 10 open tasks | lib/guard.js | Bruteforce, spam, scraping, resource abuse |
| Audit log of sensitive actions (accept, capture, refund, KYC, dispute) | lib/guard.js | Forensics, accountability, PDPA evidence |
| Security headers (nosniff, no-referrer, no-store) + CORS | lib/util.js | Response sniffing, cache leaks |
| Unique constraints (one bid per partner/task, one review per rater/task) | schema.sql | Duplicate spam, review stuffing |

## Deploy-time checklist (before production)
- [ ] Set strong `JWT_SECRET` (32+ random chars) via `wrangler secret put`
- [ ] Match `PSP_SECRET` verification to your PSP's actual signature scheme — the
      stub scheme MUST be replaced; test with the PSP's webhook simulator
- [ ] Restrict CORS `access-control-allow-origin` from `*` to your app origins
- [ ] Turn on Cloudflare WAF managed rules + Bot Fight Mode for the Worker route
- [ ] Add Cloudflare Rate Limiting rules as a second layer (edge-level)
- [ ] Create a PRIVATE R2 bucket for KYC docs; upload via signed URLs only;
      never make it public; set lifecycle deletion per Privacy Policy §4
- [ ] Set `ADMIN_IDS` to real admin user ids; never leave empty in prod
- [ ] Enable D1 automated backups / time travel; test a restore once
- [ ] Set up `wrangler tail` alerting or Logpush for 5xx spikes and webhook 401s

## Operational practices
- Rotate `JWT_SECRET` and PSP keys on staff departure or suspected leak
  (rotating JWT_SECRET invalidates all sessions — announce in-app)
- Review audit_log weekly for anomalies (bulk accepts, repeated disputes)
- Dependency policy: this Worker is deliberately zero-dependency at runtime;
  keep it that way — every npm package added is supply-chain surface
- Incident response: (1) revoke affected sessions (delete rows in `sessions`),
  (2) pause payments by feature flag, (3) preserve audit_log, (4) notify users
  per PDPA if personal data was exposed
- Vulnerability disclosure: publish a security contact (security@[domain]) and
  respond within 72h. Consider a simple /.well-known/security.txt

## Known limitations (honest list)
- D1 rate limiter is fixed-window and per-database — fine for MVP scale; move to
  Durable Objects or edge rules if you see >50 rps
- No 2FA on admin accounts yet — protect admin logins with strong Firebase
  factors; add TOTP before the admin panel handles real KYC volume
- Chat/messages not yet implemented — when added, they need content moderation
  and a report mechanism (Play policy requirement for UGC)

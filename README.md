# Berespro API — Escrow (PSP-held) model

Cloudflare Workers + D1. Berespro never touches customer funds — a licensed PSP holds,
splits (80/20), and pays out. Full guide in GUIDE.md.

    npm install
    npx wrangler d1 create berespro   # paste id into wrangler.toml
    npm run db:init && npm run dev

Test:  node test/e2e.mjs   # 17 e2e checks

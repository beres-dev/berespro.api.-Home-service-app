# BERESPRO API — PANDUAN A–Z (Model Escrow PSP)

Backend lengkap untuk Berespro. Model **escrow yang dipegang PSP berlesen** — Berespro **tidak pernah** sentuh duit customer. PSP tahan (authorize), lepas + split 80/20 (capture), atau refund (void) atas arahan API kita.

Dibina atas **Cloudflare Workers + D1**. Semua kod sudah ditulis, di-syntax-check, dan diuji end-to-end (**17/17 lulus**). Siap `wrangler deploy`.

---

## 0. Aliran duit (authorize → capture → split)

```
Partner connect payout (sekali) ──► jadi sub-merchant di PSP (KYC oleh PSP)

Customer accept bid ─► PSP AUTHORIZE (tahan duit customer)  [payment: pending]
   └─ customer bayar di halaman PSP ─► webhook "held"        [payment: held → task inprogress]

Partner buat kerja ─► tanda "complete"
Customer confirm  ─► PSP CAPTURE ─► split: 80% ke partner, 20% ke Berespro  [payment: captured]

Batal / dispute   ─► PSP VOID/REFUND ─► duit balik ke customer             [payment: refunded]
```

Duit tak pernah masuk akaun Berespro. PSP pegang, PSP split, PSP payout ke partner. Ini yang buat model ni **legal tanpa lesen BNM sendiri** — lesen PSP yang cover.

**Friction rendah (matlamat awak):** customer bayar sekali sahaja masa accept, tak fikir apa-apa lagi. Partner cuma perlu connect payout **sekali** (borang ringkas, KYC oleh PSP), lepas tu boleh menang job tanpa keluar duit sendiri.

---

## 1. Prasyarat (daftar dulu — ini yang makan masa)

| Perlu | Untuk apa | Masa |
|---|---|---|
| Akaun Cloudflare (percuma) | Worker + D1 | Segera |
| `npm i -g wrangler` | Tooling | Segera |
| Projek Firebase | Google sign-in + OTP + FCM | 1 jam |
| **PSP marketplace berlesen** | Escrow authorize/capture/split + payout | **onboarding paling ketat — mula hari ini** |
| Entiti SSM + akaun bank | Prasyarat PSP | Ikut SSM |
| Akaun Google Play (USD 25) | Publish app | Segera |

**PSP Malaysia yang boleh split/marketplace escrow:** iPay88 (split settlement), Curlec by Razorpay (Route), atau senangPay marketplace. Semak keupayaan **authorize-hold + capture + split payout ke sub-merchant** semasa onboarding — bukan semua PSP ada. Ini yang tentukan butiran `src/lib/psp.js`.

Nota FPX: kad sokong authorize-hold sebenar. FPX (online banking) tak — untuk FPX, PSP debit ke akaun amanah dan "capture" jadi "release dari amanah". Adapter awak sembunyikan perbezaan ni; state `pending → held → captured/refunded` sama.

---

## 2. Setup (15 minit)

```bash
cd berespro-api && npm install
npx wrangler login
npx wrangler d1 create berespro          # salin database_id → wrangler.toml
npx wrangler secret put JWT_SECRET
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put PSP_SECRET        # secret tandatangan webhook PSP
npx wrangler secret put FCM_SERVER_KEY
# bila PSP dipilih, tambah juga: PSP_KEY, PSP_BASE (ikut adapter)
npm run db:init                           # cipta jadual di D1
npm run dev                               # http://127.0.0.1:8787
npm run deploy
```

---

## 3. Endpoint penuh

Auth `Bearer <accessToken>` kecuali `/auth/*`, `/webhooks/psp`, `/partners/:id`, `/health`. Money **cents**.

### Auth
| Method | Path | Guna |
|---|---|---|
| POST | `/auth/session` | Token Firebase → session. Auto-cipta user. |
| POST | `/auth/refresh` | Rotasi token. |
| GET/PATCH | `/me` | Profil / kemas kini. |

### Tasks
| Method | Path | Guna |
|---|---|---|
| POST | `/tasks` | Post task. |
| GET | `/tasks?lat=&lng=&radius=&cat=&sort=` | Feed partner (geo + distance). |
| GET | `/me/tasks` | Task sendiri. |
| GET | `/tasks/:id` | Butiran (+ bids jika pemilik). |
| PATCH | `/tasks/:id` | Batal (open). |

### Bids
| Method | Path | Guna |
|---|---|---|
| POST | `/tasks/:id/bids` | Partner bid. |
| POST | `/bids/:id/accept` | **PSP authorize** → pulang `payment_url` + split. Ditolak `409 partner_payout_not_connected` jika partner belum connect payout. |
| POST | `/bids/:id/decline` | Tolak bid. |
| GET | `/me/bids` | Bid partner. |

### Jobs (escrow lifecycle)
| Method | Path | Guna |
|---|---|---|
| POST | `/jobs/:taskId/complete` | Partner tanda siap. |
| POST | `/jobs/:taskId/confirm` | Customer confirm → **PSP capture + split 80/20**. |
| POST | `/jobs/:taskId/cancel` | Batal in-progress → **refund** hold. |
| POST | `/jobs/:taskId/review` | Rating 1–5. |

### Payments & payout
| Method | Path | Guna |
|---|---|---|
| GET | `/payments/:id` | Status bayaran (pending/held/captured/refunded). |
| POST | `/webhooks/psp` | Dipanggil PSP. Sahkan tandatangan → held finalize accept / captured / refunded / merchant.activated. Idempotent. |
| POST | `/partners/connect` | Partner cipta payout account (sub-merchant PSP). Pulang `status` + `onboarding_url?`. |
| GET | `/me/payout` | Status payout partner. |

### KYC (perlindungan pengguna — partner masuk rumah orang)
| Method | Path | Guna |
|---|---|---|
| POST | `/kyc/submit` | Partner hantar: nama penuh, 4 digit akhir IC, rujukan dokumen (R2), selfie. |
| GET | `/me/kyc` | Status: not_submitted / pending / approved / rejected. |
| GET | `/kyc/pending` | ADMIN — barisan semakan. |
| POST | `/kyc/:id/review` | ADMIN — approve/reject. Approve → `id_verified`, partner boleh bid. |

**Gate:** partner TIDAK boleh bid sebelum KYC diluluskan (`403 kyc_required`). Boleh dimatikan dengan `REQUIRE_KYC_TO_BID="0"` tapi jangan — ini perlindungan utama customer.

### Disputes (bekukan escrow sampai diselesaikan)
| Method | Path | Guna |
|---|---|---|
| POST | `/jobs/:taskId/dispute` | Mana-mana pihak buka dispute (in-progress). Payment beku — confirm & cancel diblok. |
| GET | `/disputes/open` | ADMIN — barisan. |
| POST | `/disputes/:id/resolve` | ADMIN — `refund` (duit balik customer) atau `release` (capture ke partner). Diaudit. |

### Partners & notifications
| Method | Path | Guna |
|---|---|---|
| GET | `/partners/:id` | Profil awam + rating + `payout_status`. |
| POST | `/partners/:id/verify` | Admin — ID verified. |
| POST | `/me/devices` | Daftar FCM. |
| GET | `/me/notifications` · POST `/notifications/read` | Notifikasi. |

---

## 4. Clerk (auth Google + OTP dalam satu — tiada SHA-1/google-services.json)

Clerk uruskan Google sign-in DAN phone OTP di sebelah app. Backend cuma **sahkan token Clerk** (RS256 lawan JWKS instance awak), kemudian keluarkan session JWT sendiri. Tiada fail config Android — itu sebab kita pilih Clerk.

1. clerk.com → cipta application → aktifkan **Google** dan **Phone (SMS OTP)** dalam User & authentication.
2. **PENTING (Malaysia):** SMS → Settings → aktifkan **Malaysia** dalam allowlist. Default hanya US/Canada; nombor +60 akan ditolak kalau tak diaktifkan.
3. Dashboard → **API Keys** → salin **Frontend API / Publishable key** (untuk app) dan **Issuer** (untuk backend).
4. Set secrets backend:
   ```
   wrangler secret put CLERK_ISSUER      # cth https://your-app.clerk.accounts.dev
   # CLERK_JWKS_URL optional — default = CLERK_ISSUER + /.well-known/jwks.json
   ```
5. **JWT template (supaya phone/email/name sampai ke backend):** Clerk Dashboard → JWT Templates → New. Tambah claims:
   ```json
   { "phone_number": "{{user.primary_phone_number}}",
     "email": "{{user.primary_email_address}}",
     "name": "{{user.full_name}}" }
   ```
   App minta token guna template ni (`getToken({ template: "berespro" })`), hantar ke `POST /auth/session { clerkToken }`.
6. Backend sahkan token (issuer + exp + signature lawan JWKS Clerk) dan pulang session JWT awak.

**Kos:** free tier 50K MRU (churn tak dikira). SMS OTP ~USD $0.01/mesej pass-through. Skala awak = pada dasarnya percuma.

Backend **tak simpan kata laluan atau OTP** — Clerk uruskan. Clerk user id disimpan dalam kolum `firebase_uid` (dikekalkan sebagai kolum identiti-luaran untuk elak migrasi).

## 5. PSP — isi adapter (`src/lib/psp.js`)

Empat fungsi, semua sudah ada bentuk + contoh pseudo (buka komen, padan dengan PSP awak):
- `authorizePayment()` → hold duit customer, pulang `{pspRef, paymentUrl}`
- `capturePayment()` → lepas + split ke sub-merchant partner + platform fee
- `voidPayment()` → refund hold
- `createMerchant()` → cipta payout sub-merchant partner (KYC oleh PSP)

Mod simulasi sekarang buat semua auto-jadi (hold/capture/active) supaya awak boleh test seluruh app sebelum PSP sebenar disambung.

**WAJIB:** sahkan tandatangan webhook ikut skema PSP awak sebelum go-live. Stub guna `sha256(body + PSP_SECRET)`; padan dengan dok PSP, kalau tak orang boleh palsukan event "captured".

---

## 6. Sambung ke app

Selepas Firebase sign-in → simpan `accessToken`. Ganti seed dalam `berespro-app.html`:
- accept bid → `POST /bids/:id/accept` → buka `payment_url` (customer bayar) → app poll `GET /payments/:id` atau tunggu notifikasi sampai `held`
- confirm complete → `POST /jobs/:taskId/confirm` (capture + split berlaku di PSP)
- partner: skrin **"Connect payout"** panggil `POST /partners/connect` (sekali)
- Nilai: app papar RM; hantar cents (RM × 100).

Perubahan UI: skrin "escrow checkout" sekarang sudah **betul** untuk model ni (customer bayar sekali) — cuma tambah skrin **Connect payout** untuk partner, dan tunjuk `payout_status` di profil partner.

---

## 7. Uji

```bash
node test/e2e.mjs   # 17 ujian: connect, authorize, held→accept, capture+split, refund
```

---

## 8. Lapisan perlindungan (baharu)

**Untuk USER:** KYC wajib sebelum partner boleh bid (mereka masuk rumah orang), dispute membekukan duit, refund policy jelas, nombor telefon hanya dikongsi selepas bid diterima.

**Untuk PARTNER:** customer tak boleh batal unilateral bila kerja dah mula (dispute → admin putuskan), badge ID Verified menang lebih banyak job, fee 20% sentiasa dipapar sebelum bid, no-show customer boleh dituntut dengan bukti.

**Untuk BERESPRO:** audit log semua tindakan sensitif (accept/capture/refund/KYC/dispute), rate limiting (auth 10/10min/IP, bids 60/hari, tasks 20/hari, KYC 3/hari), validasi input (had panjang, julat amaun RM10–RM100k), security headers, SQL berparameter, JWT pendek + refresh berputar, dan HANYA rujukan dokumen + 4 digit akhir IC dalam DB (imej KYC dalam bucket R2 privat).

Dokumen penuh: `legal/` — Terms, Privacy (PDPA), Refund & Cancellation, dan `SECURITY.md` (checklist deploy + amalan operasi). **Ketiga-tiga dokumen polisi ialah draf yang perlu semakan peguam Malaysia sebelum diterbitkan.**

## 9. Compliance (jangan skip)

- **Berespro tak pegang dana** — semua authorize/capture/refund oleh PSP. Kekalkan begitu; jangan sesekali settle ke akaun Berespro sendiri kemudian bayar partner (itu jadikan awak pemegang dana → isu BNM).
- **Sahkan tandatangan webhook** sebelum ubah apa-apa status bayaran.
- **Play Financial Features declaration** wajib bila payment live.
- **PDPA** — privacy policy update bila data keluar peranti.
- **Terms** — jelaskan Berespro ialah platform yang menghubungkan; pembayaran diproses & dipegang oleh PSP berlesen; fee platform 20% dipotong masa pelepasan.

---

## 10. Admin Console (dashboard)

Fail: `admin/berespro-admin.html` — buka terus dalam browser (boleh host di Cloudflare Pages atau simpan lokal; JANGAN host public tanpa perlindungan tambahan).

**Cara connect:** (1) dapatkan user id awak via `GET /me`; (2) set `ADMIN_IDS` (wrangler var/secret) kepada id tu; (3) sign in seperti biasa di app, salin `accessToken`; (4) tampal Base URL + token dalam kotak kiri-bawah dashboard → Connect. Butang **Demo** menunjukkan seluruh UI dengan data sampel tanpa backend.

**10 seksyen kawalan:**
| Seksyen | Kawalan |
|---|---|
| Overview | GMV, revenue (selepas voucher), duit dalam escrow, pengguna, tugasan, item perlu perhatian |
| Users | Cari kedua-dua sisi, status verified, **suspend/unsuspend** (blok akses serta-merta) |
| KYC Queue | Lihat dokumen, **approve/reject** dengan sebab |
| Tasks | Semua tugasan ikut status |
| Map | Peta Leaflet sebenar — setiap tugasan sebagai pin berwarna ikut status, popup detail |
| Payments | Semua bayaran; untuk status `held`: butang **Release** (capture + split 80/20) dan **Refund** — dengan nota yang diaudit |
| Disputes | Barisan beku; **Refund customer** atau **Release to partner** |
| Vouchers | Cipta (percent/fixed, min spend, had guna, had per-user), toggle aktif, statistik guna & jumlah discount |
| Algorithm | Slider berat feed (distance/recency/budget) + **commission bps** — semua tunable live |
| Audit Log | Jejak penuh tindakan sensitif |

## 11. Sistem voucher — peraturan duit

Discount **SENTIASA diserap oleh fee platform**, bukan bahagian partner. Contoh: bid RM 170, fee 20% = RM 34, voucher 10% = RM 17 → customer bayar RM 153, partner terima RM 136 (tak berubah), platform terima RM 17. Discount di-cap pada nilai fee — voucher tak boleh buat platform rugi lebih dari fee sendiri. Ini menjadikan pendedahan marketing awak terkawal secara matematik.

## 12. Algoritma feed (tunable)

`GET /tasks?...&sort=recommended` menskor setiap job: `score = wD·closeness + wR·freshness + wB·budget` — closeness (dekat = tinggi), freshness (reput 7 hari), budget (relatif kepada feed). Berat diubah dari dashboard tanpa deploy. Sort `nearest` dan `budget` kekal ada.

## 13. Realistik seminggu

Kod dah siap & lulus ujian. Kerja minggu ni: sambung app + kelayakan akaun. **Bottleneck tunggal = onboarding PSP marketplace** (paling ketat sebab melibatkan pegangan dana). Mula proses tu **hari ini** — sementara tu guna mod simulasi untuk siapkan integrasi app, jadi bila PSP lulus, tinggal isi kunci dan go-live.

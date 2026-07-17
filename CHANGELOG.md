# v23 — audit keselamatan + penstabilan login

Menggantikan v22. Kod app sahaja; backend tak disentuh.

## 1. Login tak stabil — DUA race condition (punca sebenar)

v22 betulkan sign-out yang bersyarat. Itu bug betul, tapi bukan satu-satunya.
Dua lagi race kekal, dan dua-dua ni menerangkan kenapa gejala "kadang boleh,
kadang tak" — bukan gagal setiap kali.

**a) clerkBootstrap berlari serentak.**
Selepas OAuth redirect, ada 7 timer retry (0, 700, 1500, 2800, 4500, 7000,
10000ms) yang panggil clerkBootstrap. Modal sign-in pula ada poll setiap 500ms
yang panggil benda yang sama. Dua panggilan boleh menang serentak -> dua
exchange POST /auth/session selari -> backend pusing refresh token dua kali ->
satu pasangan token yang disimpan dalam localStorage terus mati.
Fix: single-flight guard + berhenti terus bila state.user dah set.

**b) refreshTok berlari serentak.**
liveSync boleh fire 2-3 sync selari (contoh: syncMyTasks + syncNotifs). Bila
access token expired, semua kena 401 serentak, dan setiap satu panggil
refreshTok sendiri dengan refresh token yang SAMA. Yang kedua ditolak sebab
token dah dipusing -> user ter-logout rawak lepas sejam.
Fix: kongsi satu promise refresh yang sedang berjalan.

## 2. Service worker cache respons Clerk

sw.js v22 ada senarai path API untuk skip cache (/auth, /tasks, /me, ...) dan
cache SEMUA GET lain. Itu termasuk skrip SDK Clerk dan panggilan FAPI ke
*.clerk.accounts.dev — sebab tak ada dalam senarai. Auth state basi dihidang
dari cache.

Ini kemungkinan besar sebab badan respons 400 tu "kosong" pada device Zaini:
respons dari cache, bukan dari rangkaian.

Fix: SW sentuh same-origin sahaja (cross-origin terus return, tak sentuh).
index.html jadi network-first supaya deploy baru terus sampai.

## 3. Stored XSS — SERIUS, blocker sebelum pengguna sebenar

Nama partner, nama customer, alamat, tarikh, notifikasi dari server dirender
tanpa escape. Partner boleh set nama profil kepada `<img src=x onerror=...>`.
Bila customer buka senarai bid, skrip jalan dan boleh baca bp.at + bp.rt dari
localStorage -> ambil alih akaun.

Fix: esc() dikuatkan (& < > " '), semua medan asal-server di-escape, avatar
dan initials disanitasi. esc() di tempat cipta notif dibuang (elak
double-escape).

## 4. Popup blocker pada payment

window.open(j.payment_url) dipanggil selepas await. Mobile browser blok ni.
Bila Xendit disambung, page bayaran boleh gagal buka senyap-senyap.
Fix: fallback redirect same-tab. Sama untuk onboarding payout.

## Belum dibaiki (senibina, bukan patch)

- Token dalam localStorage. Lepas XSS ditutup, risiko turun banyak, tapi
  refresh token sepatutnya httpOnly cookie di sisi Worker.
- copyAdminToken salin access|refresh ke clipboard. Jangan guna di komputer
  kongsi.

## Ujian

1. Sign in -> log out -> sign in semula, ulang 3-4 kali laju-laju.
2. Buka 2 tab, biar sejam (token expired), refresh dua-dua. Dua-dua patut
   pulih tanpa logout.
3. Selepas deploy, refresh sekali. Versi baru patut terus naik.

---

# v24 — butang batal dalam UI

Backend dah ada 4 aliran pembatalan sejak lama. Frontend tak pernah panggil satu
pun, jadi pengguna tak boleh batal apa-apa. Sekarang boleh.

## Empat aliran, empat tempat, empat amaran berbeza

| Siapa | Bila | Butang | Kesan |
|---|---|---|---|
| Customer | Task masih terbuka | "Cancel this task" (skrin task) | Bid ditutup, pembida dimaklum. Tiada duit terlibat. |
| Customer | Kerja sedang jalan | "Cancel this job & get refunded" | Hold dikembalikan penuh. |
| Partner | Bid belum dijawab | "Withdraw my bid" (skrin job) | Bebas. BUKAN strike. |
| Partner | Kerja yang dimenangi | "Cancel this job" | Customer refund penuh, task dibuka semula. INI strike. |

Amaran sengaja ditulis berbeza mengikut kos sebenar. Tarik bid yang belum
dijawab tak merugikan sesiapa, jadi amarannya ringan. Partner batal kerja yang
dah dimenangi merugikan customer, jadi amarannya keras dan sebab WAJIB diisi.

## Kod ralat backend dikendalikan, bukan dibuang jadi mesej mentah

- `not_open` (409) -> "Too late, this task is no longer open"
- `bid_settled` (409) -> "This bid was already accepted or declined"
- `dispute_open` (409) -> "Cannot cancel while a dispute is open"

Ini penting sebab race sebenar: customer accept bid pada saat partner tekan
withdraw. Backend menang, frontend terangkan kenapa.

## Dua pembetulan sekali gus

1. `statusChip` tak pernah tahu status `cancelled`. Backend memang set status
   tu (dah lama), jadi mana-mana task yang dibatalkan akan render chip
   `undefined`. Sekarang ada chip Cancelled + fallback untuk status yang tak
   dikenali.
2. `liveWithdrawBid` guna **bid id**, bukan task id. Route dia
   `DELETE /bids/:id`, bukan `/tasks/:id`. Senang tersalah.

## Belum ada

Butang decline bid untuk customer masih `toast('Bid declined')` palsu. Route
`POST /bids/:id/decline` wujud dan siap. Tak disambung dalam v24 sebab bukan
sebahagian permintaan batal. Kerja kecil bila nak.


---

# v25 — polisi batal yang adil, komisen fleksibel, audit skalabiliti

Backend + app + control panel. Ujian: 211 lulus, 0 gagal (165 sedia ada +
30 baru dalam test/cancelfee.mjs + 16 integrasi).

## 1. Customer batal kerja tengah jalan: partner kini dilindungi

Dulu: refund penuh bila-bila masa. Semua kos ditanggung partner (slot
ditempah, kerja lain ditolak, mungkin dah bergerak).

Sekarang, polisi dua peringkat (kedua-dua boleh dilaras admin):

- Dalam GRACE WINDOW selepas bayaran ditahan (default 60 minit): batal
  percuma, refund penuh. Partner belum melabur apa-apa.
- Selepas grace: CANCEL FEE (default 10% harga dipersetujui) di-capture
  dari hold dan dibayar kepada partner sebagai pampasan. Komisen platform
  dikenakan atas fee tu macam bayaran biasa (partner dapat bahagian dia).
  Baki hold direfund kepada customer.

Mekanik: PARTIAL CAPTURE. Kad benarkan capture kurang dari jumlah
authorized; baki dilepaskan PSP. Jumlah asal disimpan dalam kolum baru
original_amount_cents untuk audit. Set cancel_fee_bps=0 di control panel
untuk kembali kepada tingkah laku lama.

App: dialog confirm terangkan polisi sebenar (grace + %), toast selepas
batal tunjuk pecahan sebenar dari server.

## 2. Komisen boleh diubah per-partner dan per-kategori

Resolusi, paling spesifik menang: partner override > kategori override >
default. Disimpan dalam jadual settings sedia ada sebagai
commission_partner_<userId> dan commission_cat_<category>, jadi audit
trail sedia ada meliputinya.

- Control panel: seksyen "Commission overrides" baru. Tambah, lihat,
  buang. Slider untuk cancel fee dan grace window sekali.
- Guard: override untuk partner yang tak wujud ditolak 404, atas 50%
  ditolak 400, bukan admin 403.
- App: nota "You'll receive X after the Y% platform fee" kini guna kadar
  sebenar dari server (/me pulangkan commission_bps efektif), bukan 20%
  hard-code.

PERINGATAN XENDIT: split rule statik (XENDIT_SPLIT_RULE_ID) hanya betul
untuk kadar default. Bila komisen berbeza-beza, split kena per-request.
Dalam simulasi semuanya betul; sebelum production dengan override aktif,
sahkan dengan Xendit cara pass split params per payment request.

## 3. Audit skalabiliti: apa yang dijumpai dan dibaiki

DIBAIKI:
- N+1 dalam feed partner: 3 query PER TASK (bid count, my bid, nama
  customer) = 75 round-trip D1 sequential untuk feed 25 task. Kini 3
  query JUMLAH, tak kira saiz feed. Ini isu latency terbesar yang wujud.
- Settings dibaca 2-3 kali per request selepas perubahan ni. Micro-cache
  10 saat per isolate, invalidate serta-merta bila admin PATCH.
- MockDB regression baru DIELAK: UPDATE dengan rujukan kolum
  (SET a=b) senyap diabaikan MockDB. Ditulis semula dengan nilai bound.
  Pelajaran #1 handoff hampir berulang, ujian yang tangkap.

DISAHKAN SIHAT (tak perlu ubah):
- Index: payments(task_id/status/psp_ref/card_fp), tasks(status,lat,lng)
  bounding-box, cancellations(user_id,created_at). Semua query panas ada
  index.
- Bounding-box prefilter SQL + haversine JS + hard cap fan-out: betul.
- Pagination: notifications LIMIT 100, payouts LIMIT 100, audit cap 500.
- Rate limit pada bids (harian) dan auth.

TIDAK DIBAIKI, catat sahaja:
- Notifikasi kepada pembida dalam cancelOpenTask ialah loop INSERT
  sequential. OK sekarang (bid per task kecil), jadi masalah kalau satu
  task ada ratusan bid. D1 batch() boleh guna nanti.
- getSettings cache per-isolate: instance Worker lain nampak perubahan
  admin selepas maksimum 10 saat. Boleh diterima untuk tetapan komisen.

## SELEPAS UPLOAD KE GIT (auto-deploy):

1. WAJIB run /setup sekali (URL dalam nota rahsia awak) untuk apply
   ALTER TABLE original_amount_cents. Idempotent, selamat.
2. Deploy app v25 ke Netlify, unregister SW lama, hard refresh.
3. Control panel: buka tab Algorithm, sahkan slider cancel fee muncul.


---

# v26 — audit adversarial penuh: 247 ujian, 2 bug duit dibaiki

Suite baru test/edgecases.mjs: 36 ujian yang CUBA pecahkan sistem, bukan
happy path. Setiap perlumbaan keadaan yang boleh dicapai, terutamanya yang
gerakkan duit. Jumlah keseluruhan kini 247 lulus, 0 gagal.

## Bug yang dijumpai audit dan dibaiki

1. VOUCHER + CANCEL FEE (bug duit sebenar, serius):
   Customer guna voucher 50% pada kerja RM100 -> bayar RM80. Batal selepas
   grace: kod lama lapor "refund RM90" — LEBIH dari yang dia pernah bayar.
   Dengan diskaun besar, capture pampasan pun boleh gagal di PSP sebab
   melebihi jumlah authorized. Fix: semua nombor menghadap customer dan cap
   capture dikira dari jumlah SEBENAR dibayar (gross - diskaun). Pampasan
   partner kekal % harga dipersetujui (kerugian partner tak mengecil sebab
   platform bagi diskaun), tapi tak boleh melebihi duit yang ditahan.

2. Guard compensatePartnerOnCancel dibetulkan sama: had lawan jumlah
   dibayar, bukan gross.

## Yang audit SAHKAN kukuh (tiada perubahan perlu)

- Double-accept: dua bid boleh diaccept serentak (task masih open), TAPI
  webhook kedua auto-void hold kedua sebab task dah inprogress. Duit
  selamat. By design.
- Accept -> customer batal SEMASA page bayaran terbuka -> webhook sampai
  lewat: hold auto-refund, task kekal cancelled, tak "hidup semula".
- Double-confirm ditolak (tiada double capture). Batal selepas siap
  ditolak. Partner-cancel selepas confirm ditolak (duit dah bergerak).
- Withdraw selepas bid diterima ditolak (bid_settled).
- Dispute terbuka kunci SEMUA laluan duit: confirm, dua-dua jenis batal,
  dan admin release. Resolve dua kali ditolak. Refund berlaku tepat sekali.
- Suspended user hilang semua akses (ujian pertama saya silap nama field,
  kod memang betul: body {suspend:true}).
- Input abuse: title 5000 aksara, budget negatif, latitude 999, bid
  pecahan sen, token sampah — semua ditolak dengan status betul.

## Nota untuk control panel

Route suspend guna body {suspend:true/false}, bukan {suspended:...}.


---

# v27 — hutang teknikal dibersihkan

Tiada feature baru. Tiga hutang yang dikenal pasti audit maintainability,
semuanya diselesaikan:

## 1. Fail duplicate DIBUANG

app/berespro-app.html (salinan satu-fail yang disync tangan dengan
index.html) dipadam. Dua salinan kod sama = drift senyap menunggu masa.
Ujian integrasi kini membaca app/index.html terus, jadi TIADA fungsi
hilang, cuma satu sumber kebenaran.

PENTING: upload GitHub tak memadam fail. Selepas upload v27, padam
app/berespro-app.html secara manual: buka fail -> ikon tong sampah ->
commit.

## 2. CI: ujian jalan sendiri pada setiap push

- .github/workflows/test.yml: GitHub Actions, Node 22, sifar dependency
  (suite guna MockDB, tiada npm install).
- test/run-all.mjs: jalankan semua suite, berhenti pada kegagalan
  pertama, exit code betul.
- package.json: npm test + "type":"module" (buang amaran ESM Node).

Selepas ni: setiap commit ke main dapat tick hijau atau pangkah merah di
GitHub. Merah = JANGAN deploy. Ini menggantikan "saya yang jalankan
ujian" dengan "repo yang jalankan ujian".

## 3. Path absolute dalam ujian dibuang

test/app-integration.mjs ada import /home/claude/... yang hanya jalan
pada mesin tertentu. Semua kini relative (import.meta.url), jalan dari
mana-mana cwd termasuk CI.

## Disahkan semasa pembersihan

- Sifar TODO/FIXME/HACK tertinggal dalam src, test, app, admin.
- Sifar rujukan kepada fail yang dipadam.
- Keseluruhan 247 ujian dijalankan DARI layout repo (persis apa CI
  nampak): semua lulus.


---

# v28 — audit keselamatan siber: 1 bug KRITIKAL + 5 pengukuhan

Suite baru test/security.mjs: 29 ujian, setiap satu percubaan EKSPLOIT
sebenar terhadap Worker. Jumlah kini 276 ujian, 0 gagal.

## KRITIKAL — JWT algorithm confusion (pintu depan Clerk)

verifyClerkToken tak pernah semak header.alg. Penyerang boleh:
- hantar token alg:none (tiada signature) -> lepas
- hantar token alg:HS256 guna kunci AWAM RSA Clerk sebagai rahsia HMAC
  -> lepas
Kedua-dua = login sebagai SESIAPA (mana-mana `sub`), tanpa kredential.
Ini bypass auth penuh. FIX: alg dipin ke RS256; apa-apa lain ditolak
terus.

Bonus dua lagi dalam laluan sama:
- kid fallback: kod ambil keys[0] kalau kid tak padan. Forged kid boleh
  arah ke kunci lain. FIX: kid mesti padan tepat, tiada fallback.
- JWKS poisoning: fetch tak semak status. FIX: mesti https + 200 + keys
  tak kosong, dan kegagalan fail-closed (tolak token, bukan 500).

## Pengukuhan lain

1. Session JWT compare non-constant-time (timing side-channel pada
   signature kita sendiri). FIX: compare masa-tetap.
2. Internal error bocor mesej pengecualian ke client (boleh dedah nama
   jadual, SQL, hint config). FIX: log server-side dengan ref id, client
   dapat "internal error (ref xxxxxxxx)" sahaja.
3. Tiada security header. FIX ditambah ke setiap respons:
   Strict-Transport-Security, X-Frame-Options: DENY,
   Content-Security-Policy (default-src none, API JSON sahaja),
   X-Content-Type-Options: nosniff.

## Disahkan KUKUH oleh ujian eksploit (tiada perubahan perlu)

- Session JWT: payload diusik ditolak, kunci salah ditolak, expired
  ditolak.
- Privilege escalation: bukan admin diblok dari SEMUA 5 /admin/* +
  tukar komisen + suspend + grant badge.
- IDOR: penyerang tak boleh baca payment orang lain; pemilik boleh.
- Webhook forgery: tiada token / token salah ditolak 401; hanya token
  betul gerakkan duit (constant-time compare, sedia ada).
- Dev backdoors (dev-login, simulate-pay): 404 bila DEV_LOGIN tak diset.
- SQL injection: sifar. Semua query guna ?-bind; satu-satunya concat
  (LIMIT) ialah integer parseInt+Math.min.
- PII: profil partner awam tak dedah phone/email.

## Cloudflare (peringatan, bukan kod)

- CLERK_ISSUER WAJIB diset di Runtime — ia yang menguatkuasakan semakan
  issuer DAN sumber URL JWKS. Tanpa dia, token tak boleh disahkan
  (fail-closed, jadi selamat tapi login mati).
- Pastikan DEV_LOGIN TIADA di production (sudah disahkan tiada).
- Pusing SETUP_KEY dan JWT_SECRET sebelum pengguna sebenar (dua-dua
  pernah dalam fail handoff plaintext).


---

# v29 — pengukuhan untuk 5000+ user dan trafik tinggi

Suite baru test/scale.mjs: 9 ujian yang seed 5000 partner dan BUKTIKAN
laluan panas buat kerja TERHAD, bukan kerja yang membesar ikut bilangan
user. Jumlah kini 285 ujian, 0 gagal.

## Realiti skala (penting difahami)

5000 user BUKAN "trafik tinggi" untuk Cloudflare Workers. Worker
auto-scale di edge tanpa awak buat apa-apa. Bottleneck pada skala ni
SENTIASA D1 (database), bukan Worker. Jadi semua fix ni tentang kurangkan
dan percepatkan sentuhan D1.

## Yang dibaiki

1. RATE LIMITER guna D1 = bottleneck sendiri. Setiap permintaan yang
   kena rate-limit buat 2 tulisan D1. Ditulis semula guna KV (env.RL_KV),
   yang memang dibina untuk counter edge laju. Fallback ke D1 automatik
   kalau KV belum bound, jadi tiada apa pecah sebelum awak cipta
   namespace. Ujian buktikan laluan KV sentuh D1 SIFAR kali.

2. NOTIFIKASI ke partner berdekatan (bila task baru dipost) ialah loop
   INSERT sequential: sehingga 50 partner x 2 tulisan D1 berturut-turut,
   dan customer TUNGGU semua sebelum dapat respons. Ditukar ke SATU
   env.DB.batch() untuk semua notif in-app; push jadi fire-and-forget.
   Ujian dengan 5000 partner buktikan: 1 batch, dihadkan 50, bukan 5000.

3. INDEX baru untuk dua scan terpanas pada skala:
   - users(mode,suspended,lat,lng): scan partner berdekatan. Tanpa dia,
     setiap task baru buat full table scan users.
   - bids(partner_id,task_id): semakan "my_bid" dalam feed.

## Disahkan KUKUH oleh ujian skala

- Feed partner: O(1) query tak kira saiz feed (5 query untuk 10 task,
  bukan 3-per-task macam sebelum N+1 fix v25). Buktikan.
- Fanout notif: 1 batch, dihad 50.
- Rate limiter KV: kuatkuasa had, sentuh D1 sifar; fallback D1 juga
  kuatkuasa.

## LANGKAH AWAK di Cloudflare (untuk aktifkan laluan KV)

Sistem jalan betul TANPA ini (fallback D1). Buat bila nak trafik tinggi:
1. Dashboard > Storage & Databases > KV > Create namespace (nama apa saja)
2. Salin id namespace tu
3. Dalam wrangler.toml, buang komen pada blok [[kv_namespaces]], paste id
4. Commit. Auto-deploy. Rate limiter terus guna KV.

## MockDB (nota teknikal)

Tiga bug shim dibaiki sepanjang kerja ni, semua kes di mana MockDB
menipu (lulus ujian sementara kod production berbeza) — pelajaran #1
handoff:
- bind() dulu mutate + pulang `this`; kini pulang statement baru (macam
  D1), supaya batch statement dikongsi tak collapse.
- UPDATE col=col+N (cth rate limit count) dulu diabai senyap; kini
  disokong.
- UPDATE COALESCE(?,col) (webhook merge) dulu pecah pada koma dalam
  kurungan; kini split top-level sahaja + dikendali betul.


---

# v30 — kawalan liputan: buka/tutup negeri dan daerah dari control panel

Suite baru test/coverage.mjs: 33 ujian. Jumlah kini 318 lulus, 0 gagal.

## POSKOD: kenapa TIDAK, dan apa yang dibuat sebaliknya

Zaini minta kawalan tahap bandar/poskod. Poskod tak boleh jadi kunci:
app LANGSUNG tak kumpul poskod (borang ada city + alamat + pin sahaja),
dan Malaysia ada 2,700+ poskod — mustahil nak hard-code tepat, dan takkan
ada sesiapa toggle 2,700 suis. Yang app ADA ialah pin lat/lng sebenar
dari peta, dan itu LEBIH BAIK dari poskod.

Jadi: kawalan NEGERI + DAERAH, dan daerah di-resolve automatik dari pin.
121 daerah, 13 negeri + 3 wilayah persekutuan, hard-code dalam
src/lib/geo.js.

## Reka bentuk

- DEFAULT SEMUA TERBUKA. Deploy v30 tak ubah apa-apa. Hanya PENGECUALIAN
  disimpan dalam jadual coverage (scope + active). Tiada seeding, tiada
  migrasi bila daerah baru ditambah, jadual kekal kecil.
- Resolusi "paling spesifik menang" (sama macam komisen): baris daerah >
  baris negeri > default TERBUKA. Jadi boleh tutup satu negeri penuh TAPI
  buka semula satu daerah di dalamnya.
- KERJA SEDANG JALAN TAK PERNAH DISENTUH (permintaan Zaini). Tutup kawasan
  = blok task BARU sahaja. Job inprogress boleh mark complete, customer
  boleh confirm, duit tetap capture normal. Ada ujian khusus untuk ni.
- Pin di luar Malaysia (>150km dari mana-mana pusat daerah) ditolak, jadi
  pin rosak tak resolve senyap ke daerah rawak.
- Daerah yang resolve direkod pada task (kolum state + district) supaya
  laporan admin tak perlu resolve semula, dan tukar centroid kemudian tak
  boleh tulis semula sejarah.

## Kenapa centroid, bukan sempadan sebenar

Poligon daerah sebenar = megabait GeoJSON dalam bundle Worker + ujian
point-in-polygon setiap permintaan. Untuk peraturan on/off, nearest-centroid
cukup tepat: hanya silap untuk pin betul-betul di antara dua pusat daerah,
dan biasanya kedua-duanya sama-sama buka atau sama-sama tutup.
JANGAN guna semula untuk cukai/bidang kuasa/harga — tak cukup tepat.
Kalau satu daerah resolve salah, betulkan lat/lng dia dalam geo.js sahaja.

## Control panel

Tab COVERAGE baru: senarai 16 negeri, setiap satu boleh kembang ke daerah.
Setiap baris tunjuk Open/Closed, bilangan task LIVE di situ (supaya awak
nampak kesan sebelum tutup), dan tanda "override" bila ada pengecualian
eksplisit. Butang Reset buang pengecualian (balik ke default).
Tutup kawasan minta pengesahan yang terangkan: task baru diblok, kerja
sedang jalan teruskan.

## App

Customer yang cuba post di kawasan tertutup dapat mesej jelas yang namakan
tempat tu + peringatan yang pin (bukan dropdown city) yang menentukan
kawasan.

## SELEPAS UPLOAD

WAJIB run /setup sekali: cipta jadual coverage + kolum tasks.state/district.
Tanpa dia, post task akan gagal.

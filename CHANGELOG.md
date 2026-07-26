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


---

# v31 — CHAT: customer dan partner boleh berkomunikasi dalam app

Suite baru test/messages.mjs: 36 ujian. Jumlah kini 354 lulus, 0 gagal.
5 route baru (jumlah 60).

## Kenapa ini penting (bukan sekadar feature)

Sebelum ni butang "Chat" cuma toast palsu. Tanpa mesej, partner yang nak
tanya "pintu belakang ada akses?" TERPAKSA tukar nombor telefon, dan saat
mereka buat tu, kerja tu KELUAR dari platform: mereka settle sendiri,
Berespro hilang komisen DAN hilang rekod untuk dispute. Chat kekalkan
perbualan di tempat yang ada escrow, audit trail, dan bukti dispute.

## Reka bentuk

THREAD = (task_id, partner_id). Satu task terbuka boleh ada 5 partner
bida, jadi customer dapat 5 thread berasingan; setiap partner nampak
thread dia SAHAJA. Partner tak boleh nampak harga atau mesej partner lain.

ANTI-SPAM: partner mesti BIDA dahulu sebelum boleh mesej. Kalau tidak,
mana-mana partner boleh spam mana-mana customer. Medan mesej dalam bid
sudah jadi tempat perkenalan.

POLLING, bukan WebSocket: realtime sebenar perlukan Durable Objects (kos +
kompleksiti). Polling 4 saat SEMASA skrin chat terbuka sahaja, berhenti
sebaik keluar skrin. Untuk thread dua orang, ini satu bacaan kecil setiap
beberapa saat dan sifar infrastruktur tambahan.

CHAT KEKAL TERBUKA semasa dispute — waktu itulah mereka paling perlu
bercakap. Ada ujian khusus.

ADMIN BOLEH BACA thread sebagai bukti dispute (/admin/threads/:taskId),
tapi READ-ONLY. Admin tak boleh menulis, jadi thread sentiasa boleh
dipercayai sebagai rekod apa yang dua pihak betul-betul cakap.

## Bug yang ditangkap semasa membina

1. POLL BOLEH HILANGKAN MESEJ: `created_at > after` menggugurkan mesej yang
   ditulis dalam SAAT YANG SAMA dengan mesej terakhir klien. Dua orang
   menaip serentak bukan perkara jarang. Ditukar ke >= dan klien de-dupe
   ikut id: paling teruk ia ambil semula satu mesej yang dia dah ada
   (tak nampak), berbanding alternatifnya yang HILANGKAN mesej.
2. Query "last message" padan ikut created_at sahaja boleh ambil mesej
   dari thread LAIN yang sama saat. Diskop ikut thread.
3. Text input dikembalikan kalau hantar gagal — jangan sesekali hilangkan
   apa yang orang dah taip.

## MockDB (pelajaran #1 lagi, tiga kali dalam satu sesi)

Shim tak sokong: GROUP BY dengan JOIN, OR dalam WHERE, dan ia ABAIKAN
penapis pada jadual yang di-JOIN (t.customer_id) — senyap, pulang kosong.
listThreads ditulis semula tanpa JOIN/OR/GROUP BY: dua lookup berindeks
rata + stitch dalam JS. Ini BUKAN kompromi untuk shim — SQLite selalunya
BUANG index bila WHERE ada OR merentas dua jadual, jadi bentuk ni memang
lebih laju pada D1 sebenar.

## App

- Skrin senarai thread + skrin chat (bubble, timestamp, auto-scroll)
- 3 butang palsu disambung: customer→bidder, customer→partner (job aktif),
  partner→customer ("Ask")
- Pintu masuk: Profile → Messages (kedua-dua mod) + kad dalam Activity,
  dengan badge unread
- Notifikasi jenis "msg" baru

## SELEPAS UPLOAD

WAJIB run /setup sekali: cipta jadual messages + 2 index.


---

# v32 — KYC SEBENAR: dokumen ke R2 peribadi, bukan lagi teater

Suite baru test/kycdocs.mjs: 32 ujian. Jumlah kini 386 lulus, 0 gagal.
2 route baru (jumlah 62).

## APA YANG SEBENARNYA BERLAKU SEBELUM NI (teruk)

KYC awak PALSU sepenuhnya:
- App cipta string "upload://1784...-ic.jpg" dan hantar sebagai "URL"
- GAMBAR SEBENAR TAK PERGI KE MANA-MANA — duduk dalam browser, hilang
- /kyc/submit terima APA-APA string sebagai doc_front_url. Partner boleh
  hantar doc_front_url:"haha" dan masuk queue
- Admin nampak link rosak. Pilihan dia: LULUS MEMBUTA atau tolak semua
- REQUIRE_KYC_TO_BID=1, jadi setiap partner tersekat di gate palsu ni

Lulus membuta LEBIH BAHAYA dari tiada KYC: awak dapat rekod bertulis yang
awak "sahkan" seseorang yang awak tak pernah sahkan. Itu liabiliti.

## MODEL ANCAMAN (gambar IC + selfie = data paling sensitif di platform)

1. Bucket PERIBADI. Tiada URL awam kepada dokumen wujud, langsung.
2. KLIEN TAK PERNAH PILIH KUNCI. Ia hantar bait; Worker tentukan kunci,
   nama, dan lokasi. Kunci: kyc/<userId>/<random>-<kind>.
3. Admin baca dokumen MELALUI Worker, yang semak admin pada SETIAP
   permintaan. Tiada signed URL yang boleh diforward atau hidup lebih lama
   dari review.
4. Kandungan disahkan ikut MAGIC BYTES, bukan header Content-Type yang
   mana-mana klien boleh tipu. JPEG/PNG/WebP sahaja, maks 6MB.
5. Awak hanya boleh submit dokumen yang AWAK upload (kunci mesti bawah
   prefix awak DAN wujud dalam storan). Tanpa ni, partner boleh tuntut
   dokumen orang lain, atau reka string dan "disahkan" tanpa upload apa-apa.
6. Kunci dokumen TAK PERNAH masuk audit log — audit dibaca ramai admin,
   dan kunci itu satu-satunya yang menjaga storan.

## STORAN TIADA = MENOLAK, BUKAN BERPURA-PURA

Kalau KYC_DOCS tak bound, /kyc/upload dan /kyc/submit pulang 503. Kod lama
berpura-pura berjaya. Ada ujian khusus untuk ni.

## Admin panel

Link "#" palsu diganti pemapar sebenar. <img src> TAK BOLEH hantar header
Authorization, jadi panel fetch dengan token, tukar jadi blob, papar dari
memori, dan revoke object URL bila ditutup. Tiada apa ditulis ke cache atau
disk. Setiap view masuk audit log.

## Retensi (keputusan Zaini)

Dokumen disimpan SELAGI PARTNER AKTIF. Set yang DITOLAK dipadam bila
partner submit semula — set ditolak bukan sebahagian dari retensi.

## HAD YANG DIAKUI (tak disembunyikan)

EXIF TAK dibuang. Gambar boleh bawa koordinat GPS tempat ia diambil.
Membuang EXIF perlukan decoder imej, berat dalam Worker. Bucket peribadi
dan hanya admin boleh baca, jadi pendedahan bersifat dalaman. Semak semula
kalau dokumen pernah dikendali sesiapa di luar syarikat.

## LANGKAH AWAK DI CLOUDFLARE (WAJIB, kalau tidak KYC pulang 503)

1. Dashboard > R2 Object Storage > Create bucket
2. Nama: berespro-kyc
3. JANGAN sesekali enable Public Access pada bucket ni
4. Dalam wrangler.toml, buang komen pada blok [[r2_buckets]]
5. Commit. Auto-deploy.

R2 percuma sehingga 10GB. Gambar IC ~1MB, jadi 10GB = ~10,000 dokumen.


---

# v33 — TUTUP AKAUN: deactivate + delete (compliance PDPA)

Suite baru test/account.mjs: 38 ujian. Jumlah kini 424 lulus, 0 gagal.
4 route baru (jumlah 66).

## RESET / FORGOT PASSWORD: tiada, dan itu BETUL

Berespro LANGSUNG tiada password. Sifar. Tiada disimpan, tiada disemak.
Auth ialah Clerk + Google. Lupa password Google = masalah Google. Kalau
email+password dihidupkan dalam Clerk nanti, Clerk yang handle reset,
ada UI siap. JANGAN sesekali bina sendiri — password ialah punca kebocoran
paling biasa, dan awak tak simpan satu pun.

## KENAPA INI BUKAN "DELETE FROM users"

Ini marketplace pegang duit:
- partner boleh ada RM800 dalam escrow untuk kerja belum siap
- customer boleh ada dispute terbuka
- baris payment ialah rekod PERAKAUNAN (Malaysia: simpan 7 tahun)
- review yang dia tulis ialah reputasi ORANG LAIN

Jadi dua peringkat, dan KEDUA-DUA DITOLAK selagi ada duit atau dispute
hidup — kalau tidak, "padam akaun" jadi jalan lari dari dispute. Ada ujian
khusus: customer DAN partner dua-dua tak boleh padam masa dispute terbuka.

  DEACTIVATE  boleh pulih. Hilang dari feed, tak boleh bida/post/mesej,
              sesi dibunuh. TIADA apa dimusnahkan.
  DELETE      kekal. Identiti dianonimkan, gambar IC DIPADAM dari R2.
              Baris kewangan kekal, menunjuk kepada pengguna tanpa nama.

## GATE: DEFAULT TOLAK, BUKAN TAMPAL SEMAKAN

Akaun deactivated diblok di peringkat ROUTER dengan allowlist, bukan
semakan dalam setiap route. Sebabnya: hari seseorang tambah route baru dan
terlupa semakan, pengguna deactivated boleh bida semula secara senyap.
Allowlist gagal SELAMAT — route baru diblok sampai seseorang sengaja buka.
Dibenarkan masa deactivated: GET /me, closure-check, reactivate, DELETE
/account, auth/session, auth/refresh. Semua lain 403.

## DEACTIVATE BEBASKAN ORANG LAIN

Task terbuka awak dibatalkan dan setiap pembida DIBERITAHU. Bid pending
awak ditarik. Kalau tidak, partner tunggu selama-lamanya pada task yang
tuannya dah pergi.

## DELETE: apa yang pergi, apa yang kekal

PERGI: nama, telefon, emel, lokasi, skills, id_verified, GAMBAR IC DARI R2,
        nama + IC last4 dalam baris kyc, sesi, token push.
KEKAL: baris payment (perakaunan), task, bid, review, mesej — semua kini
       menunjuk kepada "Deleted user".
firebase_uid dikosongkan, jadi sign-in Google yang sama cipta akaun BARU,
bukan hidupkan semula yang ini.

## Sengaja menyusahkan

Delete perlukan confirm:"DELETE" tepat (huruf besar). App minta pengesahan
DUA kali dan yang kedua kena taip perkataan tu. Ini tindakan tak boleh
undur — ia tak patut boleh dicapai dengan tersalah tekan.

## Bug yang ujian tangkap

"IC DOCUMENTS PURGED FROM STORAGE" GAGAL pada mulanya — dokumen terselamat
dari padam akaun. Itu tepat kegagalan compliance yang suite ni wujud untuk
halang. (Punca: ujian saya seed partner dengan id_verified=1, jadi
submitKyc pulang awal dan tiada baris KYC pernah wujud untuk dipadam.)

## SELEPAS UPLOAD

WAJIB run /setup: kolum users.deactivated_at + users.deleted_at.


---

# v34 — UI claymorphism

Rupa sahaja. SIFAR perubahan logik. 424 ujian masih lulus (kod backend tak
disentuh). Diesahkan dengan render sebenar (Playwright screenshot) pada
skrin home, post, profile, dan partner jobs — bukan diteka.

## Apa itu claymorph

Bentuk lembut menggelembung: radius besar, bayang LUARAN dua arah (cahaya
atas-kiri, gelap bawah-kanan) yang buat elemen nampak ditimbulkan dari
tanah liat, plus rim dalaman halus. Elemen "ditekan" (input, carian) guna
bayang INSET supaya nampak macam ditenggelamkan.

## Cara ia dibuat tanpa sentuh markup

Sistem gaya app dah berpusat: semua guna .card / .btn / .chip / .cat /
.srow / token warna :root. Jadi claymorph diterap dengan tukar DEFINISI
kelas tu sahaja — tiada satu baris markup atau logik berubah. Kalau nak
patah balik, ia perubahan CSS terpencil.

## Perubahan

- Token: permukaan dibuat sedikit berwarna (bukan putih tulen) supaya
  bayang clay nampak; tambah --clay, --clay-sm, --clay-in, --clay-blu.
- Radius dibesarkan (16->22px) untuk rupa pillowy.
- Timbul (raised): card, chip, cat tile, filter chip, avatar, alert
  banner, escrow strip, butang, bottom-nav post button.
- Tenggelam (inset): input, textarea, OTP box, search bar, settings-row
  icon, ghost button.
- Butang primary + post + filter-on: gradient biru dengan bayang biru.
- :active pada butang/tile: tekan ke dalam (inset) untuk maklum balas
  sentuh.

## Kebolehbacaan

Bayang ditala LEMBUT dengan sengaja — claymorph yang berlebihan jadi kabur.
Teks kekal tajam, kontras dikekalkan. Disahkan pada screenshot sebenar.


---

# v35 — AUDIT PRODUCTION: bug schema drift dibaiki (KRITIKAL)

Audit kesediaan production sebelum bungkus APK. Satu bug production sebenar
dijumpai dan dibaiki; selebihnya konfigurasi, bukan kod.

## KRITIKAL — schema_sql.js drift dari schema.sql

/setup guna src/schema_sql.js (schema.sql dibungkus JS). Fail tu sepatutnya
auto-jana dari schema.sql tapi dikemas kini secara MANUAL, dan dah drift:
ia HILANG jadual `coverage` (v30) dan `messages` (v31).

Kesan kalau tak dibaiki: awak upload v31-v33, run /setup, dan jadual chat +
coverage TAK dicipta. Chat dan coverage pecah di production dengan "no such
table" — sementara SEMUA 424 ujian lulus, sebab ujian guna MockDB yang cipta
jadual sendiri, bukan /setup.

Ini tepat kelas bug yang hanya muncul di production sebenar. Dibaiki:
- schema_sql.js dijana semula dari schema.sql (kini ada semua 20 jadual)
- test/gen-schema.mjs: skrip jana rasmi (npm run gen:schema)
- test/schema-sync.mjs: GUARD yang gagal CI kalau dua fail tak selari lagi.
  Drift ni tak boleh berlaku senyap lagi.

## Disahkan SELAMAT untuk production (tiada perubahan perlu)

- Backdoor dev (dev-login, simulate-pay) fail-closed: 404 bila DEV_LOGIN
  tak diset. Butang DEV dalam app dipagar oleh LIVE().
- Tiada rahsia hard-code dalam src/ atau app (JWT_SECRET, SETUP_KEY,
  XENDIT keys semua dari env).
- Security headers, JWT alg-pin, IDOR guards, dispute locks — semua kekal.

## KONFIGURASI PRODUCTION (bukan kod — LANGKAH AWAK sebelum go-live)

Ini yang bezakan "berjalan" dari "production". Semua di app baris 14-21 +
Cloudflare:

1. Clerk: tukar pk_test_ (dev good-penguin-19) -> pk_live_ dari Clerk
   PRODUCTION instance. Buat production instance di Clerk dulu.
2. CLERK_ISSUER di Cloudflare: good-penguin-19.clerk.accounts.dev ->
   https://clerk.berespro.my (production instance).
3. Google OAuth: production instance perlu OAuth credentials sendiri
   (projek "Berespro" dah dicipta; sambungkan di Clerk).
4. Domain: app kena di berespro.my, bukan URL netlify rawak, untuk APK
   production yang bermakna.
5. R2 bucket berespro-kyc + KV RL_KV (uncomment wrangler.toml).
6. XENDIT_SECRET_KEY + CALLBACK_TOKEN bila sedia terima duit.
7. Pusing SETUP_KEY + JWT_SECRET (pernah dalam fail plaintext).


---

# v36 — alat untuk tukar ke production dengan selamat

Suite baru test/prodconfig.mjs: 22 ujian. Jumlah 474 lulus, 0 gagal.

## Masalah yang ini selesaikan

Tukar ke production bukan satu suis. EMPAT benda kena sejajar SERENTAK:
kunci pk_live_ dalam app, CLERK_ISSUER di Cloudflare, Google OAuth
credentials dalam Clerk, dan JWT template "berespro" di production instance.
Kalau SATU salah, semua orang dapat "invalid clerk token" 401 — mesej sama
untuk semua punca. Dari laptop browser-only, itu boleh jadi sejam meneka.

## 1. GET /health/config?key=<SETUP_KEY>

Satu URL, jawapan penuh: apa yang dikonfigur, apa yang belum, dan sama ada
awak production-ready. Melaporkan STATUS, tidak pernah nilai rahsia (ada
ujian khusus yang sahkan JWT_SECRET dan SETUP_KEY tak bocor).

Contoh jawapan bila belum sedia:
  production_ready: false
  blockers: ["CLERK_ISSUER is a Clerk DEV instance, not production",
             "DEV_LOGIN is ON — dev backdoors are reachable",
             "ADMIN_IDS not set — control panel is locked",
             "R2 bucket KYC_DOCS not bound — KYC returns 503",
             "XENDIT_SECRET_KEY not set — payments are SIMULATED"]

Dipagar SETUP_KEY, jadi tidak awam.

## 2. Kod ralat yang menamakan punca sebenar

/auth/session kini bezakan:
  issuer_not_set   CLERK_ISSUER langsung tak diset (503)
  issuer_mismatch  app tunjuk instance Clerk lain dari backend (401)
  bad_token        token betul-betul tak sah (401)

Diagnosis TIDAK PERNAH melonggarkan penolakan — token tetap ditolak. Nilai
config di-log server-side untuk `wrangler tail`, tidak dihantar ke client
(ada ujian yang sahkan issuer yang dijangka tak bocor ke luar).


---

# v37 — app bertukar ke Clerk PRODUCTION

Perubahan konfigurasi, bukan logik. 474 ujian masih lulus.

## Yang berubah

app/index.html baris 18: kunci Clerk dev (pk_test_, instance
good-penguin-19) diganti dengan kunci PRODUCTION:

  pk_live_Y2xlcmsuYmVyZXNwcm8ubXkk    -> clerk.berespro.my

Override localStorage ("bp.clerk") masih berfungsi kalau perlu tukar
sementara tanpa deploy semula.

## JANGAN DEPLOY SEHINGGA EMPAT-EMPAT SIAP

App ini akan GAGAL sign-in melainkan semua ini betul serentak:

1. [SIAP] Google OAuth custom credentials dalam Clerk production
2. [SIAP] 5 CNAME di Spaceship -> Clerk DNS "Verified"
3. [MENUNGGU] SSL certificate Clerk untuk clerk.berespro.my +
   accounts.berespro.my (auto, biasanya beberapa minit)
4. [BELUM] JWT template bernama "berespro" dalam instance PRODUCTION
5. [BELUM] CLERK_ISSUER di Cloudflare = https://clerk.berespro.my

Nombor 4 adalah blocker senyap: app panggil
sess.getToken({ template: "berespro" }) TANPA fallback. Kalau template
tiada, getToken pulang null dan pengguna nampak "Signed in, but no token"
walaupun semua yang lain betul.

Template mesti sertakan claim yang backend baca:
  email         -> {{user.primary_email_address}}
  name          -> {{user.full_name}}
  phone_number  -> {{user.primary_phone_number}}
(`sub` disertakan Clerk secara automatik.)

## Selepas tukar, sahkan dengan

  /health/config?key=<SETUP_KEY>
  -> auth.clerk_instance patut jadi "production"

Kalau sign-in gagal, /auth/session kini bagi kod yang tepat:
  issuer_mismatch  = app dan CLERK_ISSUER tak sepadan
  issuer_not_set   = CLERK_ISSUER tak diset langsung
  bad_token        = token betul-betul tak sah

## PERINGATAN

Tukar ke production akan PADAM semua pengguna ujian — data Clerk tidak
berpindah antara instance. Hari ini tiada kos (semua akaun ujian).


---

# v38 — sembunyikan UI dev daripada pengguna production

Satu pembetulan kecil, dijumpai selepas Zaini deploy v37 dan nampak
butang "Sign in with phone (DEV)" pada skrin welcome sebenar.

## Bukan lubang keselamatan — hal profesionalisme

Backend sudah selamat: /auth/dev-login pulang 404 sebab DEV_LOGIN tak
diset di Cloudflare (disahkan lagi sekali). Tapi app tetap PAPARKAN
butang tu kepada pengguna sebenar sebab ia digerbang atas LIVE() sahaja
(iaitu, "ada API base dikonfigur"), bukan atas sama ada build ni
production.

## Fix

window.BP_IS_DEV_BUILD sekarang derive terus daripada kunci Clerk yang
aktif: false bila kunci pk_live_, true bila pk_test_. Satu punca
kebenaran — tak boleh drift daripada kunci yang app SEBENARNYA guna.
Butang "Sign in with phone (DEV)" (dan skrin DEV MODE di belakangnya,
yang tiada laluan masuk lain) kini hanya nampak pada build dev.

Bina production (pk_live_) sekarang tunjuk HANYA "Continue with Google".


---

# v39 — KRITIKAL: wrangler.toml menimpa CLERK_ISSUER pada setiap deploy

Bug ditemui SELEPAS Clerk production disahkan berfungsi, bila Zaini upload
v38 dan CLERK_ISSUER SENYAP kembali ke dev instance.

## Punca

Cloudflare Git integration jalankan `npx wrangler deploy` pada setiap push
ke main. `wrangler deploy` anggap [vars] dalam wrangler.toml sebagai PUNCA
KEBENARAN untuk semua var plaintext. wrangler.toml dalam repo masih ada
CLERK_ISSUER hard-code ke dev instance (good-penguin-19) sejak awal projek.
Bila Zaini tukar nilai tu di dashboard Cloudflare terus (bukan dalam
wrangler.toml), ia berfungsi buat sementara — tapi deploy SETERUSNYA
timpa balik ke nilai lama dalam fail.

Kesan lebih luas: SEMUA var plaintext yang diset via dashboard tapi TIADA
dalam wrangler.toml berisiko sama, termasuk ADMIN_IDS yang bakal diset.

## Fix

wrangler.toml kini punca kebenaran sebenar:
- CLERK_ISSUER = https://clerk.berespro.my (production, betul)
- ADMIN_IDS didokumenkan dengan jelas (baris dikomen, tinggal isi user id)
- Amaran besar ditulis dalam fail: apa-apa var plaintext yang Zaini nak
  KEKAL selepas deploy MESTI masuk fail ni, bukan cuma dashboard.

Secrets (JWT_SECRET, SETUP_KEY, kunci Xendit) TAK terjejas — jenis
Encrypted diurus berasingan daripada [vars], selamat dari dashboard.

## PELAJARAN

Lepas ni, apa-apa perubahan config production kena masuk wrangler.toml
DAN dashboard sekali, bukan dashboard sahaja. Kalau tidak, ia hilang pada
upload seterusnya tanpa amaran.


---

# v40 — empat pembetulan dari ujian sebenar Zaini di telefon

## 1. KRITIKAL: toast MEMUSNAHKAN borang yang sedang diisi

    function toast(m){ state.toast=m; render(); ... }

render() ganti innerHTML #app sepenuhnya. Setiap input borang yang belum
dihantar HILANG nilainya. usePin() panggil toast 3 kali, jadi tekan
"Set pin" masa post task = borang kosong semula.

Ini jejas SETIAP borang dalam app, bukan post-task sahaja.

Fix: toast kini hidup dalam #toast-host, satu nod DI LUAR #app. toast()
tulis terus ke situ, tidak pernah panggil render(). CSS ditukar dari
position:absolute ke fixed sebab ia tidak lagi berlabuh pada .app.

## 2. Baris DEV dan Admin nampak oleh pengguna biasa

- "Developer" (API base URL) kini hanya pada build dev (BP_IS_DEV_BUILD).
- "Admin token" dulu dipapar kepada SESIAPA yang log masuk (state.liveUid).
  Kini hanya admin sebenar: backend pulangkan is_admin dalam publicUser,
  dikira dari ADMIN_IDS. Flag ini TIDAK memberi kuasa apa-apa — setiap
  route admin tetap semak ADMIN_IDS di server, tak kira apa app kata.

## 3. Toggle "Appearance" adalah hiasan semata

Tiada onclick, kekal "on", dan kandungan tetap cerah walaupun tertulis
"Dark". Kini dark mode SEBENAR: palet penuh di html[data-theme="dark"].
Sebab semua komponen baca token CSS, tiada satu pun perlu tahu tema wujud.
Bayang clay ditala semula untuk permukaan gelap (highlight putih nampak
macam calar di atas gelap). Disahkan dengan render Playwright sebenar,
bukan diandaikan. Tema disimpan dan dipakai SEBELUM paint pertama supaya
tiada kelipan.

## 4. GPS tak dapat lokasi

BUKAN bug kod. Geolocation ialah API secure-context: pada http:// browser
BLOK terus, tiada prompt, tiada ralat yang pengguna boleh betulkan.
app.berespro.my sedang berjalan atas HTTP (tiada sijil SSL Netlify lagi).

Kod kini namakan punca sebenar dan bezakan: perlu https / kebenaran
ditolak / tiada isyarat / timeout. Mesej lama menyalahkan "browser
permission", yang menghantar Zaini mencari tetapan yang bukan puncanya.

TINDAKAN ZAINI: hidupkan HTTPS untuk app.berespro.my di Netlify
(Domain management > HTTPS > Verify/Provision certificate). GPS akan
berfungsi sebaik sijil dikeluarkan.

## BELUM: gambar profil

Perlu storan R2 yang sama macam KYC, dan bucket berespro-kyc masih belum
dicipta. Akan dibina selepas bucket wujud.


---

# v41 — alamat tersimpan (gaya Grab), modal peta, dan sistem state

Suite baru test/addresses.mjs: 21 ujian. Jumlah 495 lulus, 0 gagal.
3 route baru (jumlah 69). PERLU /setup semula: jadual `addresses`.

## 1. Alamat tersimpan: Home / Office / label sendiri

Backend sebenar (bukan localStorage sahaja) supaya alamat ikut akaun:
  GET    /me/addresses
  POST   /me/addresses        { label, addr, lat, lng }
  DELETE /me/addresses/:id

Keputusan reka bentuk:
- LABEL SAMA MENGGANTI. Simpan "Home" baru menggantikan "Home" lama
  (case-insensitive) — itulah maksud "set as Home" bagi manusia, bukan
  kumpul lima Home. Ada ujian khusus.
- Had 10 alamat. Tiada siapa ada 11 rumah; had menghalang client jahat
  memenuhi jadual. Mengganti label sedia ada MASIH dibenarkan pada had.
- Pin wajib. Alamat tanpa koordinat tak boleh pandu coverage gate atau
  jarak partner — ia penipuan yang menunggu masa untuk pecah.
- Ownership: orang lain dapat 404 (bukan 403 — tiada existence oracle).

Dalam app: chip [Home] [Office] [...] atas borang post task — tap terus
isi alamat + pin TANPA render (pelajaran toast: render padam borang).
Pengurus penuh dalam Settings > Saved addresses (padam dengan confirm).

## 2. Modal peta skrin penuh (macam Grab)

#modal-host DI LUAR #app — pelajaran sama macam toast: render() tak boleh
musnahkan peta yang tengah diseret. Leaflet + pin seret + tap-to-move,
GPS jump-to-me (dengan mesej jujur https yang sama), reverse geocoding
Nominatim yang PRE-FILL alamat tapi tak pernah menimpa apa yang pengguna
dah taip (_mm.edited flag), chip label Home/Office/Other + checkbox
"Save this address". Kalau Leaflet gagal dimuat (offline), fallback:
taip alamat sendiri.

## 3. Sistem state

- BUSY OVERLAY (#busy-host, imperatif): "Signing you in…" semasa
  pertukaran token Clerk (hide dalam finally yang sama dengan single-
  flight flag — tiada laluan boleh tinggalkan spinner tersangkut),
  "Posting your task…", "Sending your bid…".
- SUCCESS SCREEN selepas post: bulatan hijau animasi + nama task +
  "View my task" / "Back to home". Laluan LIVE dan local dua-dua guna.

## Nota pengesahan

Logik disahkan oleh 495 ujian. Render Playwright berjalan tanpa ralat
halaman dan screenshot tercipta, tetapi paparan imej dalam sesi gagal
kali ini — pengesahan visual akhir adalah pada telefon sebenar. Kalau
modal peta nampak pelik, hantar screenshot.


---

# v42 — delivery multi-stop + harga per-km + foto task + Help centre

Dari ujian tester sebenar (WhatsApp Zaini). Suite baru test/delivery.mjs:
17 ujian. Jumlah 512 lulus, 0 gagal. 2 route baru (jumlah 71).
PERLU /setup semula: kolum tasks.stops, tasks.route_km, tasks.photos.

## 1. Stops penghantaran (point B, multi-drop macam Lalamove)

Aduan tester: "xda ruangan untuk deliver item tu". Kini untuk kategori
Moving/Delivery: sampai 5 stop selepas pickup, setiap satu dipilih melalui
modal peta yang sama (alamat + pin wajib). route_km dikira di SERVER
(haversine pickup -> stop1 -> ...) — client tak boleh dikte jarak; ada
ujian yang cuba hantar route_km palsu dan disahkan diabaikan. Had 400km.

Paparan: skrin butiran task (customer DAN partner sebelum bid) tunjuk
laluan A -> 1 -> 2 dengan chip jarak, melalui satu blok kongsi
taskExtras() — partner nampak laluan penuh sebelum menawar.

## 2. Harga auto per-km (macam Lalamove, tapi jujur pada model bidding)

CADANGAN, bukan harga paksa — ini marketplace bidding. Formula:
base + per_km × jarak. Default RM5 + RM1.50/km, admin-tunable melalui
settings table (delivery_base_cents, delivery_per_km_cents), dihantar ke
app dalam respons /me. Baris "Route ≈ X km · suggested RM Y [Use
suggested]" mengisi budget dengan satu tap. Matematik disahkan dua kali:
ujian server (17) dan assert DOM (14).

## 3. Foto task (sampai 4) — tile "Photos" tak lagi hiasan

Aduan tester: "xboleh attach photo" — tile + tu memang tiada onclick.
Kini sebenar: pilih -> DOWNSCALE atas telefon (canvas ≤1600px JPEG) ->
upload. Downscale buat dua kerja: upload ~5MB jadi ~300KB, dan re-encode
BUANG EXIF termasuk koordinat GPS tempat gambar diambil — foto task
dipapar kepada orang asing, ia tak patut bocorkan lokasi melebihi alamat
yang dipilih.

Storan: bucket R2 SAMA dengan KYC (satu bucket sahaja untuk dicipta),
prefix berbeza = peraturan akses berbeza: kyc/ admin sahaja, taskimg/
mana-mana pengguna log masuk (partner mesti nampak foto kerja). Server
pilih kunci, magic bytes disahkan, kunci orang lain ditolak (ujian
forgery kyc/ + kunci orang lain ada). <img> tak boleh hantar header auth,
jadi thumbnail dimuat melalui fetch + blob URL (hydrateTimgs, dengan
cache).

Submit disekat sementara foto masih upload ("Photos are still
uploading") — elak task tercipta tanpa foto yang dijanjikan.

## 4. Help centre — dulu toast('Help centre opened'), sekarang skrin

6 FAQ (bids, bila bayar, dispute, cancel, kenapa KYC, cara delivery)
dengan accordion. Butang WhatsApp deep-link muncul HANYA bila
BP_SUPPORT_WA diisi nombor sebenar — tiada butang palsu yang tunjuk ke
tempat kosong. ZAINI: isi window.BP_SUPPORT_WA = "60XXXXXXXXX" dalam
app/index.html bila dah ada nombor support.

## Nota bug diri sendiri

Hook skrin saya tulis screen==="post" tapi nama skrin sebenar "cpost" —
ditangkap oleh assert DOM (bukan oleh mata), dibaiki. Pengesahan visual
piksel gagal dalam sesi (paparan imej), jadi pengesahan ialah 14 assert
DOM + 512 ujian. Rupa akhir: telefon Zaini.

## PENTING: foto perlukan bucket R2

Upload foto pulang 503 sampai bucket "berespro-kyc" dicipta di Cloudflare
dan [[r2_buckets]] dalam wrangler.toml di-uncomment. Ini blocker SAMA
dengan KYC dan gambar profil — SATU langkah cipta bucket membuka
ketiga-tiga fitur.


---

# v43 — sisi partner: skills sebenar, gate lesen delivery, KYC kamera,
#       gambar profil, harga per-km dalam control panel

Suite baru test/partner-media.mjs: 18 ujian. Jumlah 530 lulus, 0 gagal.
4 route baru (jumlah 75). PERLU /setup semula: users.licence_key +
users.avatar_key.

## 1. "+ Add skill" — dulu chip mati, sekarang sheet penuh

8 skill sebagai toggle. Skills kini DIVALIDASI di server (dulu:
JSON.stringify apa sahaja tanpa semakan — array sahaja, max 12, setiap
satu ≤24 aksara, lowercase).

## 2. Skill Delivery/Moving perlukan lesen memandu

Partner akan memandu barang customer. Gate di SERVER (patchMe):
licence_required 403 tanpa lesen — app cuma memudahkan laluan (prompt
kamera terus, capture="environment"). Lesen disimpan bawah kyc/ (akses
admin sahaja — ia dokumen identiti), route admin baru
GET /admin/licence/:userId untuk semak. Ujian: tolak tanpa lesen, lulus
selepas, skill bukan-memandu bebas.

## 3. KYC guna KAMERA, bukan album; ic_last4 DIBUANG

capture="environment" (IC depan/belakang) + capture="user" (selfie).
JUJUR: capture ialah arahan kepada browser mudah alih — Android/iOS
membukanya terus ke kamera, tapi ia bukan bukti kriptografi; desktop
fallback ke file picker. Field 4 digit IC dibuang dari borang DAN backend
(nombor IC ada ATAS gambar dokumen yang admin semak — menaip 4 digit
menambah geseran tanpa menambah verifikasi). ic_last4 masih diterima
jika dihantar (app lama), dan masih ditolak jika cacat.

## 4. Gambar profil

Tap avatar di profil (customer & partner) -> kamera depan -> downscale
(EXIF dibuang) -> POST /me/avatar. SATU kunci R2 per pengguna
(avatar/<uid>) ditulis-ganti — tiada sampah terkumpul. Boleh dilihat
mana-mana pengguna log masuk (avatar muncul pada bid). has_avatar /
has_licence didedahkan dalam publicUser.

## 5. Harga per-km dalam control panel

Base RM5 dikekalkan (Zaini setuju). Panel admin tab Algorithm kini ada
"Delivery pricing": Base fare (RM) + Per km (RM) — UI dalam RM, wire
dalam sen. Whitelist admin settings ditambah delivery_base_cents (cap
RM100) + delivery_per_km_cents (cap RM20/km). Berkuat kuasa serta-merta
pada sesi baru (dihantar melalui /me).

## Nota

Pengesahan: 18 ujian server + 10 assert DOM (2 kegagalan awal ialah
andaian ujian saya yang salah, bukan kod — borang KYC render pada status
not_submitted, dan app sentiasa LIVE jadi prompt lesen ialah laluan
betul). Foto/lesen/avatar semuanya 503 sehingga bucket R2 dicipta —
blocker sama, satu langkah membuka semua.


---

# v44 — motor/kereta, tip, tema langit negeri, dark mode dibuang

Suite baru test/tips.mjs: 17 ujian. Jumlah 551 lulus, 0 gagal.
2 route baru (jumlah 77). PERLU /setup: tasks.vehicle + jadual tips.

## 1. Delivery: Motor atau Kereta, harga berbeza

Motor RM4 + RM1.00/km. Kereta RM5 + RM1.50/km (base RM5 Zaini setuju).
Keempat-empat nilai boleh diubah dalam control panel. Kad pemilih tunjuk
harga SETIAP mod terus di muka — pilihan tanpa harga bukan pilihan.
Cadangan harga dikira semula bila mod ditukar. Server sahkan vehicle
(motor|car sahaja) dan HANYA simpan pada task delivery/moving — task
cleaning takkan bawa medan kenderaan yang mengelirukan.

## 2. Tip kepada partner selepas kerja siap

100% MASUK PARTNER. Platform tak ambil sesen pun dari tip. Ini sebabnya
tips ialah jadual SENDIRI, bukan baris payments: payments ada bid_id dan
pecahan yuran; tip tiada kedua-duanya, dan mencampurkannya akan buat
aritmetik yuran menipu.

Tiada escrow: escrow melindungi customer SEBELUM kerja. Tip selepas, jadi
ia dicaj terus. Sekali sahaja per task (unique index, bukan sekadar
semakan fungsi), customer task itu sahaja, hanya selepas completed, dan
dibekukan kalau ada dispute.

Sheet muncul sejurus selepas customer lepaskan bayaran (masa perkhidmatan
baik masih segar), dengan "No thanks" satu tap dan TIADA amaun
dipratetap — tip yang terasa dipaksa lebih teruk dari tiada tip.
Pendapatan partner tunjuk tip BERASINGAN dari upah kerja.

## 3. Tema langit ikut negeri

SVG inline, bukan imej: skala ke mana-mana skrin, tiada berat fail, tiada
pipeline aset. Landmark dilukis sebagai silhouette geometri sebenar:
  KL/PJ/Subang/Kajang  Petronas (dua menara tirus + skybridge) + KL Tower
  Putrajaya            Masjid Putra berkubah + jambatan Seri Wawasan
  Penang               Jambatan Pulau Pinang (cable-stayed)
  Johor Bahru          Masjid Sultan Abu Bakar (empat menara)
  Melaka               Christ Church + Menara Taming Sari
  Shah Alam            Masjid Biru (kubah besar, empat menara)
  selain itu           bukit + pekan generik

JUJUR: hanya tempat yang ada silhouette betul-betul boleh dikenali
dilukis. Bentuk yang tiada siapa boleh cam lebih teruk dari langit
generik yang jujur, jadi selebihnya guna fallback.

Langit bertukar ikut jam (subuh/pagi/tengah hari/senja/malam) dan sapaan
pun ikut jam — dulu "Good evening" tertulis kekal walaupun pukul 9 pagi.

## 4. Dark mode dibuang sepenuhnya

Token, toggle, applyTheme, toggleTheme, state.theme — semua dikeluarkan
(bukan disembunyikan). Tinggal <meta theme-color> sahaja.

## IKON 3D: saya TIDAK boleh hasilkan

Ikon dalam mockup Zaini ialah ilustrasi 3D raster (render/AI-generated).
Saya hanya boleh tulis SVG. Menulis SVG "3D" dengan tangan untuk 8
kategori akan hasilkan sesuatu yang lebih teruk dari ikon garis sekarang
— itu tepat slop yang Zaini larang. Ikon kategori KEKAL seperti sedia
ada. Untuk dapat rupa mockup: eksport 8 PNG dari sumber yang hasilkan
mockup itu, letak dalam app/icons/cat/, dan saya tukar tile untuk
memaparkannya (kerja 10 minit).

## Pengesahan

17 ujian tip + 20 assert DOM (skyline berbeza antara negeri, teks di atas
seni, dark mode betul-betul tiada, harga bertukar ikut kenderaan, tip
tiada pratetap). Paparan piksel gagal lagi dalam sesi — rupa akhir pada
telefon Zaini.


---

# v45 — pembetulan kecemasan UI: font, langit ceria & sekular, tarikh live

Semua dari maklum balas marah Zaini selepas deploy v44 — dan aduan
terbesarnya berpunca dari BUG SAYA SENDIRI.

## 1. PUNCA "Times New Roman": token font TERPADAM oleh saya

Bila dark mode ditambah (v40), blok :root tertutup awal dan token
--body:'Hanken Grotesk' terperangkap dalam blok dark theme. Bila dark
theme DIBUANG (v44), token font terbuang sekali. font-family:var(--body)
jadi kosong -> serif -> Times New Roman pada SEMUA teks. Inilah punca
"UI nampak beza dan lebih buruk" dan "icon semakin buruk" — ikon tak
berubah, tapi semua label di sekelilingnya bertukar serif.

Fix: token dipulihkan, dan diff penuh terhadap :root v39 mengesahkan
TIADA token lain hilang. Assert DOM kini semak font computed body.

## 2. Langit negeri: SEKULAR dan CERIA

TIADA bangunan agama mana-mana kepercayaan — skyline ialah welcome mat,
bukan kenyataan. Masjid Putrajaya/Shah Alam/JB dan Christ Church Melaka
DIBUANG. Ganti: menara, jambatan, alam dan budaya sahaja:
  KL / Klang Valley   Petronas + KL Tower
  Johor Bahru         Bangunan Sultan Ibrahim (menara jam sekular)
  Penang              Jambatan Pulau Pinang
  Ipoh                Bukit batu kapur
  Melaka              Menara jam Stadthuys + Menara Taming Sari
  Kuantan             Pantai timur (pantai, ombak, payung)
  Kota Bharu          Wau bulan (budaya, bukan agama)
  Alor Setar          Menara Alor Setar
  Kuching             Bumbung payung DUN Sarawak + sungai
  Kota Kinabalu       Gunung Kinabalu
  lain-lain           Bukit mesra (fallback jujur)

Palet dirombak ceria: siang biru terang bermatahari hangat, senja
keemasan, malam indigo lembut berbintang — BUKAN gelap gothic. Silhouette
indigo lembut, bukan hampir-hitam. Assert DOM semak luminance silhouette
dan ketiadaan kata kunci bangunan agama. Shade kelabu ditambah di
belakang teks header supaya nama terbaca atas langit cerah.

## 3. Senarai bandar dirombak ikut arahan

Klang Valley SATU entri (ganti PJ/Shah Alam/Subang/Kajang/Putrajaya).
Ditambah: Ipoh, Kuantan, Kota Bharu, Alor Setar, Kuching, Kota Kinabalu.
Kekal: KL, JB, Penang, Melaka, Seremban. Jumlah 12, termasuk Malaysia
Timur buat pertama kali. Coverage gate tak terjejas (resolusi ikut pin,
bukan nama bandar).

## 4. Tarikh "Date needed" kini LIVE

Dulu hardcoded value="2026-07-15" (backdated). Kini default HARI INI
(tarikh tempatan, bukan UTC — toISOString akan silap sebelum 8 pagi MYT)
dan min=hari ini: tarikh lepas tak boleh dipilih langsung.

## 5. Butang lokasi semasa pada peta

Butang bulat terapung di penjuru peta modal — tap untuk lompat ke lokasi
sebenar. JUJUR: GPS masih DISEKAT browser selagi app.berespro.my atas
HTTP. Butang ini akan beritahu sebab sebenar bila disekat, dan berfungsi
serta-merta selepas Zaini hidupkan HTTPS di Netlify.

## 6. Phonegate berulang — BUKAN bug, dan ini buktinya

Laluan kod di-trace semula: phonegate hanya muncul bila SERVER kata akaun
itu tiada nombor. Senario yang hampir pasti berlaku: nombor PALSU YANG
SAMA dimasukkan pada dua akaun Google berbeza -> akaun kedua kena tolak
phone_taken ("That number is already registered") -> nombor tak
tersimpan -> akaun itu tersekat di phonegate setiap kali login. Semak di
D1 console: SELECT email, phone FROM users; — baris yang phone-nya
kosong ialah akaun yang tersekat.

## Ikon kategori

TIDAK diubah dalam v45. Rupa "semakin buruk" ialah kesan font serif di
sekelilingnya. Tawaran kekal: eksport 8 PNG 3D dari sumber mockup ->
app/icons/cat/ -> saya pasang.


---

# v46 — planner laluan gaya Grab, bug tile kategori, auto-locate bandar

App sahaja (tiada perubahan backend — tiada /setup diperlukan).
532 ujian server kekal hijau; 19 assert DOM baharu.

## 1. BUG: semua tile kategori buka Cleaning

Setiap tile home memanggil go('cpost') TANPA kategori — borang default ke
pilihan pertama, iaitu Cleaning. Kini tile hantar kategorinya dan borang
terbuka terus pada kategori yang ditekan (Moving/Delivery terus tunjuk
seksyen penghantaran).

Bug ketiga tersembunyi ditemui semasa menguji ini: hook penyediaan skrin
duduk DI BAWAH guard token rangkaian dalam liveSync — penyediaan UI
senyap tak jalan bila sesi belum sedia. Hook UI dipindah ke atas guard;
penyediaan skrin tak patut menunggu auth.

## 2. Planner laluan gaya Grab (Moving/Delivery)

Butang "Plan route on map" membuka SATU peta skrin penuh yang menjadi
keseluruhan order: pin pickup hijau (A), pin drop-off bernombor biru
(sampai 5), garisan laluan antara semuanya, chip Motor/Car, dan kad
tambang yang mengira SEMULA secara langsung setiap kali pin diseret,
stop ditambah/dibuang, atau kenderaan ditukar. Confirm menulis semuanya
balik ke borang biasa (pin, stops, kenderaan, alamat auto dari reverse
geocode) — jadi matematik tambang server kekal satu-satunya kebenaran.

JUJUR: garisan itu titik-ke-titik lurus, bukan routing jalan raya —
routing sebenar perlukan servis arah yang kita tak jalankan. Tambang
memang berharga atas km garis-lurus yang sama di SERVER, jadi apa yang
dipaparkan ialah apa yang dicadangkan. Diuji hujung-ke-hujung dengan stub
Leaflet (CDN disekat dalam sandbox): matematik tambang disahkan tepat
sama dengan formula, penulisan balik disahkan.

## 3. Auto-locate bandar di home

Butang crosshair sebelah chip bandar: GPS -> bandar TERDEKAT dari
senarai (haversine) -> tukar bandar + langit + simpan ke akaun. Jika
lebih 60km dari semua bandar, dia jujur: "(nearest city we cover)".
Masih perlukan HTTPS untuk GPS — mesej sebab sebenar dipaparkan.

## 4. Geseran alamat dikurangkan

Borang order terbuka dengan alamat Home TERISI SENDIRI (pin + teks) bila
pengguna ada alamat tersimpan dan belum set pin — sifar taipan untuk
kes paling biasa. Planner laluan mengurangkan lagi: satu skrin untuk
pickup + semua drop-off + tambang.

## 5. Tile kategori diberi warna ceria (tapi tegas)

Bulatan ikon pastel + ikon warna tepu per kategori — hidup tanpa jadi
kebudakan. Ikon garis kekal (kekangan 3D yang sama seperti dijelaskan
dalam v44).

## 6. Tukar gambar profil "tak dapat"

Rantaian disahkan berfungsi (tap avatar -> kamera -> upload). Kegagalan
sebenar ialah 503 storage_unbound: BUCKET R2 "berespro-kyc" MASIH BELUM
DICIPTA. Ini blocker yang sama sejak v42 — satu langkah dua minit itu
membuka gambar profil, KYC, lesen, dan foto task serentak.


---

# v47 — peta kerja LANGSUNG untuk partner

Suite baru test/feed-radius.mjs: 13 ujian. Jumlah 545 lulus, 0 gagal.
20 assert DOM baharu. App + satu suite ujian; TIADA perubahan schema,
TIADA /setup diperlukan.

## Backend sudah sedia — tiada route baharu

GET /tasks?lat=&lng=&radius=&cat=&sort= sudah menapis task terbuka dalam
radius, mengecualikan task partner sendiri, dan memulangkan lat/lng,
distance_km, bid_count, my_bid. Peta menggunakannya terus. Satu-satunya
kerja backend ialah MENGUNCI tingkah lakunya dengan ujian.

## Had radius: dikuatkuasakan SERVER, bukan UI

Zaini minta pastikan ada maksimum. Server sudah ada
Math.min(radius, 50). Kini ada ujian yang membuktikannya: radius=500,
radius=99999, radius=abc dan radius=-10 semuanya tidak boleh mengembalikan
kerja 300km. UI menawarkan TEPAT nilai yang server akan hormati
(5/10/20/50, yang terakhir berlabel "max") — lebih baik dari membenarkan
seseorang taip 500 dan senyap-senyap terima 50.

## Peta

Skrin penuh dalam #modal-host (di luar #app — render() akan meruntuhkan
peta di tengah pan). Titik biru = partner, bulatan = radius, penanda
berlabel HARGA setiap kerja diwarnakan ikut kategori. Kerja yang partner
SUDAH bida jadi kelabu bertanda — supaya dia tak buang masa membukanya.

Tap penanda -> kad bawah: tajuk, alamat, jarak sebenar, bajet, bilangan
bid, dan butang "View & place bid" yang membawa terus ke skrin bid.
Kerja yang sudah dibida tunjuk "You've bid — view job" sebaliknya.

Kawalan: chip radius (5/10/20/50 km), chip kategori, butang lokasi saya,
butang refresh.

## "Langsung" bermaksud poll 30 saat, bukan socket

Jujur tentang pilihan: feed berubah dalam skala minit, dan poll berharga
satu permintaan. Socket akan berharga satu sambungan berterusan setiap
partner tanpa faedah yang boleh dilihat. Timer BERHENTI apabila peta
ditutup — ada assert khusus untuk timer hantu.

## Pengesahan

13 ujian server (had radius, muatan peta, tapisan) + 20 assert DOM
menggunakan stub Leaflet (CDN disekat dalam sandbox): bulatan radius
sepadan dengan state.radius*1000, kerja 90km dikecualikan pada setiap
tetapan radius, tapisan kategori tepat, kad bid betul untuk kedua-dua
keadaan, poll berhenti bersih.


---

# v48 — Bahasa Melayu

App sahaja. 545 ujian server kekal hijau; 23 assert DOM baharu.
TIADA perubahan schema, TIADA /setup.

## Pendekatan: terjemah DOM selepas render, bukan bungkus 390 rentetan

Membungkus setiap rentetan dalam t("...") bermakna menyentuh ~390 tempat
di dalam template literal — diff besar dengan risiko sebenar merosakkan
interpolasi yang merender app. Sebaliknya: selepas setiap render, jalan
melalui NOD TEKS sahaja dan padankan TEPAT dengan kamus.

Kenapa ini pilihan yang betul di sini:
- Rentetan yang tiada dalam kamus kekal Inggeris yang boleh dibaca.
  Terjemahan tertinggal tidak pernah jadi kosong atau kunci mentah macam
  "home.title" — kes terburuk ialah bahasa bercampur, bukan skrin rosak.
- Nod teks sahaja bermakna markup dan ${...} tak boleh dirosakkan.
  Atribut dihadkan kepada senarai pendek: placeholder dan title.
- Kamus DITULIS TANGAN dalam bahasa Malaysia, bukan terjemahan mesin.
  "Bida" untuk bid, "tawaran" untuk offer, dan "Partner" DIKEKALKAN sebab
  itu istilah Berespro sendiri untuk pekerjanya.

## Perkataan sama, makna berbeza

"Home" ialah tab nav bawah DAN label alamat tersimpan. Kamus rata akan
senyap-senyap tulis ganti satu dengan yang lain — pertembungan ini
dikesan oleh semakan kunci pendua sebelum ia sempat jadi bug. Kini
BM_CONTEXT memilih ikut kedudukan: dalam .nav ia "Utama", di tempat lain
"Rumah". Ada assert khusus yang menyemak kedua-duanya betul serentak.

## Teks bernombor

Rentetan berinterpolasi tak boleh dipadan tepat, jadi ada corak:
"12.4 km away" -> "12.4 km dari sini", "3 jobs · 20 km" -> "3 kerja · 20 km",
"Bids (4)" -> "Bida (4)", baris tambang laluan, dan lain-lain.

## Modal, toast, overlay

Semuanya ditulis secara imperatif di luar #app. Diliputi oleh
MutationObserver pada #modal-host / #busy-host / #toast-host yang
memerhati NOD DITAMBAH sahaja — bukan perubahan teks. Itulah yang
menjadikannya bebas gelung: terjemahan mengubah nod teks sedia ada, yang
observer ini tidak bertindak balas kepadanya.

## Tukar bahasa

Settings > Language. Pilihan disimpan. Tukar balik ke Inggeris disahkan
bersih — tiada sisa Melayu tertinggal.

## Nota kejujuran

Liputan kamus 157 kunci + 11 corak, memberi tumpuan kepada skrin yang
pengguna betul-betul lihat: welcome, home, borang tugas, butiran tugas,
kerja partner, bida, bayaran, profil, tetapan, KYC, peta, toast utama.
Skrin lebih dalam (audit, sebahagian admin, beberapa mesej ralat jarang)
masih Inggeris dan akan kekal boleh dibaca sehingga ditambah. Menambah
lebih banyak hanya perlu tambah baris dalam BM — tiada markup disentuh.

## Bug ujian saya sendiri (2)

Dua assert gagal pada mulanya dan kedua-duanya salah SAYA, bukan kod:
skrin cpost memang tiada nav bawah, dan perbandingan innerHTML gagal
kerana pelayar mengekod semula & sebagai &amp; — butang itu sebenarnya
sudah diterjemah. Ujian dibetulkan untuk membandingkan teks terender.


---

# v49 — Manrope

Zaini memilih Manrope selepas melihat perbandingan langsung (Inter ditolak:
"macam ada AI slop element"). App sahaja; 545 ujian server kekal hijau,
10 assert DOM baharu.

## Apa yang bertukar

--body: Hanken Grotesk -> Manrope. Ini meliputi hampir semua teks: badan,
butang, input, nav, tajuk skrin.

h1 dan nombor kad baki dipindah dari --disp ke --body juga, sebab
perbandingan yang Zaini luluskan memaparkan tajuk besar dan angka dalam
Manrope. Berat dinaikkan ke 800 dan letter-spacing dirapatkan sedikit
supaya tajuk kekal tegas pada Manrope yang lebih geometri.

## Apa yang TIDAK bertukar

Wordmark "berespro" dan ikon app kekal Unbounded. Itu logo — ia tiada
dalam perbandingan, jadi menukarnya bukan keputusan untuk saya buat bagi
pihak Zaini. Kalau dia mahu, satu baris sahaja.

## Muatan font: 1.19 MB -> 496 KB

- Manrope dihantar sebagai woff2, bukan ttf: 14KB satu berat berbanding
  68KB. Lima berat = 70KB (dulu 340KB).
- Unbounded-700.ttf (423KB) DIBUANG. Selepas h1 berpindah, satu-satunya
  pengguna Unbounded ialah wordmark dan ikon, kedua-duanya berat 800 —
  fail 700 itu muatan mati yang dimuat turun setiap pelawat.

## Rujukan tertinggal yang hampir jadi bug

Empat tempat masih merujuk font lama, dan satu daripadanya SERIUS:
senarai aset service worker. c.addAll() menolak keseluruhan janji jika
SATU fail 404, jadi memasang SW akan GAGAL sepenuhnya dan app hilang
keupayaan luar talian — senyap. Dibetulkan bersama tema widget Clerk dan
palet control panel.

## Lesen

Manrope di bawah SIL Open Font Licence — bebas dibundel dalam produk
komersial. Font DoorDash asal (TT Norms Pro) berlesen komersial dan tidak
pernah menjadi pilihan.

## Susulan: control panel masih memuat font lama

Semasa menyatukan v45-v49 untuk upload, semakan menemui satu lagi rujukan
tertinggal yang saya terlepas: pautan Google Fonts dalam control panel
masih memuat turun Hanken Grotesk dan Unbounded 700, walaupun CSS-nya
sudah meminta Manrope. Kesannya senyap — panel jatuh ke font sistem.
Dibetulkan: pautan kini memuat Manrope.

## Pengesahan

Ujian menghidangkan fail font SEBENAR pada laluan sebenar yang app minta,
jadi 404 akan ditangkap: tiada. Manrope disahkan benar-benar dimuat
(bukan fallback senyap), tiada sisa Hanken, wordmark masih Unbounded, dan
tiada teks terkeluar kotak pada mana-mana skrin — termasuk dalam Bahasa
Melayu, yang perkataannya lebih panjang.


---

# v50 — alamat dalam planner, planner lebih stabil, tile ikon terapung

App sahaja. 545 ujian server kekal hijau; 18 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## 1. Koordinat -> alamat sebenar

Planner memaparkan "1.4920, 103.7410" — nombor itu tidak bermakna apa-apa
kepada orang yang memutuskan ke mana bungkusan pergi. Kini setiap baris
menunjukkan nama jalan dan kawasan.

Reverse geocoding Nominatim mengehadkan lebih kurang satu permintaan
sesaat, dan menyeret empat pin akan melanggarnya serta-merta. Jadi:
carian di-CACHE mengikut koordinat dibundarkan, dan disalurkan melalui
BARISAN satu-satu dengan jeda 1.1 saat. Jawapan basi (pin sudah bergerak
lagi) dibuang.

display_name Nominatim ialah rantaian poskod penuh — terlalu panjang
untuk satu baris. shortAddr() mengambil bahagian bermakna sahaja:
bangunan/jalan, kemudian kawasan.

## 2. Alamat boleh DITAIP sendiri

Tap mana-mana baris untuk taip alamat betul. Geocoding dapat nama jalan,
tetapi tidak pernah nombor unit, kod pagar, atau "belakang surau".
Taipan pengguna menang — carian automatik tidak akan menimpanya.

## 3. Kestabilan: punca sebenar "tak stabil"

Dua sebab, kedua-duanya kesalahan saya dalam v46:
- list.innerHTML dibina SEMULA setiap kali pin diseret. Baris berkelip dan
  kedudukan skrol melompat. Kini baris dibina SEKALI apabila stop
  ditambah/dibuang; menyeret hanya mengemas kini teks di tempatnya.
- Polyline dibuang dan dicipta semula setiap redraw. Kini setLatLngs()
  menggerakkan garisan sedia ada — tiada kelipan.

Juga: kotak senarai dinaikkan 120px -> 210px supaya lima destinasi muat
tanpa skrol dalam yang sempit, dan destinasi pertama kini disemai lebih
jauh dari pin pengambilan supaya ia jelas pin berasingan.

## 4. Tile kategori: sempadan dibuang, ikon terapung

Kad, bayang dan latar tile dibuang sepenuhnya seperti diminta. Yang
tinggal: cakera bertona lembut dengan glow warna kategori di bawahnya,
dan label. Sasaran tap kekal saiz sama.

## 5. Ikon dilukis semula: pejal, bukan garis nipis

Garis nipis satu-berat itulah yang membaca sebagai generik. Ikon kategori
kini bentuk PEJAL dua-tona — siluet penuh dengan bentuk sekunder lebih
lembut, satu warna kategori memandu keseluruhan glif. Ini bukan ilustrasi
3D (kekangan yang sama seperti dijelaskan dalam v44) tetapi ia bentuk yang
dilukis dengan niat, bukan stroke generik.

## Nota ujian

Satu assert gagal dua kali dan KEDUA-DUANYA salah saya, bukan kod: label
baris memang wujud, tetapi huruf besarnya datang dari CSS text-transform
yang tidak mengubah textContent, dan selector saya tersasar satu tingkat.
Label kini diberi kelas sendiri — lebih kemas untuk kod dan ujian.


---

# v51 — flow laluan ditulis semula: satu titik pada satu masa

App sahaja. 545 ujian server kekal hijau; 22 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## Punca kekeliruan (kesalahan reka bentuk saya dalam v46)

Versi lama meletakkan SEMUA pin atas satu peta serentak, MENYEMAI satu
drop-off di kedudukan rawak yang pengguna tidak pernah minta, dan
menjadikan semua pin boleh diseret pada masa sama. Jadi tiada apa yang
memberitahu anda pin MANA yang sedang anda tetapkan — dan menyeret pin
kecil dengan ibu jari memang payah. Itulah kekeliruannya, bukan lukisan.

## Flow baharu

1. SENARAI langkah, bukan peta. Pengambilan di atas, penghantaran
   bernombor di bawahnya.
2. Tap satu baris -> pemilih skrin penuh untuk SATU titik itu sahaja.
3. Pin TETAP di tengah skrin. Anda gerakkan PETA di bawahnya — jauh lebih
   mudah dengan ibu jari daripada mengena sasaran 30px, dan soalan "pin
   mana saya pegang ni?" hilang terus sebab hanya ada satu.
   Alamat di bawah peta dikemas kini semasa anda gerak.
4. Sahkan -> kembali ke senarai. Satu keputusan pada satu masa.

Tiada apa ditambah di belakang anda: "Add drop-off" terus membuka
pemilih, dan berundur tidak menambah apa-apa.

Medan tambahan untuk nombor unit / mercu tanda / pagar, sebab geocoding
dapat nama jalan tetapi tidak pernah "No 12, sebelah kedai runcit".
Taipan pengguna menang atas carian automatik.

Butang sahkan DIMATIKAN sehingga ada sekurang-kurangnya satu destinasi,
dan berbunyi "Set a drop-off first" — bukan butang mati tanpa sebab.

## Bug yang assert DOM tangkap semasa kerja ini

Fungsi geocoding (_geoCache, lookupAddr, geoKey, shortAddr, drainGeo)
tertanam DALAM blok planner lama, jadi menulis semula planner memadamnya
sekali — sementara tiga tempat masih memanggilnya. App akan throw
ReferenceError sebaik pemilih dibuka. Dipulihkan dan dipindahkan KELUAR
dari blok planner supaya penulisan semula akan datang tidak boleh
memadamnya lagi.

## Diuji

22 assert: senarai buka tanpa drop-off hantu, pemilih buka dengan pin
tengah tetap, gerak peta mengemas kini alamat, batal tidak menambah apa-
apa, taipan menang, tambang berubah ikut kenderaan, had 5 destinasi,
confirm menulis balik ke borang, planner ditutup bersih.


---

# v52 — carian tempat dalam peta

App sahaja. 545 ujian server kekal hijau; 17 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## Taip nama tempat, jangan pan sampai jumpa

Kotak carian di atas peta dalam pemilih titik. Taip "KLCC", "Mid Valley",
"Hospital Sultanah Aminah" atau nama jalan — pilih dari senarai, peta
melompat ke sana.

Butiran yang membuatkan ia berguna:
- Hasil DIHADKAN ke Malaysia (countrycodes=my) — bukan Jalan Besar di
  negara lain.
- Hasil DICONDONGKAN ke kawasan yang peta sedang tunjuk, jadi nama jalan
  biasa memulangkan yang berdekatan dahulu.
- Carian hanya bermula selepas 3 aksara DAN selepas anda berhenti menaip
  (450ms). Satu permintaan satu carian, bukan satu setiap ketukan kekunci.
- Hasil di-cache; permintaan disalurkan satu-satu dengan jeda seperti
  carian alamat terbalik, kerana Nominatim menghadkan lebih kurang satu
  permintaan sesaat.
- Jawapan basi dibuang jika kotak sudah ditaip semula.

## Kes gagal dikendalikan dengan jujur

Tiada padanan -> "No match for X. Try a nearby landmark, or move the map."
Carian gagal (luar talian / dihadkan) -> memberitahu terus terang DAN
mengingatkan bahawa menggerakkan peta masih berfungsi. Peta tidak pernah
disekat oleh carian yang gagal.

## Bug yang ditangkap semasa menguji

Memilih hasil carian menetapkan nama tempat pada label — kemudian carian
alamat TERBALIK yang tertunda mendarat lebih kurang 350ms selepas itu dan
MENIMPANYA dengan nama jalan. Jadi "Mid Valley Megamall" bertukar sendiri
menjadi "Lingkaran Syed Putra" sebaik anda memilihnya. Itu betul-betul
mengelirukan, dan ia satu bug sebenar, bukan artifak ujian.

Dibetulkan: tempat yang DIPILIH mengatasi carian terbalik dan kekal
sehingga anda menggerakkan peta sendiri — menggerakkan peta dengan tangan
bermakna anda membatalkan pilihan itu, jadi carian terbalik disambung
semula.


---

# v53 — jarak jalan SEBENAR, 5 kenderaan, minimum lori, planner terus

Suite baru test/routing.mjs: 18 ujian. Jumlah 575 lulus, 0 gagal.
PERLU /setup: kolum tasks.route_method.

## 1. Jarak: garis lurus -> jalan raya sebenar (aduan Zaini, dan dia betul)

Jarak garis lurus MEMBAYAR KURANG setiap penghantaran. Dua titik 5 km
jarak burung terbang selalunya 7-9 km jalan sebenar sebaik dikira sungai,
jalan sehala, lebuh raya, dan hakikat kawasan perumahan Malaysia jarang
bersambung terus. Partner yang bakar minyak dan masa itu; mengharga pada
nombor burung terbang secara senyap memindahkan bezanya dari dia kepada
pelanggan.

Kini jarak diukur oleh penghala jalan sebenar (OSRM). Bila penghala tidak
dapat menjawab, kita TIDAK jatuh ke garis lurus mentah — itu nombor tidak
adil yang sedang kita hentikan. Sebaliknya faktor circuity 1.35 dipakai
(nisbah terdokumentasi antara jarak jalan dan garis lurus di kawasan
berbandar), yang tersilap sedikit MEMIHAK partner, bukan platform.

route_method disimpan ("road" atau "estimated") supaya partner yang
mempertikaikan tambang boleh diberitahu dengan tepat yang mana, bukan
diminta menebak.

Pengiraan di SERVER kekal satu-satunya kebenaran; app memanggil penghala
yang sama supaya nombor di depan pelanggan ialah nombor yang membina
tambang.

Ujian menstub fetch, jadi laluan OSRM sebenar BENAR-BENAR diuji (dulu CI
hanya menguji laluan sandaran), dan ia tidak lagi goyah bergantung
rangkaian. Jawapan buruk ditolak: laluan jalan yang lebih PENDEK dari
garis lurus tidak dipercayai.

## 2. Kenderaan mengikut kategori

  Delivery  motor, kereta, 4x4, van
  Moving    lori sahaja

Lori tidak boleh ditempah untuk delivery, motosikal tidak boleh ditempah
untuk moving — dikuatkuasakan di server, bukan hanya disembunyikan di UI.

Harga naik ikut saiz: motor RM4+RM1.00/km, kereta RM5+RM1.50/km,
4x4 RM8+RM2.00/km, van RM10+RM2.50/km, lori RM20+RM3.00/km.

## 3. Minimum RM60 untuk lori

Kerja lori tidak pernah berbaloi dipetik RM8 walau sependek mana
perjalanan — pemandu tetap perlu memuat, mengikat, memandu dan
memunggah. min_cents ialah LANTAI pada cadangan. Kenderaan kecil tiada
minimum. Kesemuanya boleh ditala dalam control panel (kini 15 tetapan:
asas, per-km dan minimum untuk lima kenderaan).

## 4. "Plan route on map" terus

Tekan tile Delivery atau Moving -> planner terus terbuka. Untuk kategori
ini laluan ITULAH pesanan; memaksa orang menggulung borang untuk mencari
butang peta adalah geseran tanpa sebab. Ia terbuka sekali sahaja setiap
lawatan, bukan setiap render.

## 5. Foto boleh dimuat naik dalam halaman peta juga

Bahagian foto ditambah dalam planner. Tile yang sama berfungsi dari
kedua-dua tempat — ia mengesan input mana yang ada di skrin.

## Dua bug yang assert DOM tangkap

- rbConfirm membaca jarak SELEPAS menutup planner, dan penutupan itu
  mengosongkan keadaan — jadi 0 km dibawa masuk ke borang secara senyap.
  Kini semua nilai dibaca sebelum ditutup.
- (ujian saya sendiri) selector .vgrid terlalu luas sebab kini ada DUA
  grid kenderaan, satu dalam planner satu dalam borang.


---

# v54 — ikon 3D Zaini dipasang

App sahaja. 575 ujian server kekal hijau; 13 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## Latar belakang dibuang, jadi tiada tile diperlukan

Zaini menghantar lapan ikon 3D yang dia crop sendiri. Ia TIADA lutsinar —
latarnya warna pepejal ~#E8EFFB. Dia berkata jika warna itu tidak dapat
dipadankan dengan latar app, jadikan tile semula.

Ia tidak perlu jadi tile: latar dibuang sepenuhnya, jadi ikon terapung di
atas apa-apa permukaan.

Cara ia dibuang: flood-fill dari TEPI sahaja. Piksel terang DI DALAM ikon
(buih putih pada baldi, badan aircon putih) tidak pernah dicapai kerana ia
tidak bersambung ke tepi melalui warna latar. Sudut disahkan alpha 0.

## Satu kesilapan algoritma yang ditangkap pertengahan kerja

Percubaan pertama melembutkan tepi berdasarkan JARAK WARNA dari latar. Itu
merosakkan ikon paip — paip itu perak kebiruan, warnanya hampir sama dengan
latar, jadi sebahagian paip menjadi separa lutsinar (592 piksel terjejas).
Dibetulkan: pelembutan kini hanya pada piksel yang BERSEBELAHAN dengan latar
yang dibuang, bukan mana-mana piksel yang kebetulan sewarna. Selepas itu
piksel separa-lutsinar yang salah turun ke 0-2 pada kesemua lapan.

## Saiz dinormalkan

Setiap ikon dicrop berbeza, jadi baldi akan nampak jauh lebih besar dari
mentol jika dipasang terus. Setiap satu kini dipangkas kepada artwork
sebenar, kemudian diskala supaya jejak visualnya SAMA. Ada assert yang
mengesahkan kelapan-lapan dirender pada lebar yang sama.

## Format dipilih ikut ukuran, bukan agakan

  webp q90       50K   tetapi 3-10% piksel kelihatan terjejas >25
  webp q95       59K   hampir tiada beza (97 -> 95) — jadi bukan isu kualiti
  webp lossless 156K   sifar kerosakan
  png           189K   sifar kerosakan

Dipilih WebP LOSSLESS: kualiti sempurna, masih 18% lebih kecil dari PNG.
Untuk imej yang menjadi identiti visual app dan hanya dimuat turun sekali
(service worker menyimpannya), 100K bukan harga yang berbaloi ditukar
dengan 10% piksel rosak.

## Sandaran

CAT_ART menyenaraikan kategori yang ADA artwork. Kategori tanpa artwork
kekal menggunakan glif SVG yang dilukis, jadi menambah kategori kesembilan
tidak akan meninggalkan ikon pecah.


---

# v55 — My Tasks CRASH dibaiki, reorder, route mode, search ketara

App sahaja. 572 ujian server kekal hijau; 26 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## 1. "My Task macam tak function" — ia memang CRASH

Bug sebenar, dan teruk. Kad tugas membaca t.bids[t.accepted].p terus untuk
apa-apa status yang bukan "open" dan bukan "inprogress". Tugas yang
DIBATALKAN mempunyai accepted = null, jadi bacaan itu melontar ralat dan
menjatuhkan SELURUH skrin My Tasks — bukan satu kad, semuanya. Sesiapa
yang pernah membatalkan satu tugas akan nampak tab itu mati.

Kini semua cabang melalui satu fungsi yang MENYEMAK bida diterima itu
wujud dahulu. Tugas dibatalkan mendapat papar "Cancelled" yang betul,
dengan nama partner jika ada seorang, tanpa jika tiada.

Ini juga menerangkan kenapa ia berkait dengan permintaan cancel/reorder
Zaini — kedua-duanya bermula dari keadaan yang sama.

## 2. Reorder selepas batal

Pembatalan selalunya bersebab keadaan: salah hari, partner tak jadi,
rancangan berubah. Memaksa orang menaip semula segalanya ialah geseran
yang menghantar kerja itu kepada panggilan telefon.

"Post again" pada tugas dibatalkan membuka borang BARU yang sudah terisi:
tajuk, kategori, bandar, alamat, pin, bajet, butiran, destinasi dan
kenderaan. Tugas ASAL tidak disentuh — rekod pembatalan dan jejak auditnya
kekal utuh.

TARIKH sengaja TIDAK disalin. Tarikh lama sudah berlalu, dan menyalinnya
secara senyap ialah bagaimana kerja tersiar untuk hari yang sudah lepas.
Toast memberitahu supaya tarikh disemak.

## 3. Route mode kembali ke peta

v51 membuang peta dari pembina laluan sepenuhnya untuk menghapuskan
kekeliruan "pin mana saya pegang". Itu berjaya, tetapi ia juga menghapuskan
keupayaan MELIHAT laluan langsung.

Kini ada peta ikhtisar di atas senarai: pin A hijau, destinasi bernombor,
garisan antara semuanya. Ia BACA SAHAJA — tiada apa boleh diseret, jadi
kekeliruan lama tidak kembali bersamanya. Peta yang MENGUBAH satu titik
kekal pemilih satu-titik. Ia tersembunyi sehingga ada destinasi pertama,
supaya skrin tidak bermula dengan peta kosong.

## 5. Ujian goyah dihapuskan (1 daripada 8 larian gagal)

Ditemui semasa menyediakan pakej ini, bukan dilaporkan. Satu assert KYC
mencari "12 digit berturut" di SELURUH baris sebagai bukti nombor IC penuh
tidak disimpan. Tetapi kunci dokumen mengandungi hex rawak, dan sekali
sekala 12 aksara hex itu kebetulan semuanya digit — jadi assert gagal
secara rawak. Kod tidak pernah salah; ujian itu yang salah.

Kini ia menyemak MEDAN yang boleh memegang IC, bukan regex membuta atas
keseluruhan baris. Disahkan 15 larian berturut-turut tanpa gagal.

## 4. Butang search yang Zaini tercari-cari

Puncanya ditemui: kawalan zoom Leaflet lalai ke penjuru ATAS KIRI —
tempat yang SAMA dengan bar carian, jadi kedua-duanya bertindih dan
carian itu terbaca sebagai sebahagian perabot peta.

Kawalan zoom dimatikan (telefon cubit untuk zum), dan bar carian dibesarkan
dengan sempadan biru, ikon lebih besar, teks Melayu, serta baris contoh di
bawahnya: "Cth. KLCC, Mid Valley, Hospital Sultanah Aminah". Contoh itu
hilang sebaik anda mula menaip.


---

# v56 — peta laluan skrin penuh: seret pin, tambah pin

App sahaja. 572 ujian server kekal hijau; 24 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## Peta ikhtisar kini boleh dibuka penuh

Tap peta di atas senarai (atau butang kembang) -> peta skrin penuh yang
BOLEH DIUBAH, bukan sekadar dilihat.

## Pin boleh diseret — dan kali ini ia tidak mengelirukan

v46 ada pin boleh seret dan Zaini kata ia mengelirukan. Kekeliruan itu
datang dari TIGA perkara khusus, bukan dari menyeret itu sendiri:
  - destinasi muncul pada kedudukan rawak yang tiada siapa minta
  - semua pin boleh diseret serentak tanpa maklum balas
  - tiada apa memberitahu pin MANA yang sedang dipegang

Ketiga-tiganya ditangani. Tiada apa ditambah tanpa ketukan yang jelas.
Sebaik sahaja pin disentuh, kad di bawah MENAMAKAN stop itu ("Drop-off 2")
dan menunjukkan alamatnya. Pin terpilih membesar. Senarai di belakang skrin
ini kekal sebagai rujukan, jadi sentiasa ada tempat untuk menyemak diri.

Selepas dilepaskan: alamat dicari semula, jarak diukur semula, tambang
dikemas kini — semuanya di tempat, tanpa meninggalkan peta.

## Tambah destinasi terus di peta

Dua cara:
  - "Add stop here" menjatuhkan pin di TENGAH peta (jadi anda gerakkan peta
    ke tempatnya dahulu, sama seperti pemilih satu-titik)
  - Cari nama tempat -> pilih -> ia terus menjadi destinasi seterusnya

Nama tempat yang dipilih dari carian ditandakan manual, jadi carian alamat
terbalik tidak akan menimpanya kemudian — pelajaran yang sama seperti v52.

## Bug yang assert DOM tangkap

Menyeret pin memanggil rbMeasure(), dan rbMeasure() merender semula SENARAI.
Dengan peta skrin penuh terbuka, itu bermakna peta digantikan dengan senarai
di tengah-tengah seretan — anda akan tercampak keluar setiap kali menggerakkan
pin. Kini rbRefreshView() menyegarkan pandangan yang SEDANG dipapar; peta dan
senarai ialah dua pandangan atas keadaan yang sama, jadi satu tidak boleh
menarik keluar yang satu lagi.


---

# v57 — peta interaktif untuk SEMUA kategori

App sahaja. 572 ujian server kekal hijau; 22 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## Kenapa ini patut ada dari awal

Penghantaran dapat peta penuh; cuci rumah dapat medan teks kosong. Tetapi
tukang cuci perlu MENCARI rumah itu sama seperti rider perlu mencari alamat
penghantaran. Tiada sebab kategori lain diberi layanan lebih rendah.

## Apa yang sama, apa yang beza

Sama seperti aliran penghantaran:
  - peta skrin penuh dengan pin BOLEH DISERET
  - carian nama tempat (dihadkan Malaysia, dicondongkan ke kawasan peta)
  - butang lokasi saya
  - medan tambahan untuk nombor unit, tingkat, mercu tanda
  - nama tempat yang DIPILIH dari carian mengatasi carian alamat terbalik
    sehingga pin digerakkan dengan tangan (peraturan sama seperti v52)

Bezanya, tepat seperti yang Zaini kata: TIADA destinasi. Tiada "Add stop",
tiada pemilih kenderaan, tiada tambang. Satu lokasi sahaja.

## Pratonton dalam borang

Setelah pin ditetapkan, borang menunjukkan peta kecil BACA SAHAJA dengan
pin itu dan label "Tap to adjust". Ia tersembunyi sehingga ada pin, supaya
borang tidak bermula dengan kotak kelabu kosong.

Baris status juga berhenti memaparkan koordinat mentah — ia kini menunjukkan
alamat sebenar, kerana "Jalan Damai, Taman Damai" memberitahu seseorang jauh
lebih banyak daripada "3.20000, 101.60000".

## Nota ujian

Satu assert gagal pada mulanya kerana ujian saya menunggu 600ms untuk carian
alamat yang baris giliriannya sengaja berjalan pada kadar 1.1 saat demi had
Nominatim. Ujian yang tidak sabar, bukan kod yang salah — masa menunggu
dibetulkan.


---

# v58 — ikon terpotong, masa jam & minit, pratonton peta tembus modal

App sahaja. 572 ujian server kekal hijau; 20 assert DOM baharu.
Tiada perubahan schema, tiada /setup.

## 1. Baris pertama ikon terpotong separuh

Skyline diletakkan position:absolute dengan z-index 0, dan itu menjadikannya
dilukis DI ATAS helaian kandungan yang statik. Ia menutup tajuk "Browse
categories" dan memotong baris atas ikon separuh jalan.

Kandungan kini dilukis di atas skyline, jadi tiada apa boleh dipotong lagi.
Padding header dikurangkan 64px ke 30px dan skyline dipendekkan 200px ke
172px, jadi helaian bermula lebih tinggi seperti diminta - lebih banyak
skrin digunakan, tanpa apa-apa terpotong. Ada assert yang membandingkan
kedudukan sebenar ikon terhadap sempadan skyline, bukan sekadar z-index.

## 2. Masa: dari "Petang" kepada jam sebenar

"Afternoon" ialah tetingkap empat jam. Tukang cuci yang merancang harinya
dan pelanggan yang menunggu di rumah kedua-duanya perlukan masa sebenar.

Kini input type=time dengan langkah 15 minit - telefon memberikan roda
pemilih jam miliknya sendiri, yang mengalahkan apa-apa kawalan buatan
sendiri. Disimpan sebagai "2:30pm", format yang pelanggan baca pada kad
tugas dan partner baca pada kad yang sama.

"Flexible" kekal ada, tetapi sebagai TANDA yang disengajakan, bukan pilihan
pertama dalam senarai. Sebagai pilihan dropdown ia menjadi jawapan lalai
untuk kebanyakan orang, dan kedua-dua pihak berakhir tidak tahu bila hendak
muncul.

## 3. Peta kecil tembus atas peta penuh

Bug sebenar dengan punca yang jelas. Leaflet meletakkan panelnya pada
z-index 200-700 dan kawalannya pada 800+. Modal kita berada pada 70. Jadi
peta pratonton yang hidup di dalam BORANG dilukis terus di atas peta skrin
penuh yang berada di atasnya.

modal-host kini mempunyai konteks susunannya sendiri pada z-index 2000,
di atas apa-apa yang Leaflet guna. Sebagai langkah kedua, pratonton itu
DIBUANG sepenuhnya semasa peta penuh dibuka - dua peta Leaflet hidup
merebut satu skrin ialah pembaziran walaupun susunannya betul - dan
dibina semula selepas ditutup, menunjukkan di mana pin berakhir.


---

# v59 - Xendit: get keselamatan komisen, /pay/return, kejujuran UI

Zaini minta terus ke production dengan kunci sebenar TANPA sahkan dulu
dengan Xendit sama ada FPX sokong authorize-then-capture. Sebelum tulis
kod, saya cari dahulu - dan jumpa sesuatu yang lebih penting dari soalan
FPX itu sendiri.

## Penemuan 1: FPX - kod sudah selamat secara semula jadi

channel_code sudah HARD-CODE "CARDS" sejak awal; FPX tidak pernah
disambungkan di mana-mana bahagian app. Dokumentasi Stripe (penyedia
lain, rel FPX yang sama) nyatakan terus terang "Manual capture support:
No" untuk FPX - ciri rel itu sendiri (pindahan bank terus, tiada
mekanisme tahan), bukan had khusus satu penyedia. SUPPORTED_CHANNELS
kini eksplisit dalam kod sebagai satu senarai dengan satu kemasukan,
supaya menambah kenderaan bayaran baharu ialah KEPUTUSAN yang disemak,
bukan sekadar tukar satu string.

## Penemuan 2 (LEBIH PENTING): Split Payments bukan self-service untuk Malaysia

Dokumentasi Xendit sendiri: ciri ini automatik untuk Indonesia dan
Filipina, tetapi untuk Thailand, Malaysia dan Vietnam MESTI hubungi
Xendit untuk mengaktifkannya pada akaun terlebih dahulu.

Ini bermakna kalau Zaini isi XENDIT_SECRET_KEY sekarang tanpa
mengaktifkan ciri ini dahulu: partner yang sudah ada sub-akaun xenPlatform
akan menerima BAYARAN PENUH, dan komisen platform TIDAK PERNAH diambil -
secara SENYAP, bukan transaksi yang gagal. Ini bukan bug kecil, ini
seluruh model pendapatan Berespro boleh bocor sehingga penyata bulanan
tanpa sesiapa perasan.

## Get keselamatan dibina

authorizePayment() kini MENOLAK secara terus (kod ralat
split_rule_missing) jika kunci sebenar aktif, partner ada sub-akaun
Xendit, tetapi XENDIT_SPLIT_RULE_ID belum diisi. Ditapis melalui
/bids/:id/accept sebagai 503 yang jelas ("Payments are not fully
configured yet"), bukan 500 generik yang kelihatan seperti crash.

Diuji khusus: get menolak keadaan bahaya, TIDAK menolak partner tanpa
sub-akaun (masalah berbeza, bukan kebocoran senyap), dan terbuka semula
sebaik split rule diisi. Disahkan hujung-ke-hujung melalui laluan
/bids/:id/accept sebenar, bukan hanya fungsi psp.js secara berasingan.

## /pay/return kini wujud

Sebelum ini TIDAK dikendalikan oleh worker mahupun app - customer yang
selesai bayar sebenar akan sampai ke 404. Kini satu halaman pendaratan
yang bergraya, tanpa auth (Xendit ubah hala PELAYAR customer, bukan
panggilan app yang disahkan), memaparkan mesej berbeza untuk berjaya dan
gagal. Ia TIDAK mengemas kini apa-apa - app tetap tinjau status bayaran
secara berasingan, keputusan sedia ada Zaini bahawa redirect terlalu
rapuh untuk dipercayai membawa keadaan.

## Kejujuran UI

Skrin "Payment Methods" mendakwa "Cards, banking & e-wallets" sedangkan
cuma kad yang berfungsi. Tajuk kecil diperbetulkan kepada "Cards" sahaja.

## APA YANG ZAINI MASIH PERLU BUAT (bukan kod, tindakan sebenar)

1. HUBUNGI XENDIT untuk aktifkan ciri Split Payments bagi akaun Malaysia
   - tanpa ini, XENDIT_SPLIT_RULE_ID tidak boleh dicipta langsung.
2. Selepas diaktifkan, cipta split rule (peratusan komisen platform) dan
   masukkan ID ke XENDIT_SPLIT_RULE_ID dalam wrangler.toml.
3. Tanya Xendit sama ada FPX/e-wallet menyokong authorize-then-capture
   untuk akaun ini - tidak menghalang go-live kad sekarang, tetapi
   diperlukan sebelum kaedah bayaran lain ditambah.
4. Set XENDIT_SECRET_KEY dan XENDIT_CALLBACK_TOKEN sebagai Secret dalam
   Cloudflare (bukan wrangler.toml).
5. PUBLIC_URL dalam wrangler.toml hanya boleh diisi selepas HTTPS
   app.berespro.my disediakan - masih blocker berdiri yang sama.
6. Daftar webhook URL (/webhooks/psp) dalam papan pemuka Xendit.

## Pengesahan

12 ujian baharu (4 get keselamatan, 8 /pay/return) + pengesahan hujung-
ke-hujung melalui laluan bid-accept sebenar. Ujian PSP sedia ada yang
sudah lulus (partnerMerchantId=null, tiada split rule) disahkan masih
lulus - get tidak menyentuh laluan yang memang selamat. 3 larian
berturut-turut bersih.


---

# v60 - bug logo Berespro sebenar ditemui dan dibaiki

App sahaja. Semua ujian server kekal hijau. Tiada perubahan schema, tiada /setup.

## Bug production sebenar, tersembunyi selama ini

Zaini kata mockup skrin selamat datang yang saya bina "buruk" dengan "crop
hitam yang tak kemas" pada logo. Saya siasat secara pengiraan piksel, bukan
tekaan mata.

Logo <img> dalam app diberi border-radius:19px tanpa overflow:hidden.
Ujian Chromium sebenar (logo diletak atas latar merah terang, piksel
sudut disampel terus) membuktikan: sudut logo pada koordinat 1px dari
tepi (jauh dalam lengkung 19px yang patut dipotong) masih RGB(11,21,38)
PEJAL - iaitu border-radius LANGSUNG TIDAK memotong kandungan imej.
Ini gotcha CSS yang dikenali: border-radius pada <img> tanpa
overflow:hidden tidak memotong piksel raster.

PNG asal (144x144, mod RGB, TIADA alpha channel) memang segiempat penuh
dengan latar navy pejal mengelilingi ikon bulat. Ia kelihatan sempurna
dalam production KERANA latar app sentiasa navy #0B1526 yang tepat sama -
kotak segiempat tersembunyi dengan sempurna. Bug ini akan muncul pada
apa-apa latar lain (mod terang, bahan pemasaran, senarai app store) - dan
muncul dalam mockup saya kerana saya letak atas latar berbeza tanpa
menyemak dahulu.

## Pembetulan

PNG asal ditopeng dengan bucu bulat SEBENAR (radius 39px atas 144px,
nisbah sama seperti border-radius:19px/70px asal) menggunakan alpha
channel tulen, bukan bergantung pada CSS untuk memotong. Disahkan dua
kali: pertama atas latar merah ujian (semua sudut alpha=0), kemudian
dalam konteks halaman sebenar (masih alpha=0). Logo baharu menggantikan
yang lama dalam app/index.html - satu-satunya kemunculan, kini bersih.

## Mockup dibina semula

Skyline langit terang yang dipakai sebagai latar hero dibuang sepenuhnya
- artwork itu direka sebagai jalur pendek untuk header home screen, dan
diregangkan menjadi hero penuh ia nampak kosong/janggal, bukan premium
seperti yang dijangka. Latar navy production yang sedia ada (dengan
gradient radial lembut, bukan langit) dikekalkan. Dua variant ditawarkan:
senyap tanpa chip, atau dengan baris kategori guna ikon 3D sebenar dalam
kad gelap sepadan tema.

Disahkan 6 semakan termasuk ujian ALPHA SEBENAR logo dalam konteks
halaman (bukan hanya dalam ujian berasingan) - membuktikan pembetulan
benar-benar berkesan, bukan sekadar lulus dalam makmal berasingan.


---

# v61 - pembetulan v60 didapati TAK LENGKAP, dibetulkan sepenuhnya

App sahaja. Semua ujian server kekal hijau. Tiada perubahan schema, tiada /setup.

## Zaini hantar screenshot sebenar dari telefon - kotak hitam masih ada

Pembetulan v60 (topeng bucu bulat atas keseluruhan kanvas 144x144) cuma
membuang SUDUT kanvas. Ia tidak membuang JALURAN NAVY antara sudut bulat
itu dengan grafik ikon sebenar - ikon warna (gradient teal->biru + glyph
putih) cuma menduduki x=28-130, y=16-120 dalam kanvas 144x144, meninggalkan
margin 13-28px navy di sekeliling yang masih legap sepenuhnya.

Disahkan dengan mengukur sempadan grafik berwarna berbanding kanvas penuh
- bukan tekaan kali ini, ukuran terus.

## Pembetulan sebenar: buang latar, bukan bulatkan bucu

Digunakan teknik SAMA yang terbukti berkesan untuk lapan ikon kategori 3D
(v54): flood-fill dari TEPI kanvas sahaja, membuang semua piksel navy yang
BERSAMBUNG ke tepi, dengan feather bersempadan supaya warna dalaman ikon
(gradient biru gelap) tidak turut terkorban. Hasil: 50.3% kanvas dibuang
(berbanding pembetulan v60 yang cuma bulatkan sudut, tanpa membuang jaluran
tengah).

## Pengesahan kali ini lebih ketat

Bukan sekadar semak 4 sudut (yang menipu - lulus dalam v60 walaupun bug
sebenarnya masih ada). Kini semak SETIAP piksel sepanjang keempat-empat
sisi perimeter kanvas - 0 daripada 576 piksel perimeter yang diuji masih
legap. Disahkan khusus dalam palet Daylight (latar terang yang sama macam
screenshot Zaini) kerana itulah konteks yang mendedahkan bug ini.


---

# v62 - animasi masuk untuk skrin selamat datang

App sahaja. Semua ujian server kekal hijau. Tiada perubahan schema, tiada /setup.

## Satu pergerakan yang diatur, bukan hiasan bertaburan

Ikut panduan reka bentuk sendiri: gerakan berlebihan salah satu tanda paling
jelas "buatan AI". Jadi ini SATU jujukan masuk yang teratur, bukan animasi
berterusan/gelung yang boleh terasa bising.

Turutan (~750ms keseluruhan, pantas sengaja supaya tidak terasa melengahkan
log masuk):
  1. Logo - timbul dengan skala (pop), paling awal
  2. Wordmark "berespro" - naik + pudar masuk
  3. Eyebrow + tagline - sama serentak
  4. Kad kategori - naik + pudar
  5. Butang "Continue with Google" - naik terakhir, menarik perhatian ke
     tindakan utama
  6. Pautan bawah - pudar paling akhir

## Lantai kualiti: prefers-reduced-motion dihormati

Sesiapa yang set OS mereka untuk kurangkan gerakan terus nampak semua
elemen serta-merta, tiada animasi langsung - bukan pilihan, ini keperluan
asas kebolehcapaian.

## Pengesahan

8 assert: keadaan awal (elemen belum kelihatan), keadaan akhir selepas
900ms (SEMUA mendarat pada opacity 1 - bug animasi biasa ialah terlupa
forwards fill-mode dan elemen kekal lutsinar selepas keyframe tamat),
turutan (logo kelihatan sebelum butang pada 200ms), dan
prefers-reduced-motion (semua terus kelihatan tanpa tunggu).

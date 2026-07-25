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

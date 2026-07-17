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

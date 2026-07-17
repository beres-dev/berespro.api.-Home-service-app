# Berespro App (frontend)

SATU sumber kebenaran: `index.html`. Fail duplicate `berespro-app.html`
telah DIBUANG (v27) sebab dua salinan yang disync tangan adalah punca
drift senyap. Kalau nampak fail tu masih ada di GitHub, padam:
buka fail -> ikon tong sampah -> commit.

Isi folder ni = build PWA untuk Netlify Drop:
  index.html, sw.js, manifest.webmanifest, fonts/, icons/

Deploy: drag isi folder ni (kecuali README.md) ke app.netlify.com/drop.
Selepas deploy: DevTools > Application > Service Workers > Unregister,
kemudian hard refresh. Naikkan CACHE version dalam sw.js setiap kali
logik app berubah.

Ujian integrasi (test/app-integration.mjs) membaca index.html ini terus,
jadi lapisan API app diuji terhadap Worker sebenar pada setiap push.

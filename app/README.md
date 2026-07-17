# Berespro App (frontend)

Dua versi kod yang SAMA, dua sasaran berbeza:

- `berespro-app.html` — versi satu-fail, guna Google Fonts CDN. Untuk buka
  terus / kongsi cepat.
- `index.html` + `sw.js` + `manifest.webmanifest` + `fonts/` + `icons/` —
  build PWA untuk Netlify Drop. Font local, boleh install, jalan offline.

⚠️ Bila ubah logik app, ubah KEDUA-DUA fail. Tiada langkah build yang
menjana satu dari satu lagi.

Deploy: drag isi folder ni (kecuali berespro-app.html + README.md) ke
app.netlify.com/drop.

Versi semasa: v23. Lihat CHANGELOG_v23.md di root repo.

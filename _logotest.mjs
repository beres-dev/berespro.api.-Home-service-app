import { chromium } from 'playwright-core';
import fs from 'fs';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const logo = fs.readFileSync('/home/claude/welcome-mock/logo.txt','utf8');
const b = await chromium.launch({ executablePath: CHROME, args:['--no-sandbox','--disable-gpu'] });
const page = await (await b.newContext({ viewport:{width:300,height:300}, deviceScaleFactor:2 })).newPage();
// Ujian ketat: letak logo (dengan border-radius sama macam app SEBENAR: 19px atas 70x70)
// atas latar MERAH TERANG supaya apa-apa segi empat gelap yang bocor jadi jelas
// secara pengiraan, bukan sekadar mata.
await page.setContent(`<body style="margin:0;background:#FF0000;padding:40px">
  <img id="logo" src="${logo}" style="width:70px;height:70px;border-radius:19px;display:block">
</body>`);
await page.waitForTimeout(300);

const result = await page.evaluate(() => {
  const img = document.getElementById('logo');
  const r = img.getBoundingClientRect();
  const c = document.createElement('canvas');
  c.width = Math.round(r.width); c.height = Math.round(r.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const corner = (x,y) => { const d = ctx.getImageData(x,y,1,1).data; return [d[0],d[1],d[2],d[3]]; };
  return {
    naturalSize: [img.naturalWidth, img.naturalHeight],
    renderedSize: [r.width, r.height],
    topLeft: corner(1,1), topRight: corner(c.width-2,1),
    botLeft: corner(1,c.height-2), botRight: corner(c.width-2,c.height-2),
    centre: corner(Math.round(c.width/2), Math.round(c.height/2)),
  };
});
console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path:'/tmp/logo-on-red.png' });
await b.close();

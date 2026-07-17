// Jalankan SEMUA suite, berhenti pada kegagalan pertama, exit code betul
// untuk CI. Guna: node test/run-all.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(dir).filter(f => f.endsWith('.mjs') && f !== 'run-all.mjs' && f !== 'mockdb.mjs').sort();
let failed = 0;
for (const f of suites) {
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`\n\u2717 SUITE FAILED: ${f}`); break; }
}
console.log(failed ? '\n=== TESTS FAILED ===' : '\n=== ALL SUITES PASSED ===');
process.exit(failed ? 1 : 0);

// GUARD: src/schema_sql.js must match schema.sql exactly. This drift once
// shipped a schema_sql.js missing the coverage and messages tables, which would
// have broken chat and coverage in production while every test passed. Never
// again: CI fails here if the two sources disagree.
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import SCHEMA from '../src/schema_sql.js';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(join(root, 'schema.sql'), 'utf8');
let pass=0, fail=0;
const ok=(n,c)=>{ c?(pass++,console.log("  \u2713",n)):(fail++,console.log("  \u2717",n)); };

// Every CREATE TABLE / ALTER in schema.sql must be present in the bundled copy.
const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m=>m[1]);
for (const t of tables) ok(`table ${t} present in bundle`, SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${t}`));
const alters = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)];
for (const [,t,c] of alters) ok(`migration ${t}.${c} present in bundle`, SCHEMA.includes(`ADD COLUMN ${c}`));

// And the reverse: the bundle must contain nothing schema.sql doesn't. The
// cheapest exact check is that the normalized contents match.
const norm = s => s.replace(/\r/g,'');
const bundleInner = SCHEMA;  // the default export is the SQL text itself
ok("bundle SQL equals schema.sql (byte-for-byte, normalized)", norm(bundleInner) === norm(sql));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) console.log("Run: node test/gen-schema.mjs  to regenerate the bundle.");
process.exit(fail?1:0);

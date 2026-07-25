// Regenerate src/schema_sql.js from schema.sql (the single source of truth).
// Run: node test/gen-schema.mjs   (or npm run gen:schema)
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(join(root, 'schema.sql'), 'utf8');
const esc = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const out = '// Auto-generated from schema.sql. Do not edit here; edit schema.sql and\n' +
            '// run `npm run gen:schema` (test/gen-schema.mjs). CI fails if this drifts.\n' +
            'export default `' + esc + '`;\n';
fs.writeFileSync(join(root, 'src/schema_sql.js'), out);
console.log('schema_sql.js regenerated from schema.sql');

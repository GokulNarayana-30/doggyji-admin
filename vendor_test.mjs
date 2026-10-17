import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('./vendor/integrity.json',import.meta.url)));
for(const [file,hash] of Object.entries(manifest)) {
 assert.equal('sha384-'+createHash('sha384').update(readFileSync(new URL('./vendor/'+file,import.meta.url))).digest('base64'),hash);
 assert.ok(html.includes(`src="vendor/${file}" integrity="${hash}"`));
}
assert.ok(!/<script[^>]+src="https?:/i.test(html));
assert.ok(!/<script>/.test(html));
assert.ok(html.includes("script-src 'self'"));
console.log('Portal vendor integrity and script policy checks passed');

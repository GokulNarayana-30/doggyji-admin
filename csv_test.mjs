import assert from 'node:assert/strict';
import './csv.js';
for (const text of ['=1+1', '+12345', '-1+1', '@SUM(A1)', '\t=cmd()', ' \r=1']) {
  assert.ok(globalThis.csvCell(text).startsWith('"\''), text);
}
assert.equal(globalThis.csvCell(-10), '-10');
assert.equal(globalThis.csvCell('a,"b"'), '"a,""b"""');
console.log('CSV export: 8 safe text/number cases passed');

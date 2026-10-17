// Exercises the portal's actual enrollment/challenge/entry functions with no network.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  async function enter('), source.indexOf("  $('#signInForm').addEventListener"));
function harness({ verified = false, aal = 'aal1', inactive = false, temp = false, requireMfa = true } = {}) {
  const nodes = new Map(); const calls = []; let mode;
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: false,
      focus() {}, removeAttribute(k) { delete this[k]; }, addEventListener(name, fn) { this[name] = fn; } });
    return nodes.get(id);
  };
  const me = { staff: null, perms: new Set() };
  const auth = {
    getUser: async () => ({data:{user:{id:'staff-id', app_metadata: temp ? {must_change_password:true} : {}}}}),
    signOut: async () => calls.push('signOut'),
    mfa: {
      getAuthenticatorAssuranceLevel: async () => ({data:{currentLevel:aal}}),
      listFactors: async () => ({data:{totp: verified ? [{id:'verified',status:'verified'}] : [], all:[{id:'abandoned',status:'unverified',factor_type:'totp'}]}}),
      unenroll: async ({factorId}) => { calls.push(`unenroll:${factorId}`); return {}; },
      enroll: async () => { calls.push('enroll'); return {data:{id:'new',totp:{secret:'LOCAL-TEST-SECRET',qr_code:'<svg />'}}}; },
      challengeAndVerify: async ({factorId,code}) => {
        calls.push(`verify:${factorId}`);
        if (code !== '123456') return {error:{message:'Invalid code'}};
        aal = 'aal2'; return {};
      },
    },
  };
  const sb = {auth, from(table) {
    calls.push(table);
    const data = table === 'admin_users' ? {id:'staff',status:inactive?'disabled':'active',role_id:'role'}
      : table === 'admin_roles' ? {name:'Test role'} : [{permission_id:'audit.view'}];
    const chain = { select() {return chain;}, eq() {return chain;}, maybeSingle: async () => ({data}),
      then(resolve) { return Promise.resolve({data}).then(resolve); } };
    return chain;
  }};
  const context = vm.createContext({ sb, $, me, Date, Set, encodeURIComponent, REQUIRE_STAFF_MFA: requireMfa,
    showAuth: (value) => {mode=value; $('#app').hidden=true;}, toast: (v) => calls.push(v),
    titleCase: (s) => s, location:{hash:'#/home'}, route(){}, firstView:()=> 'home',
    buildNav:()=>calls.push('buildNav'), auditClient:()=>{}, refreshCounts:()=>{}, signOut:()=>auth.signOut(),
  });
  vm.runInContext(code, context);
  return {context, $, calls, me, mode:()=>mode, enter:()=>vm.runInContext('enter(true)',context)};
}
let h=harness(); await h.enter();
assert.equal(h.mode(),'mfa');
assert.deepEqual(h.calls,['admin_users','unenroll:abandoned','enroll']);
assert.equal(h.$('#mfaSecret').textContent,'LOCAL-TEST-SECRET');
assert.ok(h.$('#mfaQr').src.startsWith('data:image/svg+xml;'));
assert.equal(h.me.staff,null);
console.log('PASS first enrollment blocks privileged reads and only cleans unverified factors');
h.$('#mfaCode').value='000000';
await h.$('#mfaForm').submit({preventDefault(){}});
assert.equal(h.me.staff,null); assert.ok(!h.calls.includes('admin_role_permissions'));
console.log('PASS invalid code cannot enter portal');
h.$('#mfaCode').value='123456';
await h.$('#mfaForm').submit({preventDefault(){}});
assert.ok(h.calls.includes('admin_role_permissions')); assert.ok(h.calls.includes('buildNav'));
assert.equal(h.$('#mfaSecret').textContent,''); assert.equal(h.$('#mfaQr').src,undefined);
console.log('PASS valid challenge upgrades session before privileged reads and clears setup secret');
h=harness({verified:true}); await h.enter();
assert.ok(!h.calls.includes('enroll')); assert.equal(h.$('#mfaSetup').hidden,true);
h.$('#mfaCode').value='123456'; await h.$('#mfaForm').submit({preventDefault(){}});
assert.ok(h.calls.includes('verify:verified'));
console.log('PASS returning staff challenge existing verified factor');
h=harness({aal:'aal2'}); await h.enter(); assert.ok(h.calls.includes('buildNav'));
assert.ok(!h.calls.includes('enroll')); console.log('PASS existing aal2 session opens portal');
h=harness({inactive:true,aal:'aal2'}); await h.enter();
assert.ok(h.calls.includes('signOut')); assert.ok(!h.calls.includes('buildNav'));
console.log('PASS inactive staff denied despite aal2');
h=harness({temp:true}); await h.enter(); assert.equal(h.mode(),'set-password');
assert.ok(!h.calls.includes('admin_role_permissions')); console.log('PASS temporary password bootstrap exposes no privileged data');
// While staff two-factor is switched off (owner, 17 Oct 2026): a password
// session opens the portal with no enrollment, and inactive staff are still out.
h=harness({requireMfa:false}); await h.enter();
assert.ok(h.calls.includes('buildNav')); assert.ok(!h.calls.includes('enroll')); assert.notEqual(h.mode(),'mfa');
console.log('PASS with two-factor off, an active staff password session opens the portal');
h=harness({requireMfa:false,inactive:true}); await h.enter();
assert.ok(h.calls.includes('signOut')); assert.ok(!h.calls.includes('buildNav'));
console.log('PASS with two-factor off, inactive staff are still denied');

/**
 * DoggyJi Admin Portal.
 *
 * Plain script, no build step: index.html + style.css + this file are the
 * whole site (published from the doggyji-admin repo to GitHub Pages and
 * Netlify).
 *
 * Security model, in short:
 *  - Sign-in is Supabase Auth. Being signed in proves who you are, not that
 *    you are staff: the admin_users row linked to the login (auth_user_id)
 *    decides that, and its role decides what you may do.
 *  - Reads go straight to Supabase and are limited by row level security
 *    (is_admin() / admin_has()), so hiding a menu item here is convenience,
 *    not protection.
 *  - Every write goes through the admin-action edge function, which checks
 *    the permission again and writes the audit row itself.
 *  - Everything from the database is escaped with esc() before it goes into
 *    HTML: names, reasons and notes are typed by app users. Buttons carry ids
 *    in data attributes and are wired by one delegated click handler; no
 *    inline event handler is ever built from a value (see escaping_test.mjs).
 */
'use strict';

(() => {
  // ── Configuration ──────────────────────────────────────────────────────────
  // Opened from this computer (localhost) the portal talks to the STAGING
  // project, so staff features can be tried on test data; the published site
  // (GitHub Pages / Netlify) always uses production. Since 1 Oct 2026
  // production is the Mumbai project and staging the former Sydney one.
  const IS_STAGING = ['localhost', '127.0.0.1'].includes(location.hostname);
  const SUPABASE_URL = IS_STAGING
    ? 'https://iythfpzwxrbvxfmutxai.supabase.co'
    : 'https://jyzyvwdwcrgbtxfqcscg.supabase.co';
  const SUPABASE_KEY = IS_STAGING
    ? 'sb_publishable_gELA10B-jQjVy_eYK2QBTQ_1OERZEOt'
    : 'sb_publishable_089uZjQk0lF9GI7Nfb9mFA_QhgM4kur';
  if (IS_STAGING) {
    document.title = `STAGING · ${document.title}`;
    document.documentElement.dataset.env = 'staging';
  }
  const LIST_LIMIT = 300;

  // An invite or password-reset link lands here with its type in the URL
  // hash. Read it before the Supabase client consumes the hash.
  const landingHash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const landingType = landingHash.get('type');
  const landingQuery = new URLSearchParams(location.search);
  const landingError = landingHash.get('error_description') || landingQuery.get('error_description');

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    document.body.innerHTML = '<div class="state"><div class="ico">⚠️</div><h4>Could not load the admin portal</h4><p>A required script did not load. Check your connection and reload the page.</p></div>';
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });

  // ── Small helpers ──────────────────────────────────────────────────────────
  const esc = (v) => String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const $ = (sel, root = document) => root.querySelector(sel);

  /** Only https links from the database are used as src / href. */
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d)) return '—';
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  function fmtDateTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d)) return '—';
    return `${fmtDate(d)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function ago(v) {
    if (!v) return '—';
    const s = (Date.now() - new Date(v).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return fmtDate(v);
  }
  const money = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  const shortId = (id) => (id ? String(id).slice(0, 8) : '—');
  const titleCase = (s) => String(s ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
  }

  /** Friendly text for a failed read. */
  function readError(error) {
    const msg = String(error?.message || error || '');
    if (/permission|policy|42501/i.test(msg)) return 'Your role cannot see this.';
    if (/fetch|network/i.test(msg)) return 'Could not reach the server. Check your connection.';
    return 'Could not load this. Try again.';
  }

  /** Throws on a Supabase error, returns data otherwise. */
  async function q(builder) {
    const { data, error, count } = await builder;
    if (error) throw error;
    return count !== undefined && count !== null && data === null ? count : data;
  }

  async function countOf(table, apply = (b) => b) {
    const { count, error } = await apply(sb.from(table).select('*', { count: 'exact', head: true }));
    if (error) return null;
    return count ?? 0;
  }

  const badge = (text, tone = 'slate') => `<span class="badge b-${tone}">${esc(text)}</span>`;

  const STATUS_TONE = {
    open: 'red', reviewing: 'amber', actioned: 'green', dismissed: 'slate',
    pending: 'amber', approved: 'green', rejected: 'red', verified: 'green',
    confirmed: 'blue', completed: 'green', cancelled: 'slate',
    active: 'red', fulfilled: 'green', closed: 'slate', expired: 'slate',
    contacted: 'blue', donor_declined: 'slate', unreachable: 'amber',
    accepted: 'green', declined: 'slate',
    suspended: 'red', disabled: 'slate',
  };
  const statusBadge = (s) => badge(titleCase(s || 'unknown'), STATUS_TONE[s] || 'slate');

  function personCell(p, id, sub) {
    const name = p?.full_name || (p?.username ? `@${p.username}` : null) ||
      (id === 'deleted-user' ? 'Deleted account' : `User ${shortId(id)}`);
    const img = safeUrl(p?.avatar_url);
    const avatar = img
      ? `<img class="avatar" src="${esc(img)}" alt="" loading="lazy">`
      : `<span class="avatar">${esc(initials(name))}</span>`;
    const line2 = sub ?? (p?.username ? `@${p.username}` : (p?.email || ''));
    return `<div class="who">${avatar}<div style="min-width:0"><div class="cell-main">${esc(name)}</div>${line2 ? `<div class="cell-sub">${esc(line2)}</div>` : ''}</div></div>`;
  }

  /** Profiles for a set of user ids, as a map. Missing ids are simply absent. */
  async function profilesFor(ids) {
    const unique = [...new Set(ids.filter((i) => i && i !== 'deleted-user'))];
    const map = {};
    for (let i = 0; i < unique.length; i += 100) {
      const { data } = await sb.from('profiles')
        .select('id, full_name, username, email, phone, avatar_url, city, created_at')
        .in('id', unique.slice(i, i + 100));
      (data || []).forEach((p) => { map[p.id] = p; });
    }
    return map;
  }

  const loadingHtml = '<div class="card skeleton"><div></div><div></div><div></div><div></div><div></div></div>';
  const emptyHtml = (icon, title, text) =>
    `<div class="state"><div class="ico">${icon}</div><h4>${esc(title)}</h4><p>${esc(text)}</p></div>`;
  const errorHtml = (error) =>
    `<div class="card"><div class="state"><div class="ico">⚠️</div><h4>${esc(readError(error))}</h4><button class="btn btn-outline" data-action="refresh">Try again</button></div></div>`;

  function tabsHtml(viewId, key, options, current, counts = {}) {
    return `<div class="tabs">${options.map(([value, label]) =>
      `<button class="tab ${value === current ? 'active' : ''}" data-action="filter" data-id="${esc(`${viewId}|${key}|${value}`)}">${esc(label)}${counts[value] != null ? `<span class="n">${esc(counts[value])}</span>` : ''}</button>`,
    ).join('')}</div>`;
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── Session and permissions ────────────────────────────────────────────────
  const me = { staff: null, roleName: '', perms: new Set() };
  const can = (...perms) => perms.some((p) => me.perms.has(p));

  /** Calls the admin-action edge function. Resolves with its result or throws. */
  async function act(action, targetId, extra = {}) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error('Your session has expired. Sign in again.');
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/admin-action`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, targetId, ...extra }),
      });
    } catch (_) {
      throw new Error('Could not reach the server. Check your connection.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.reason || body.error || `Failed (${res.status})`);
    return body.result;
  }

  /**
   * Records sign-in / sign-out. Through admin-action, which takes the actor
   * from the login: the audit table accepts no rows from the browser, where
   * the actor could be anyone. Never fails the sign-in or sign-out itself.
   */
  function auditClient(eventName) {
    if (!me.staff) return Promise.resolve();
    return act(eventName, 'self').catch(() => {});
  }

  // ── Auth screens ───────────────────────────────────────────────────────────
  /** Why the set-password form is showing: 'invite', 'recovery' or 'temp'. */
  let setPasswordReason = null;

  function showAuth(mode, note) {
    setPasswordReason = mode === 'set-password' ? note : null;
    $('#app').hidden = true;
    $('#authScreen').hidden = false;
    $('#signInForm').hidden = mode !== 'signin';
    $('#forgotForm').hidden = mode !== 'forgot';
    if (mode === 'forgot') resetForgotForm();
    $('#setPasswordForm').hidden = mode !== 'set-password';
    $('#authSubtitle').textContent = {
      signin: 'Sign in with your staff account',
      forgot: 'Reset your password',
      'set-password': note === 'invite' ? 'Welcome — set your password'
        : note === 'temp' ? 'Choose your own password' : 'Set a new password',
    }[mode];
    if (mode === 'set-password') {
      $('#setPasswordNote').textContent = note === 'invite'
        ? 'You have been invited to the DoggyJi admin portal. Choose a password to finish setting up your account.'
        : note === 'temp'
          ? 'You signed in with a temporary password. Choose your own to continue; the temporary one then stops working.'
          : 'Choose a new password for your staff account.';
    }
  }

  async function enter(freshSignIn) {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { showAuth('signin'); return; }

    const { data: staff, error } = await sb.from('admin_users')
      .select('id, employee_id, full_name, email, role_id, status')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (error || !staff) {
      await sb.auth.signOut();
      showAuth('signin');
      toast('This account does not have staff access. Ask a Super Administrator to invite you.', 'error');
      return;
    }
    if (staff.status !== 'active') {
      await sb.auth.signOut();
      showAuth('signin');
      toast(`This staff account is ${staff.status}.`, 'error');
      return;
    }

    // Signed in with a temporary password (Create account / Reset password):
    // they choose their own before anything else. The server refuses every
    // other action until then, so this is not the only guard.
    if (user.app_metadata?.must_change_password) {
      const expires = Date.parse(user.app_metadata.temp_password_expires_at || '');
      if (!Number.isNaN(expires) && expires < Date.now()) {
        await sb.auth.signOut();
        showAuth('signin');
        toast('Your temporary password has expired. Ask a Super Administrator for a new one.', 'error');
        return;
      }
      showAuth('set-password', 'temp');
      return;
    }

    const [{ data: perms }, { data: role }] = await Promise.all([
      sb.from('admin_role_permissions').select('permission_id').eq('role_id', staff.role_id),
      sb.from('admin_roles').select('name').eq('id', staff.role_id).maybeSingle(),
    ]);
    me.staff = staff;
    me.perms = new Set((perms || []).map((p) => p.permission_id));
    me.roleName = role?.name || titleCase(staff.role_id);

    $('#meName').textContent = staff.full_name || staff.email;
    $('#meRole').textContent = me.roleName;
    $('#authScreen').hidden = true;
    $('#app').hidden = false;
    buildNav();
    if (freshSignIn) auditClient('session.signed_in');
    if (!location.hash.startsWith('#/')) location.hash = `#/${firstView()}`;
    else route();
    refreshCounts();
  }

  $('#signInForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#signInForm button[type=submit]');
    btn.disabled = true;
    try {
      const { error } = await sb.auth.signInWithPassword({
        email: $('#signInEmail').value.trim().toLowerCase(),
        password: $('#signInPassword').value,
      });
      if (error) {
        // Not distinguishing "no such account" from "wrong password": that
        // difference would tell an attacker which emails are staff.
        toast(/banned/i.test(error.message) ? 'This account is suspended.' : 'Incorrect email or password.', 'error');
        return;
      }
      $('#signInPassword').value = '';
      await enter(true);
    } catch (_) {
      toast('Could not sign in. Check your connection and try again.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Forgot password, by code. The project's "Reset password" email carries a
  // 6-digit code ({{ .Token }}), the same email the mobile app uses, so there is
  // no link to follow: step 1 sends the code, step 2 checks it (which signs the
  // person in for recovery) and opens the set-password form.
  let forgotCodeSent = false;

  function resetForgotForm() {
    forgotCodeSent = false;
    $('#forgotEmail').readOnly = false;
    $('#forgotCodeField').hidden = true;
    $('#forgotCode').value = '';
    $('#forgotCode').required = false;
    $('#forgotSubmit').textContent = 'Send code';
    $('#forgotNote').textContent = 'Enter your staff email. If it belongs to an account, we email you a 6-digit code to set a new password.';
  }

  $('#forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#forgotSubmit');
    const email = $('#forgotEmail').value.trim().toLowerCase();
    btn.disabled = true;
    try {
      if (!forgotCodeSent) {
        const { error } = await sb.auth.resetPasswordForEmail(email);
        if (error && /rate|seconds/i.test(error.message)) {
          toast('Too many requests. Wait a minute and try again.', 'warning');
          return;
        }
        // Same answer whether or not the email has an account.
        forgotCodeSent = true;
        $('#forgotEmail').readOnly = true;
        $('#forgotCodeField').hidden = false;
        $('#forgotCode').required = true;
        $('#forgotSubmit').textContent = 'Verify code';
        $('#forgotNote').textContent = `If ${email} belongs to an account, a 6-digit code is on its way.`;
        $('#forgotCode').focus();
        return;
      }
      const token = $('#forgotCode').value.trim();
      if (!/^[0-9]{6}$/.test(token)) { toast('Enter the 6-digit code from the email.', 'warning'); return; }
      const { error } = await sb.auth.verifyOtp({ email, token, type: 'recovery' });
      if (error) {
        toast(/rate|seconds/i.test(error.message)
          ? 'Too many tries. Wait a minute and try again.'
          : 'That code is wrong or has expired.', 'error');
        return;
      }
      showAuth('set-password', 'recovery');
    } catch (_) {
      toast('Could not reach the server. Check your connection and try again.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#setPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('#newPassword').value;
    const b = $('#newPassword2').value;
    if (a.length < 10) { toast('Use at least 10 characters.', 'warning'); return; }
    if (a !== b) { toast('The two passwords do not match.', 'warning'); return; }
    const btn = e.submitter || $('#setPasswordForm button[type=submit]');
    btn.disabled = true;
    let error = null;
    if (setPasswordReason === 'temp') {
      // Through the server, which sets the password and clears the
      // temporary-password flag together; then a fresh session carries it.
      try {
        await act('self.set_password', 'self', { password: a });
        await sb.auth.refreshSession();
      } catch (e) {
        error = e;
      }
    } else {
      ({ error } = await sb.auth.updateUser({ password: a }));
    }
    btn.disabled = false;
    if (error) { toast(error.message || 'Could not save the password.', 'error'); return; }
    $('#newPassword').value = '';
    $('#newPassword2').value = '';
    history.replaceState(null, '', location.pathname);
    toast('Password saved.', 'success');
    await enter(true);
  });

  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') showAuth('set-password', 'recovery');
  });

  async function signOut() {
    // Before signing out: the record needs this session.
    await auditClient('session.signed_out');
    await sb.auth.signOut().catch(() => {});
    me.staff = null;
    me.perms = new Set();
    history.replaceState(null, '', location.pathname);
    showAuth('signin');
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  let modalHandlers = {};

  function openModal({ title, subtitle = '', body, foot = '', wide = false, handlers = {} }) {
    modalHandlers = handlers;
    $('#modalRoot').innerHTML = `
      <div class="modal-backdrop" data-backdrop>
        <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
            <button class="icon-btn close" data-action="close-modal" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">${body}</div>
          ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
        </div>
      </div>`;
    const first = $('#modalRoot .modal-body input, #modalRoot .modal-body select, #modalRoot .modal-body textarea');
    if (first) first.focus();
    return $('#modalRoot .modal');
  }

  function closeModal() {
    $('#modalRoot').innerHTML = '';
    modalHandlers = {};
  }

  $('#modalRoot').addEventListener('mousedown', (e) => {
    if (e.target.matches('[data-backdrop]')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#modalRoot').innerHTML) closeModal();
  });

  /**
   * Asks for confirmation, optionally with a text field. Resolves with the
   * text ('' when there is no field) or null when cancelled.
   */
  function confirmBox({ title, message, confirmLabel = 'Confirm', tone = 'primary', field = null }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; closeModal(); resolve(v); } };
      openModal({
        title,
        body: `<p style="margin-bottom:${field ? 14 : 0}px">${esc(message)}</p>${field ? `
          <div class="field"><label for="confirmField">${esc(field.label)}${field.required ? ' *' : ''}</label>
          <textarea class="textarea" id="confirmField" placeholder="${esc(field.placeholder || '')}">${esc(field.value || '')}</textarea></div>` : ''}`,
        foot: `<button class="btn btn-ghost" data-action="m" data-id="cancel">Cancel</button>
               <button class="btn btn-${tone}" data-action="m" data-id="ok">${esc(confirmLabel)}</button>`,
        handlers: {
          cancel: () => finish(null),
          ok: () => {
            const v = field ? $('#confirmField').value.trim() : '';
            if (field?.required && !v) { toast(`${field.label} is required.`, 'warning'); return; }
            finish(v);
          },
        },
      });
      const observer = new MutationObserver(() => {
        if (!$('#modalRoot').innerHTML) { observer.disconnect(); if (!done) { done = true; resolve(null); } }
      });
      observer.observe($('#modalRoot'), { childList: true });
    });
  }

  /** Runs fn with the button disabled, toasting a thrown error. */
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (e) {
      toast(e.message || 'Something went wrong.', 'error');
      return undefined;
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  // ── Views registry and router ──────────────────────────────────────────────
  const state = {
    reports: { status: 'open' },
    users: { filter: 'all', q: '' },
    providers: { status: 'pending' },
    bookings: { status: 'all' },
    directory: { kind: 'vet_clinics', status: 'pending' },
    blood: { tab: 'requests', status: 'active' },
    orders: { q: '' },
    audit: { result: 'all', q: '' },
  };

  const VIEWS = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊', section: 'Overview', perms: ['dashboard.view'],
      title: 'Dashboard', subtitle: 'What needs attention across the app' },
    { id: 'reports', label: 'User reports', icon: '🚩', section: 'Trust & safety', perms: ['reports.view', 'reports.manage'],
      title: 'User reports', subtitle: 'Reports filed from chats, profiles and Pet Match',
      count: () => countOf('user_reports', (b) => b.eq('status', 'open')) },
    { id: 'users', label: 'Users', icon: '👤', section: 'Trust & safety', perms: ['users.view', 'users.manage'],
      title: 'Users', subtitle: 'App accounts, their pets and their history' },
    { id: 'providers', label: 'Service providers', icon: '🛡️', section: 'Services', perms: ['providers.view'],
      title: 'Service providers', subtitle: 'Applications, KYC documents and verification',
      count: () => countOf('service_providers', (b) => b.eq('verification_status', 'pending')) },
    { id: 'bookings', label: 'Bookings', icon: '📅', section: 'Services', perms: ['bookings.view', 'bookings.manage'],
      title: 'Bookings', subtitle: 'Service bookings made in the app',
      count: () => countOf('service_bookings', (b) => b.eq('status', 'pending')), soft: true },
    { id: 'directory', label: 'Clinics & blood banks', icon: '🏥', section: 'Services', perms: ['clinics.view', 'clinics.approve'],
      title: 'Clinics & blood banks', subtitle: 'Listings submitted by users, waiting for review',
      count: async () => {
        const [a, b] = await Promise.all([
          countOf('vet_clinics', (x) => x.eq('verification_status', 'pending')),
          countOf('blood_banks', (x) => x.eq('verification_status', 'pending')),
        ]);
        return (a ?? 0) + (b ?? 0);
      } },
    { id: 'blood', label: 'Blood SOS', icon: '🩸', section: 'Emergency', perms: ['blood.view', 'blood.manage', 'blood.contact'],
      title: 'Blood SOS', subtitle: 'Emergency requests, donor responses and call requests',
      count: async () => {
        const [reqs, calls] = await Promise.all([
          countOf('blood_requests', (b) => b.eq('status', 'active').gt('expires_at', new Date().toISOString())),
          can('blood.contact', 'blood.manage') ? countOf('donor_contact_escalations', (b) => b.eq('status', 'open')) : 0,
        ]);
        return (reqs ?? 0) + (calls ?? 0);
      } },
    { id: 'banners', label: 'Home banners', icon: '🖼️', section: 'Content', perms: ['banners.manage'],
      title: 'Home banners', subtitle: 'The carousel at the top of the app’s home screen' },
    { id: 'announce', label: 'Notifications', icon: '📣', section: 'Content', perms: ['notifications.send'],
      title: 'Notifications', subtitle: 'Send an announcement: a push notification plus a message in the app’s inbox' },
    { id: 'orders', label: 'Orders', icon: '📦', section: 'Content', perms: ['orders.view', 'orders.manage'],
      title: 'Orders', subtitle: 'Shop orders synced from Shopify (read-only here)' },
    { id: 'staff', label: 'Staff & roles', icon: '👥', section: 'Administration', perms: ['employees.view', 'employees.manage'],
      title: 'Staff & roles', subtitle: 'Who can use this portal, and what each role may do' },
    { id: 'audit', label: 'Audit log', icon: '📜', section: 'Administration', perms: ['audit.view'],
      title: 'Audit log', subtitle: 'Every staff action, recorded server-side and append-only' },
  ];

  const allowed = (v) => v.perms.some((p) => me.perms.has(p));
  const firstView = () => (VIEWS.find(allowed) || VIEWS[0]).id;

  function buildNav() {
    let html = '';
    let section = '';
    for (const v of VIEWS.filter(allowed)) {
      if (v.section !== section) {
        section = v.section;
        html += `<div class="nav-section">${esc(section)}</div>`;
      }
      html += `<a class="nav-link" href="#/${v.id}" data-view="${v.id}"><span class="ico">${v.icon}</span><span>${esc(v.label)}</span><span class="nav-count ${v.soft ? 'soft' : ''}" id="count-${v.id}" hidden></span></a>`;
    }
    $('#nav').innerHTML = html || '<p class="note" style="padding:12px">Your role has no sections yet.</p>';
  }

  async function refreshCounts() {
    await Promise.all(VIEWS.filter((v) => v.count && allowed(v)).map(async (v) => {
      const n = await v.count().catch(() => null);
      const el = document.getElementById(`count-${v.id}`);
      if (!el) return;
      el.hidden = !n;
      el.textContent = n ?? '';
    }));
  }

  let currentView = null;
  let renderToken = 0;

  async function route() {
    if (!me.staff) return;
    const id = (location.hash.match(/^#\/([\w-]+)/) || [])[1];
    let view = VIEWS.find((v) => v.id === id);
    if (!view || !allowed(view)) {
      location.replace(`#/${firstView()}`);
      return;
    }
    currentView = view;
    document.body.classList.remove('nav-open');
    document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === view.id));
    $('#pageTitle').textContent = view.title;
    $('#pageSubtitle').textContent = view.subtitle;
    document.title = `${view.title} · DoggyJi Admin`;
    await renderCurrent();
  }

  async function renderCurrent() {
    if (!currentView) return;
    const token = ++renderToken;
    const root = $('#view');
    root.innerHTML = loadingHtml;
    try {
      const html = await RENDER[currentView.id]();
      if (token !== renderToken) return; // a newer render started meanwhile
      root.innerHTML = html;
      AFTER[currentView.id]?.();
    } catch (e) {
      console.error(e);
      if (token === renderToken) root.innerHTML = errorHtml(e);
    }
  }

  window.addEventListener('hashchange', route);
  setInterval(() => { if (me.staff && !document.hidden) refreshCounts(); }, 60000);

  // ── Global click delegation ────────────────────────────────────────────────
  const ACTIONS = {
    'toggle-password': (id, el) => {
      const input = document.getElementById(id);
      input.type = input.type === 'password' ? 'text' : 'password';
      el.textContent = input.type === 'password' ? 'Show' : 'Hide';
    },
    'show-auth': (mode) => showAuth(mode),
    'open-nav': () => document.body.classList.add('nav-open'),
    'close-nav': () => document.body.classList.remove('nav-open'),
    refresh: () => { renderCurrent(); refreshCounts(); },
    'toggle-theme': () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('doggyji_admin_theme', next); } catch (_) {}
      themeIcon();
      if (currentView?.id === 'dashboard') renderCurrent();
    },
    'sign-out': () => signOut(),
    'close-modal': () => closeModal(),
    m: (id, el) => modalHandlers[id]?.(el),
    filter: (id) => {
      const [view, key, value] = id.split('|');
      state[view][key] = value;
      if (view === 'directory' && key === 'kind') state.directory.status = 'pending';
      if (view === 'blood' && key === 'tab') state.blood.status = value === 'requests' ? 'active' : 'open';
      renderCurrent();
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn(el.dataset.id, el, e);
  });

  function themeIcon() {
    $('#themeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙';
  }

  const RENDER = {};
  const AFTER = {};

  // ════════════════════════════════════════════════════════════════════════════
  // Dashboard
  // ════════════════════════════════════════════════════════════════════════════
  let activityChart = null;

  RENDER.dashboard = async () => {
    const now = new Date().toISOString();
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    const jobs = {};
    if (can('reports.view', 'reports.manage')) jobs.reports = countOf('user_reports', (b) => b.eq('status', 'open'));
    if (can('providers.view')) jobs.providers = countOf('service_providers', (b) => b.eq('verification_status', 'pending'));
    if (can('clinics.view', 'clinics.approve')) {
      jobs.clinics = countOf('vet_clinics', (b) => b.eq('verification_status', 'pending'));
      jobs.banks = countOf('blood_banks', (b) => b.eq('verification_status', 'pending'));
    }
    if (can('blood.view', 'blood.manage', 'blood.contact')) {
      jobs.sos = countOf('blood_requests', (b) => b.eq('status', 'active').gt('expires_at', now));
    }
    if (can('blood.contact', 'blood.manage')) jobs.calls = countOf('donor_contact_escalations', (b) => b.eq('status', 'open'));
    if (can('bookings.view', 'bookings.manage')) jobs.bookings = countOf('service_bookings', (b) => b.eq('status', 'pending'));
    if (can('users.view', 'users.manage')) {
      jobs.users = countOf('profiles');
      jobs.newUsers = countOf('profiles', (b) => b.gte('created_at', week));
    }
    if (can('orders.view', 'orders.manage')) jobs.orders = countOf('orders', (b) => b.gte('placed_at', week));

    const keys = Object.keys(jobs);
    const values = await Promise.all(Object.values(jobs));
    const n = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
    const show = (k) => k in n;
    const num = (k) => (n[k] == null ? '—' : n[k]);

    const metric = (k, label, icon, href, sub, tone) => (show(k)
      ? `<a class="metric ${n[k] > 0 && tone ? tone : ''}" href="#/${href}"><span class="metric-label">${icon} ${esc(label)}</span><span class="metric-value">${esc(num(k))}</span><span class="metric-sub">${esc(sub)}</span></a>`
      : '');

    const listings = show('clinics') ? (n.clinics ?? 0) + (n.banks ?? 0) : null;
    const metrics = [
      metric('sos', 'Active SOS', '🩸', 'blood', 'Open, not expired', 'alert'),
      metric('calls', 'Call requests', '📞', 'blood', 'Waiting for the team', 'alert'),
      metric('reports', 'Open reports', '🚩', 'reports', 'Not reviewed yet', 'warn'),
      metric('providers', 'Pending providers', '🛡️', 'providers', 'Awaiting verification', 'warn'),
      show('clinics') ? `<a class="metric ${listings > 0 ? 'warn' : ''}" href="#/directory"><span class="metric-label">🏥 Pending listings</span><span class="metric-value">${esc(listings)}</span><span class="metric-sub">Clinics and blood banks</span></a>` : '',
      metric('bookings', 'Pending bookings', '📅', 'bookings', 'Not confirmed yet', ''),
      metric('users', 'Users', '👤', 'users', show('newUsers') ? `+${num('newUsers')} in the last 7 days` : '', ''),
      metric('orders', 'Orders (7 days)', '📦', 'orders', 'From Shopify', ''),
    ].join('');

    const attention = [
      ['sos', '🩸', 'Active blood SOS requests', 'blood'],
      ['calls', '📞', 'Donor call requests to handle', 'blood'],
      ['reports', '🚩', 'User reports to review', 'reports'],
      ['providers', '🛡️', 'Provider applications to verify', 'providers'],
    ].filter(([k]) => n[k] > 0);
    if (listings > 0) attention.push(['listings', '🏥', 'Clinic / blood bank listings to review', 'directory']);

    const attentionHtml = attention.length
      ? `<ul class="attention">${attention.map(([k, icon, label, href]) =>
        `<li><a href="#/${href}"><span>${icon}</span><span>${esc(label)}</span><span class="n">${esc(k === 'listings' ? listings : n[k])}</span></a></li>`).join('')}</ul>`
      : '<div class="all-clear">✅ Nothing is waiting on the team right now.</div>';

    let recent = '';
    if (can('audit.view')) {
      const { data } = await sb.from('admin_audit_logs').select('event_name, actor, created_at, result')
        .order('created_at', { ascending: false }).limit(6);
      recent = `<div class="card"><div class="card-head"><div><h3>Recent staff activity</h3></div><a class="btn btn-ghost btn-sm" href="#/audit">Audit log →</a></div>
        ${(data || []).length ? `<div class="list-rows" style="margin:12px 16px 16px">${data.map((a) => `
          <div class="list-row"><div class="grow"><div class="cell-main mono">${esc(a.event_name)}</div>
          <div class="cell-sub">${esc(a.actor?.name || a.actor?.email || 'System')} · ${esc(ago(a.created_at))}</div></div>
          ${a.result === 'SUCCESS' ? '' : badge(a.result === 'DENIED' ? 'Denied' : 'Failed', a.result === 'DENIED' ? 'red' : 'amber')}</div>`).join('')}</div>`
    : '<div class="all-clear">No staff activity yet.</div>'}</div>`;
    }

    // The chart draws sign-ups, SOS requests and reports; a role that can
    // read none of them would get an empty chart.
    const chart = can('users.view', 'users.manage', 'blood.view', 'blood.manage', 'blood.contact', 'reports.view', 'reports.manage')
      ? `<div class="card"><div class="card-head"><div><h3>Activity, last 14 days</h3><p>Sign-ups, SOS requests and reports per day</p></div></div>
          <div class="chart-box"><canvas id="activityChart"></canvas></div></div>`
      : '';

    return `
      <div class="metrics">${metrics || ''}</div>
      <div class="${chart ? 'grid-2' : ''}">
        ${chart}
        <div class="stack">
          <div class="card"><div class="card-head"><div><h3>Needs attention</h3></div></div>${attentionHtml}</div>
          ${recent}
        </div>
      </div>`;
  };

  AFTER.dashboard = async () => {
    const canvas = document.getElementById('activityChart');
    if (!canvas || !window.Chart) return;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 13);
    const days = [...Array(14)].map((_, i) => {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      return d;
    });
    const key = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const series = async (table, column, color, label, allowedNow) => {
      if (!allowedNow) return null;
      const { data } = await sb.from(table).select(column).gte(column, since.toISOString()).limit(5000);
      const byDay = {};
      (data || []).forEach((r) => { const k = key(new Date(r[column])); byDay[k] = (byDay[k] || 0) + 1; });
      // Monotone: whole-number daily counts must not overshoot between points.
      return { label, data: days.map((d) => byDay[key(d)] || 0), borderColor: color, backgroundColor: color, cubicInterpolationMode: 'monotone', pointRadius: 2 };
    };
    const datasets = (await Promise.all([
      series('profiles', 'created_at', '#23C1C3', 'New users', can('users.view', 'users.manage')),
      series('blood_requests', 'created_at', '#EF4444', 'SOS requests', can('blood.view', 'blood.manage', 'blood.contact')),
      series('user_reports', 'created_at', '#F5A524', 'Reports', can('reports.view', 'reports.manage')),
    ])).filter(Boolean);
    if (!document.getElementById('activityChart')) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    const tick = dark ? '#A3B1C6' : '#475569';
    const grid = dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)';
    activityChart?.destroy();
    activityChart = new window.Chart(canvas, {
      type: 'line',
      data: { labels: days.map((d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: tick, boxWidth: 12, font: { family: 'Montserrat' } } } },
        scales: {
          x: { grid: { color: grid }, ticks: { color: tick, maxRotation: 0, autoSkip: true } },
          y: { grid: { color: grid }, ticks: { color: tick, precision: 0 }, beginAtZero: true },
        },
      },
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // User reports
  // ════════════════════════════════════════════════════════════════════════════
  let reportRows = [];
  let reportPeople = {};

  RENDER.reports = async () => {
    const rows = await q(sb.from('user_reports').select('*').order('created_at', { ascending: false }).limit(LIST_LIMIT));
    reportRows = rows;
    reportPeople = await profilesFor(rows.flatMap((r) => [r.reporter_id, r.reported_id]));
    const counts = { all: rows.length };
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const s = state.reports.status;
    const list = s === 'all' ? rows : rows.filter((r) => r.status === s);
    const tabs = tabsHtml('reports', 'status',
      [['open', 'Open'], ['reviewing', 'Reviewing'], ['actioned', 'Action taken'], ['dismissed', 'Dismissed'], ['all', 'All']], s, counts);

    const table = list.length ? `<div class="table-wrap"><table class="table"><thead><tr>
        <th>Reported user</th><th>Reason</th><th class="hide-sm">Reported by</th><th>Filed</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map((r) => `<tr>
          <td>${personCell(reportPeople[r.reported_id], r.reported_id)}</td>
          <td><div class="cell-main">${esc(titleCase(r.reason))}</div>${r.details ? `<div class="cell-sub cell-clip">${esc(r.details)}</div>` : ''}</td>
          <td class="hide-sm">${personCell(reportPeople[r.reporter_id], r.reporter_id)}</td>
          <td class="nowrap" title="${esc(fmtDateTime(r.created_at))}">${esc(ago(r.created_at))}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="actions"><button class="btn btn-outline btn-sm" data-action="open-report" data-id="${esc(r.id)}">Review</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('🚩', s === 'open' ? 'No open reports' : 'Nothing here', s === 'open' ? 'Reports people file from chats, profiles and Pet Match show up here.' : 'No reports with this status.');

    return `<div class="toolbar">${tabs}</div><div class="card">${table}</div>${rows.length >= LIST_LIMIT ? `<p class="note">Showing the latest ${LIST_LIMIT} reports.</p>` : ''}`;
  };

  ACTIONS['open-report'] = async (id) => {
    const r = reportRows.find((x) => x.id === id);
    if (!r) return;
    const reported = reportPeople[r.reported_id];
    const reporter = reportPeople[r.reporter_id];
    const prior = await countOf('user_reports', (b) => b.eq('reported_id', r.reported_id));
    const suspended = can('users.view', 'users.manage')
      ? (await sb.from('user_suspensions').select('user_id').eq('user_id', r.reported_id).maybeSingle()).data
      : null;
    const manage = can('reports.manage');
    const closed = r.status === 'actioned' || r.status === 'dismissed';

    openModal({
      title: `Report: ${titleCase(r.reason)}`,
      subtitle: `Filed ${fmtDateTime(r.created_at)}`,
      wide: true,
      body: `
        <div class="detail-grid">
          <div class="detail"><div class="k">Reported user</div><div class="v">${personCell(reported, r.reported_id)}</div></div>
          <div class="detail"><div class="k">Reported by</div><div class="v">${personCell(reporter, r.reporter_id)}</div></div>
          <div class="detail"><div class="k">Status</div><div class="v">${statusBadge(r.status)} ${suspended ? badge('Account suspended', 'red') : ''}</div></div>
          <div class="detail"><div class="k">Reports against this user</div><div class="v">${esc(prior ?? '—')}</div></div>
          ${r.chat_id ? `<div class="detail full"><div class="k">From chat</div><div class="v mono">${esc(r.chat_id)}</div></div>` : ''}
          <div class="detail full"><div class="k">What they said</div><div class="quote">${esc(r.details || 'No details given.')}</div></div>
          ${r.reviewed_at ? `<div class="detail full"><div class="k">Reviewed</div><div class="v">${esc(r.reviewed_by || '')} · ${esc(fmtDateTime(r.reviewed_at))}${r.resolution ? `<div class="quote" style="margin-top:6px">${esc(r.resolution)}</div>` : ''}</div></div>` : ''}
        </div>
        ${manage && !closed ? `<div class="field" style="margin-top:16px"><label for="resolution">Resolution note</label>
          <textarea class="textarea" id="resolution" placeholder="What was decided and why. Required for Action taken."></textarea></div>` : ''}`,
      foot: `
        ${can('users.view', 'users.manage') && r.reported_id !== 'deleted-user' ? `<button class="btn btn-ghost left" data-action="m" data-id="user">View user</button>` : ''}
        ${can('users.manage') && !suspended && r.reported_id !== 'deleted-user' ? `<button class="btn btn-danger-outline" data-action="m" data-id="suspend">Suspend user</button>` : ''}
        ${manage && r.status === 'open' ? `<button class="btn btn-outline" data-action="m" data-id="reviewing">Mark reviewing</button>` : ''}
        ${manage && !closed ? `<button class="btn btn-outline" data-action="m" data-id="dismiss">Dismiss</button>
                               <button class="btn btn-primary" data-action="m" data-id="actioned">Action taken</button>` : ''}
        ${manage && closed ? `<button class="btn btn-outline" data-action="m" data-id="reopen">Reopen</button>` : ''}`,
      handlers: {
        user: () => { closeModal(); openUser(r.reported_id); },
        suspend: async (btn) => {
          const reason = await confirmBox({
            title: 'Suspend this account?',
            message: 'They are signed out and cannot sign in. Their pets leave Pet Match and the donor directory. You can restore the account later.',
            confirmLabel: 'Suspend', tone: 'danger',
            field: { label: 'Reason', required: true, placeholder: 'Shown to staff in the audit log', value: `Report: ${titleCase(r.reason)}` },
          });
          if (reason == null) return;
          await busy(btn, async () => {
            await act('user.suspend', r.reported_id, { reason });
            await act('report.update', r.id, { status: 'actioned', resolution: `Account suspended: ${reason}` });
            toast('Account suspended and report closed.', 'success');
            renderCurrent(); refreshCounts();
          });
        },
        reviewing: (btn) => updateReport(btn, r, 'reviewing'),
        dismiss: (btn) => updateReport(btn, r, 'dismissed'),
        actioned: (btn) => updateReport(btn, r, 'actioned', true),
        reopen: (btn) => updateReport(btn, r, 'open'),
      },
    });
  };

  async function updateReport(btn, r, status, needNote = false) {
    const note = $('#resolution')?.value.trim() || null;
    if (needNote && !note) { toast('Write a resolution note first.', 'warning'); return; }
    await busy(btn, async () => {
      await act('report.update', r.id, { status, resolution: note ?? r.resolution ?? null });
      closeModal();
      toast('Report updated.', 'success');
      renderCurrent(); refreshCounts();
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Users
  // ════════════════════════════════════════════════════════════════════════════
  RENDER.users = async () => {
    const { filter, q: search } = state.users;
    const suspensions = await q(sb.from('user_suspensions').select('*'));
    const suspended = Object.fromEntries(suspensions.map((s) => [s.user_id, s]));

    let query = sb.from('profiles').select('id, full_name, username, email, phone, avatar_url, city, created_at')
      .order('created_at', { ascending: false }).limit(200);
    const term = search.replace(/[,()%*]/g, ' ').trim();
    if (term) query = query.or(['full_name', 'username', 'email', 'phone'].map((c) => `${c}.ilike.%${term}%`).join(','));
    if (filter === 'suspended') query = query.in('id', suspensions.length ? suspensions.map((s) => s.user_id) : ['-']);
    const rows = await q(query);

    const toolbar = `<div class="toolbar">
      ${tabsHtml('users', 'filter', [['all', 'All'], ['suspended', 'Suspended']], filter, { suspended: suspensions.length })}
      <span class="grow"></span>
      <input class="input search" id="userSearch" placeholder="Search name, @username, email or phone" value="${esc(search)}">
    </div>`;

    const table = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>User</th><th class="hide-sm">Contact</th><th>City</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((u) => `<tr>
        <td>${personCell(u, u.id)}</td>
        <td class="hide-sm"><div>${esc(u.email || '—')}</div><div class="cell-sub">${esc(u.phone || '')}</div></td>
        <td>${esc(u.city || '—')}</td>
        <td class="nowrap">${esc(fmtDate(u.created_at))}</td>
        <td>${suspended[u.id] ? badge('Suspended', 'red') : badge('Active', 'green')}</td>
        <td class="actions"><button class="btn btn-outline btn-sm" data-action="open-user" data-id="${esc(u.id)}">View</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('👤', term ? 'No matching users' : 'No users yet', term ? 'Try a different name, username, email or phone.' : 'People who sign up in the app appear here.');

    return `${toolbar}<div class="card">${table}</div>${rows.length >= 200 ? '<p class="note">Showing the 200 most recent matches. Search to narrow down.</p>' : ''}`;
  };

  AFTER.users = () => {
    const input = document.getElementById('userSearch');
    if (!input) return;
    input.addEventListener('input', debounce(() => {
      state.users.q = input.value;
      renderCurrent().then(() => {
        const again = document.getElementById('userSearch');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    }, 400));
  };

  ACTIONS['open-user'] = (id) => openUser(id);

  async function openUser(id) {
    const [{ data: u }, { data: pets }, { data: susp }, against, filed, donors, providers, orders] = await Promise.all([
      sb.from('profiles').select('*').eq('id', id).maybeSingle(),
      sb.from('pets').select('id, name, species, breed, created_at').eq('user_id', id).limit(50),
      sb.from('user_suspensions').select('*').eq('user_id', id).maybeSingle(),
      countOf('user_reports', (b) => b.eq('reported_id', id)),
      countOf('user_reports', (b) => b.eq('reporter_id', id)),
      countOf('blood_donors', (b) => b.eq('user_id', id)),
      countOf('service_providers', (b) => b.eq('user_id', id)),
      can('orders.view', 'orders.manage') ? countOf('orders', (b) => b.eq('user_id', id)) : Promise.resolve(null),
    ]);
    if (!u) { toast('This user no longer exists.', 'warning'); return; }

    openModal({
      title: u.full_name || (u.username ? `@${u.username}` : 'User'),
      subtitle: `Joined ${fmtDate(u.created_at)} · ID ${u.id}`,
      wide: true,
      body: `
        ${susp ? `<div class="quote" style="border-left:3px solid var(--red);margin-bottom:14px"><strong>Suspended</strong> by ${esc(susp.suspended_by)} on ${esc(fmtDateTime(susp.created_at))}<br>${esc(susp.reason)}</div>` : ''}
        <div class="detail-grid">
          <div class="detail"><div class="k">Username</div><div class="v">${esc(u.username ? `@${u.username}` : '—')}</div></div>
          <div class="detail"><div class="k">City</div><div class="v">${esc(u.city || '—')}</div></div>
          <div class="detail"><div class="k">Email</div><div class="v">${u.email ? `<a href="mailto:${esc(u.email)}">${esc(u.email)}</a>` : '—'}</div></div>
          <div class="detail"><div class="k">Phone</div><div class="v">${u.phone ? `<a href="tel:${esc(u.phone)}">${esc(u.phone)}</a>` : '—'}</div></div>
          <div class="detail"><div class="k">Reports against / filed</div><div class="v">${esc(against ?? '—')} / ${esc(filed ?? '—')}</div></div>
          <div class="detail"><div class="k">Donor listings · Provider applications${orders != null ? ' · Orders' : ''}</div><div class="v">${esc(donors ?? '—')} · ${esc(providers ?? '—')}${orders != null ? ` · ${esc(orders)}` : ''}</div></div>
          ${u.bio ? `<div class="detail full"><div class="k">Bio</div><div class="quote">${esc(u.bio)}</div></div>` : ''}
        </div>
        <div class="section-title">Pets (${esc((pets || []).length)})</div>
        ${(pets || []).length ? `<div class="list-rows">${pets.map((p) => `<div class="list-row"><span>${p.species === 'cat' ? '🐱' : '🐶'}</span>
          <div class="grow"><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.breed || titleCase(p.species))}</div></div>
          <span class="cell-sub">${esc(fmtDate(p.created_at))}</span></div>`).join('')}</div>` : '<p class="note" style="margin:0">No pets added.</p>'}`,
      foot: can('users.manage')
        ? (susp ? '<button class="btn btn-primary" data-action="m" data-id="restore">Restore account</button>'
          : '<button class="btn btn-danger" data-action="m" data-id="suspend">Suspend account</button>')
        : '',
      handlers: {
        suspend: async (btn) => {
          const reason = await confirmBox({
            title: 'Suspend this account?',
            message: 'They are signed out and cannot sign in. Their pets leave Pet Match and the donor directory.',
            confirmLabel: 'Suspend', tone: 'danger',
            field: { label: 'Reason', required: true, placeholder: 'Why this account is suspended' },
          });
          if (reason == null) return;
          await busy(btn, async () => {
            await act('user.suspend', id, { reason });
            toast('Account suspended.', 'success');
            renderCurrent();
          });
        },
        restore: async (btn) => {
          const ok = await confirmBox({ title: 'Restore this account?', message: 'They can sign in again. The Pet Match listings and donor availability that were on before the suspension come back.', confirmLabel: 'Restore' });
          if (ok == null) return;
          await busy(btn, async () => {
            await act('user.unsuspend', id);
            toast('Account restored.', 'success');
            renderCurrent();
          });
        },
      },
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Service providers
  // ════════════════════════════════════════════════════════════════════════════
  let providerRows = [];
  let providerPeople = {};

  RENDER.providers = async () => {
    const rows = await q(sb.from('service_providers').select('*').order('created_at', { ascending: false }).limit(LIST_LIMIT));
    providerRows = rows;
    providerPeople = await profilesFor(rows.map((p) => p.user_id));
    const counts = { all: rows.length };
    rows.forEach((p) => { counts[p.verification_status] = (counts[p.verification_status] || 0) + 1; });
    const s = state.providers.status;
    const list = s === 'all' ? rows : rows.filter((p) => p.verification_status === s);
    const tabs = tabsHtml('providers', 'status', [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']], s, counts);

    const table = list.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Provider</th><th>City</th><th>Services</th><th class="hide-sm">Experience</th><th>Status</th><th class="hide-sm">Applied</th><th></th></tr></thead><tbody>
      ${list.map((p) => `<tr>
        <td>${personCell({ full_name: p.full_name, avatar_url: p.photo_url }, p.user_id, providerPeople[p.user_id]?.email || '')}</td>
        <td>${esc(p.city || '—')}${p.area ? `<div class="cell-sub">${esc(p.area)}</div>` : ''}</td>
        <td><div class="cell-clip">${esc((p.service_types || []).map(titleCase).join(', ') || '—')}</div></td>
        <td class="hide-sm">${esc(p.years_experience ?? 0)} yrs</td>
        <td>${statusBadge(p.verification_status)}</td>
        <td class="hide-sm nowrap">${esc(fmtDate(p.created_at))}</td>
        <td class="actions"><button class="btn btn-outline btn-sm" data-action="open-provider" data-id="${esc(p.id)}">Review</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('🛡️', s === 'pending' ? 'No applications waiting' : 'Nothing here', 'Service providers apply from the app’s Pet Services section.');

    return `<div class="toolbar">${tabs}</div><div class="card">${table}</div>`;
  };

  ACTIONS['open-provider'] = async (id) => {
    const p = providerRows.find((x) => x.id === id);
    if (!p) return;
    const person = providerPeople[p.user_id];
    const canDocs = can('providers.documents.view');
    const docs = canDocs
      ? (await sb.from('provider_documents').select('*').eq('provider_id', p.id).order('created_at')).data || []
      : null;
    // Verifying needs approve, rejecting needs reject (as admin-action checks).
    const canVerifyDocs = can('providers.approve');
    const canRejectDocs = can('providers.reject');
    const pricing = p.pricing && typeof p.pricing === 'object' ? Object.entries(p.pricing) : [];

    openModal({
      title: p.full_name || 'Provider',
      subtitle: `Applied ${fmtDate(p.created_at)} · ${titleCase(p.verification_status)}`,
      wide: true,
      body: `
        <div class="detail-grid">
          <div class="detail"><div class="k">City / area</div><div class="v">${esc(p.city || '—')}${p.area ? `, ${esc(p.area)}` : ''}</div></div>
          <div class="detail"><div class="k">Experience</div><div class="v">${esc(p.years_experience ?? 0)} years · ${esc(p.completed_jobs ?? 0)} jobs · ★ ${esc(p.rating ?? 0)}</div></div>
          <div class="detail"><div class="k">Email</div><div class="v">${esc(person?.email || '—')}</div></div>
          <div class="detail"><div class="k">Phone</div><div class="v">${esc(person?.phone || '—')}</div></div>
          <div class="detail"><div class="k">Services</div><div class="v">${esc((p.service_types || []).map(titleCase).join(', ') || '—')}</div></div>
          <div class="detail"><div class="k">Pets accepted</div><div class="v">${esc((p.pets_accepted || []).map(titleCase).join(', ') || '—')}</div></div>
          <div class="detail"><div class="k">Claims (self-declared)</div><div class="v">${p.claimed_quiz_passed || p.safety_quiz_passed ? badge('Safety quiz', 'teal') : ''} ${p.claimed_police_verified || p.police_verified ? badge('Police verification', 'teal') : ''} ${!(p.claimed_quiz_passed || p.safety_quiz_passed || p.claimed_police_verified || p.police_verified) ? '—' : ''}</div></div>
          <div class="detail"><div class="k">Pricing</div><div class="v">${pricing.length ? pricing.map(([k, v]) => `${esc(titleCase(k))}: ${esc(money(v))}`).join('<br>') : '—'}</div></div>
          ${p.bio ? `<div class="detail full"><div class="k">Bio</div><div class="quote">${esc(p.bio)}</div></div>` : ''}
        </div>
        <div class="section-title">KYC documents</div>
        ${docs == null ? '<p class="note" style="margin:0">Your role cannot open identity documents.</p>'
    : docs.length ? `<div class="list-rows">${docs.map((d) => `<div class="list-row">
            <span>📄</span><div class="grow"><div class="cell-main">${esc(titleCase(d.document_type))}</div>
            <div class="cell-sub">${esc(d.file_name || '')} · uploaded ${esc(fmtDate(d.created_at))}${d.rejection_reason ? ` · ${esc(d.rejection_reason)}` : ''}</div></div>
            ${statusBadge(d.status)}
            <button class="btn btn-outline btn-sm" data-action="m" data-id="${esc(`doc-view:${d.id}`)}">Open</button>
            ${canVerifyDocs && d.status !== 'verified' ? `<button class="btn btn-ghost btn-sm" data-action="m" data-id="${esc(`doc-ok:${d.id}`)}">Verify</button>` : ''}
            ${canRejectDocs && d.status !== 'rejected' ? `<button class="btn btn-ghost btn-sm" data-action="m" data-id="${esc(`doc-no:${d.id}`)}">Reject</button>` : ''}
          </div>`).join('')}</div>`
      : '<p class="note" style="margin:0">No documents uploaded.</p>'}
        <p class="note">Opening a document creates a link that works for 2 minutes and is recorded in the audit log.</p>`,
      foot: `
        ${can('providers.suspend') && p.verification_status === 'approved' ? '<button class="btn btn-danger-outline left" data-action="m" data-id="suspend">Suspend</button>' : ''}
        ${can('providers.reject') && p.verification_status !== 'rejected' ? '<button class="btn btn-outline" data-action="m" data-id="reject">Reject</button>' : ''}
        ${can('providers.request_changes') && p.verification_status !== 'pending' ? '<button class="btn btn-outline" data-action="m" data-id="changes">Back to pending</button>' : ''}
        ${can('providers.request_changes') && p.verification_status === 'pending' ? '<button class="btn btn-outline" data-action="m" data-id="changes">Request changes</button>' : ''}
        ${can('providers.approve') && p.verification_status !== 'approved' ? '<button class="btn btn-success" data-action="m" data-id="approve">Approve</button>' : ''}`,
      handlers: new Proxy({
        approve: (btn) => decideProvider(btn, p, 'provider.approve', 'Approve this provider?', 'They appear in the app as a verified provider.', false),
        reject: (btn) => decideProvider(btn, p, 'provider.reject', 'Reject this application?', 'They will not appear in the app. They see your reason in the app and can apply again after 5 days.', true),
        changes: (btn) => decideProvider(btn, p, 'provider.request_changes', 'Ask for changes?', 'The application goes back to pending. Tell them what is missing (you will need to contact them directly).', true),
        suspend: (btn) => decideProvider(btn, p, 'provider.suspend', 'Suspend this provider?', 'They are removed from the app’s provider directory and cannot apply again unless you approve them. They see your reason in the app.', true),
      }, {
        get(target, key) {
          if (key in target) return target[key];
          const [kind, docId] = String(key).split(':');
          if (kind === 'doc-view') return () => openDocument(docId);
          if (kind === 'doc-ok') return (btn) => setDocument(btn, docId, 'verified', p.id);
          if (kind === 'doc-no') return (btn) => setDocument(btn, docId, 'rejected', p.id);
          return undefined;
        },
      }),
    });
  };

  async function decideProvider(btn, p, action, title, message, needReason) {
    const reason = await confirmBox({
      title, message, confirmLabel: 'Confirm', tone: action === 'provider.approve' ? 'success' : 'danger',
      field: { label: needReason ? 'Reason' : 'Note (optional)', required: needReason, placeholder: needReason && /reject|suspend/.test(action) ? 'Shown to the provider in the app, and recorded in the audit log' : 'Recorded in the audit log' },
    });
    if (reason == null) return;
    await busy(btn, async () => {
      await act(action, p.id, { reason: reason || null });
      toast('Provider updated.', 'success');
      renderCurrent(); refreshCounts();
    });
  }

  async function openDocument(docId) {
    // Opened before the request so the browser does not block it as a popup.
    const win = window.open('about:blank', '_blank');
    try {
      const result = await act('provider.document.url', docId);
      if (win) { win.opener = null; win.location.href = result.url; } else window.location.assign(result.url);
    } catch (e) {
      win?.close();
      toast(e.message, 'error');
    }
  }

  async function setDocument(btn, docId, status, providerId) {
    const reason = status === 'rejected'
      ? await confirmBox({ title: 'Reject this document?', message: 'Say what is wrong so the provider can fix it.', confirmLabel: 'Reject', tone: 'danger', field: { label: 'Reason', required: true } })
      : '';
    if (reason == null) return;
    await busy(btn, async () => {
      await act('provider.document.set_status', docId, { status, reason: reason || null });
      toast('Document updated.', 'success');
      closeModal();
      ACTIONS['open-provider'](providerId);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Bookings
  // ════════════════════════════════════════════════════════════════════════════
  let bookingRows = [];

  RENDER.bookings = async () => {
    const rows = await q(sb.from('service_bookings')
      .select('*, service_providers!provider_id ( full_name )')
      .order('created_at', { ascending: false }).limit(LIST_LIMIT));
    bookingRows = rows;
    const people = await profilesFor(rows.map((b) => b.customer_id));
    const petIds = [...new Set(rows.map((b) => b.pet_id).filter(Boolean))];
    const pets = {};
    if (petIds.length) {
      const { data } = await sb.from('pets').select('id, name').in('id', petIds);
      (data || []).forEach((p) => { pets[p.id] = p.name; });
    }
    const counts = { all: rows.length };
    rows.forEach((b) => { counts[b.status] = (counts[b.status] || 0) + 1; });
    const s = state.bookings.status;
    const list = s === 'all' ? rows : rows.filter((b) => b.status === s);
    const tabs = tabsHtml('bookings', 'status',
      [['all', 'All'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['completed', 'Completed'], ['cancelled', 'Cancelled']], s, counts);

    const table = list.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>When</th><th>Customer</th><th>Provider</th><th>Service</th><th>Price</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((b) => `<tr>
        <td class="nowrap"><div class="cell-main">${esc(fmtDate(b.booking_date))}</div><div class="cell-sub">${esc(b.time_slot || '')}</div></td>
        <td>${personCell(people[b.customer_id], b.customer_id, b.pet_id ? `for ${pets[b.pet_id] || 'a pet'}` : undefined)}</td>
        <td>${esc(b.service_providers?.full_name || `Provider ${shortId(b.provider_id)}`)}</td>
        <td>${esc(titleCase(b.service_type))}</td>
        <td>${esc(money(b.total_price))}<div class="cell-sub">${esc(titleCase(b.payment_status || ''))}</div></td>
        <td>${statusBadge(b.status)}</td>
        <td class="actions">${can('bookings.manage') && bookingMoves(b).length ? `<button class="btn btn-outline btn-sm" data-action="edit-booking" data-id="${esc(b.id)}">Change status</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('📅', 'No bookings', 'Bookings made in the app’s Pet Services section appear here.');

    return `<div class="toolbar">${tabs}</div><div class="card">${table}</div>`;
  };

  /**
   * What staff may change a booking to, mirroring admin-action: confirm only a
   * pending request (when the provider agreed), cancel anything not finished,
   * mark done only a confirmed booking from its date. Finished bookings can't
   * be changed.
   */
  function bookingMoves(b) {
    const today = new Date().toISOString().slice(0, 10);
    if (b.status === 'pending') return [['confirmed', 'Confirmed (the provider agreed)'], ['cancelled', 'Cancelled']];
    if (b.status === 'confirmed') {
      const moves = [['cancelled', 'Cancelled']];
      if (String(b.booking_date) <= today) moves.unshift(['completed', 'Completed (done)']);
      return moves;
    }
    return [];
  }

  ACTIONS['edit-booking'] = (id) => {
    const b = bookingRows.find((x) => x.id === id);
    if (!b) return;
    const moves = bookingMoves(b);
    if (!moves.length) return;
    openModal({
      title: 'Change booking status',
      subtitle: `${titleCase(b.service_type)} on ${fmtDate(b.booking_date)} · currently ${b.status}`,
      body: `
        <div class="field"><label for="bkStatus">New status</label>
          <select class="select" id="bkStatus">${moves
    .map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('')}</select></div>
        <div class="field"><label for="bkReason">Reason *</label>
          <textarea class="textarea" id="bkReason" placeholder="e.g. Customer asked to cancel by phone; provider agreed by phone"></textarea></div>
        <p class="note" style="margin:0">The customer and the provider are notified in the app. Confirm only when the provider has agreed. Refunds are not handled here: payment for services is arranged outside the app.</p>`,
      foot: '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="m" data-id="save">Save</button>',
      handlers: {
        save: async (btn) => {
          const status = $('#bkStatus').value;
          const reason = $('#bkReason').value.trim();
          if (!reason) { toast('A reason is required.', 'warning'); return; }
          if (status === b.status) { closeModal(); return; }
          await busy(btn, async () => {
            const r = await act('booking.set_status', b.id, { status, reason });
            closeModal();
            const n = r && r.notified;
            toast(n && n.error
              ? `Booking updated. ${n.error}`
              : `Booking updated. Customer and provider notified${n && n.pushed ? ` (${n.pushed} push${n.pushed === 1 ? '' : 'es'})` : ''}.`,
            n && n.error ? 'warning' : 'success');
            renderCurrent(); refreshCounts();
          });
        },
      },
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // Clinics & blood banks
  // ════════════════════════════════════════════════════════════════════════════
  let directoryRows = [];

  /**
   * Where to check a clinic or blood bank on Google Maps before approving it:
   * the link the submitter gave, else their coordinates, else a search for the
   * name and address (listings sent before the link was stored).
   */
  function mapsLinkHtml(r) {
    const saved = typeof r.maps_url === 'string' && /^https:\/\//i.test(r.maps_url) ? r.maps_url : '';
    const coords = r.lat != null && r.lng != null ? `${r.lat},${r.lng}` : '';
    const href = saved
      || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords || [r.name, r.address, r.city].filter(Boolean).join(', '))}`;
    const label = saved ? '📍 Open the Maps link they gave' : coords ? '📍 Open their location' : '📍 Search on Maps (no link given)';
    return `<div class="cell-sub"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a></div>`;
  }

  RENDER.directory = async () => {
    const { kind, status } = state.directory;
    const rows = await q(sb.from(kind).select('*').order('created_at', { ascending: false }).limit(LIST_LIMIT));
    directoryRows = rows;
    const people = await profilesFor(rows.map((r) => r.submitted_by));
    const counts = { all: rows.length };
    rows.forEach((r) => { counts[r.verification_status] = (counts[r.verification_status] || 0) + 1; });
    const list = status === 'all' ? rows : rows.filter((r) => r.verification_status === status);
    const isClinic = kind === 'vet_clinics';
    const approve = can('clinics.approve');

    const table = list.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Name</th><th>City</th><th class="hide-sm">Phone</th><th>${isClinic ? 'Specialties / hours' : 'Blood types'}</th><th class="hide-sm">Submitted by</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr>
        <td><div class="cell-main">${esc(r.name)}</div><div class="cell-sub cell-clip">${esc(r.address || '')}</div>${mapsLinkHtml(r)}</td>
        <td>${esc(r.city || '—')}</td>
        <td class="hide-sm nowrap">${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '—'}</td>
        <td><div class="cell-clip">${isClinic
    ? esc([(r.specialties || []).join(', '), r.operating_hours].filter(Boolean).join(' · ') || '—')
    : esc(`${(r.available_blood_types || []).join(', ') || '—'}${r.is_24_hours ? ' · 24 hours' : ''}`)}</div></td>
        <td class="hide-sm">${r.submitted_by ? personCell(people[r.submitted_by], r.submitted_by) : '<span class="cell-sub">Team</span>'}</td>
        <td>${statusBadge(r.verification_status)}</td>
        <td class="actions">${approve ? `
          ${r.verification_status !== 'approved' ? `<button class="btn btn-success btn-sm" data-action="set-listing" data-id="${esc(`${r.id}|approved`)}">Approve</button>` : ''}
          ${r.verification_status !== 'rejected' ? `<button class="btn btn-outline btn-sm" data-action="set-listing" data-id="${esc(`${r.id}|rejected`)}">Reject</button>` : ''}` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('🏥', status === 'pending' ? 'Nothing waiting for review' : 'Nothing here', 'Users submit clinics from Vet Finder and blood banks from the Blood Bank screen.');

    return `<div class="toolbar">
        ${tabsHtml('directory', 'kind', [['vet_clinics', 'Vet clinics'], ['blood_banks', 'Blood banks']], kind)}
        <span class="grow"></span>
        ${tabsHtml('directory', 'status', [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']], status, counts)}
      </div><div class="card">${table}</div>
      <p class="note">Approved listings are shown to everyone in the app; pending and rejected ones only to the person who submitted them.</p>`;
  };

  ACTIONS['set-listing'] = async (id, btn) => {
    const [rowId, status] = id.split('|');
    const r = directoryRows.find((x) => x.id === rowId);
    if (!r) return;
    const ok = await confirmBox({
      title: `${status === 'approved' ? 'Approve' : 'Reject'} “${r.name}”?`,
      message: status === 'approved' ? 'It becomes visible to everyone in the app.' : 'It is hidden from the app.',
      confirmLabel: status === 'approved' ? 'Approve' : 'Reject',
      tone: status === 'approved' ? 'success' : 'danger',
    });
    if (ok == null) return;
    await busy(btn, async () => {
      await act('directory.set_status', rowId, { kind: state.directory.kind, status });
      toast('Listing updated.', 'success');
      renderCurrent(); refreshCounts();
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // Blood SOS
  // ════════════════════════════════════════════════════════════════════════════
  let bloodRows = [];
  let bloodAlerts = {};
  let bloodPeople = {};
  let escalationRows = [];

  const isExpired = (r) => r.status === 'active' && r.expires_at && new Date(r.expires_at) < new Date();

  RENDER.blood = async () => {
    const canCalls = can('blood.contact', 'blood.manage');
    const tab = state.blood.tab;
    const tabs = tabsHtml('blood', 'tab', [['requests', 'SOS requests'], ...(canCalls ? [['calls', 'Call requests'], ['donors', 'Donors']] : [])], tab);
    let body = '';
    if (tab === 'calls' && canCalls) body = await renderCalls();
    else if (tab === 'donors' && canCalls) body = await renderDonors();
    else body = await renderRequests();
    return `<div class="toolbar">${tabs}</div>${body}`;
  };

  async function renderRequests() {
    const rows = await q(sb.from('blood_requests').select('*').order('created_at', { ascending: false }).limit(LIST_LIMIT));
    bloodRows = rows;
    bloodAlerts = {};
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await sb.from('blood_request_alerts').select('request_id, status, donor_id, donor_user_id, responded_at')
        .in('request_id', ids.slice(i, i + 100));
      (data || []).forEach((a) => { (bloodAlerts[a.request_id] ||= []).push(a); });
    }
    bloodPeople = await profilesFor(rows.map((r) => r.requester_id));
    const shown = (r) => (isExpired(r) ? 'expired' : r.status);
    const counts = { all: rows.length };
    rows.forEach((r) => { counts[shown(r)] = (counts[shown(r)] || 0) + 1; });
    const s = state.blood.status;
    const list = s === 'all' ? rows : rows.filter((r) => shown(r) === s);

    const table = list.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Patient</th><th>Hospital</th><th>Urgency</th><th>Raised</th><th>Donors</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((r) => {
    const alerts = bloodAlerts[r.id] || [];
    const accepted = alerts.filter((a) => a.status === 'accepted').length;
    return `<tr>
        <td><div class="cell-main">${esc(r.pet_name)} <span class="badge b-red">${esc(r.blood_group)}</span></div><div class="cell-sub">${esc(titleCase(r.species))}</div></td>
        <td><div>${esc(r.hospital_name)}</div><div class="cell-sub">${esc(r.hospital_city)}</div></td>
        <td>${badge(titleCase(r.urgency_level || 'critical'), r.urgency_level === 'routine' ? 'slate' : r.urgency_level === 'urgent' ? 'amber' : 'red')}</td>
        <td class="nowrap" title="${esc(fmtDateTime(r.created_at))}">${esc(ago(r.created_at))}</td>
        <td>${esc(alerts.length)} alerted<div class="cell-sub">${accepted ? `<span style="color:var(--green);font-weight:700">${esc(accepted)} accepted</span>` : 'none accepted'}</div></td>
        <td>${statusBadge(shown(r))}</td>
        <td class="actions"><button class="btn btn-outline btn-sm" data-action="open-sos" data-id="${esc(r.id)}">Details</button></td>
      </tr>`;
  }).join('')}</tbody></table></div>`
      : emptyHtml('🩸', s === 'active' ? 'No active SOS requests' : 'Nothing here', 'Emergency blood requests raised in the app appear here.');

    return `<div class="toolbar">${tabsHtml('blood', 'status', [['active', 'Active'], ['fulfilled', 'Fulfilled'], ['expired', 'Expired'], ['closed', 'Closed'], ['all', 'All']], s, counts)}</div>
      <div class="card">${table}</div>`;
  }

  ACTIONS['open-sos'] = async (id) => {
    const r = bloodRows.find((x) => x.id === id);
    if (!r) return;
    const alerts = bloodAlerts[r.id] || [];
    const canContact = can('blood.contact');
    const donorIds = alerts.map((a) => a.donor_id).filter(Boolean);
    const donors = {};
    if (donorIds.length && can('blood.contact', 'blood.manage')) {
      const { data } = await sb.from('blood_donors')
        .select(`id, pet_name, blood_group, city${canContact ? ', emergency_contact' : ''}`).in('id', donorIds);
      (data || []).forEach((d) => { donors[d.id] = d; });
    }
    const requester = bloodPeople[r.requester_id];
    openModal({
      title: `${r.pet_name} needs ${r.blood_group}`,
      subtitle: `Raised ${fmtDateTime(r.created_at)} · expires ${fmtDateTime(r.expires_at)}`,
      wide: true,
      body: `
        <div class="detail-grid">
          <div class="detail"><div class="k">Hospital</div><div class="v">${esc(r.hospital_name)}, ${esc(r.hospital_city)}</div></div>
          <div class="detail"><div class="k">Hospital phone</div><div class="v">${r.hospital_contact ? `<a href="tel:${esc(r.hospital_contact)}">${esc(r.hospital_contact)}</a>` : '—'}</div></div>
          <div class="detail"><div class="k">Requested by</div><div class="v">${personCell(requester, r.requester_id)}</div></div>
          <div class="detail"><div class="k">Requester phone</div><div class="v">${requester?.phone ? `<a href="tel:${esc(requester.phone)}">${esc(requester.phone)}</a>` : '—'}</div></div>
          <div class="detail"><div class="k">Urgency</div><div class="v">${esc(titleCase(r.urgency_level))}</div></div>
          <div class="detail"><div class="k">Status</div><div class="v">${statusBadge(isExpired(r) ? 'expired' : r.status)}</div></div>
        </div>
        <div class="section-title">Donors alerted (${esc(alerts.length)})</div>
        ${alerts.length ? `<div class="list-rows">${alerts.map((a) => {
    const d = donors[a.donor_id];
    return `<div class="list-row"><span>🐾</span><div class="grow"><div class="cell-main">${esc(d?.pet_name || 'Donor')}</div>
          <div class="cell-sub">${esc(d ? `${d.blood_group} · ${d.city}` : '')}${a.responded_at ? ` · answered ${esc(ago(a.responded_at))}` : ''}</div></div>
          ${canContact && d?.emergency_contact ? `<a class="btn btn-ghost btn-sm" href="tel:${esc(d.emergency_contact)}">📞 ${esc(d.emergency_contact)}</a>` : ''}
          ${statusBadge(a.status)}</div>`;
  }).join('')}</div>` : '<p class="note" style="margin:0">No donors were alerted. There may have been no eligible donor nearby.</p>'}`,
      foot: can('blood.manage') && r.status === 'active'
        ? '<button class="btn btn-danger-outline" data-action="m" data-id="close">Close request</button>' : '',
      handlers: {
        close: async (btn) => {
          const ok = await confirmBox({ title: 'Close this request?', message: 'Donors stop seeing it. Use this for duplicates, tests, or when the family says it is resolved.', confirmLabel: 'Close request', tone: 'danger', field: { label: 'Reason', required: true } });
          if (ok == null) return;
          await busy(btn, async () => {
            await act('blood_request.close', r.id, { reason: ok });
            toast('Request closed.', 'success');
            renderCurrent(); refreshCounts();
          });
        },
      },
    });
  };

  async function renderCalls() {
    const rows = await q(sb.from('donor_contact_escalations').select('*').order('created_at', { ascending: false }).limit(LIST_LIMIT));
    escalationRows = rows;
    const reqIds = [...new Set(rows.map((r) => r.request_id).filter(Boolean))];
    const donorIds = [...new Set(rows.map((r) => r.donor_id).filter(Boolean))];
    const requests = {};
    const donors = {};
    if (reqIds.length) (await sb.from('blood_requests').select('id, pet_name, blood_group, hospital_name, hospital_city, status').in('id', reqIds)).data?.forEach((x) => { requests[x.id] = x; });
    if (donorIds.length) (await sb.from('blood_donors').select(`id, pet_name, blood_group, city${can('blood.contact') ? ', emergency_contact' : ''}`).in('id', donorIds)).data?.forEach((x) => { donors[x.id] = x; });
    const people = await profilesFor(rows.flatMap((r) => [r.requester_id, r.donor_user_id]));
    rows.forEach((r) => { r._req = requests[r.request_id]; r._donor = donors[r.donor_id]; r._requester = people[r.requester_id]; r._owner = people[r.donor_user_id]; });

    const counts = { all: rows.length };
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const s = state.blood.status;
    const list = s === 'all' ? rows : s === 'done'
      ? rows.filter((r) => ['closed', 'donor_declined', 'unreachable'].includes(r.status))
      : rows.filter((r) => r.status === s);
    counts.done = (counts.closed || 0) + (counts.donor_declined || 0) + (counts.unreachable || 0);

    const table = list.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Asked</th><th>For</th><th>Donor to call</th><th>Requester</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr>
        <td class="nowrap" title="${esc(fmtDateTime(r.created_at))}">${esc(ago(r.created_at))}</td>
        <td>${r._req ? `<div class="cell-main">${esc(r._req.pet_name)} <span class="badge b-red">${esc(r._req.blood_group)}</span></div><div class="cell-sub">${esc(r._req.hospital_name)}, ${esc(r._req.hospital_city)}</div>` : '<span class="cell-sub">Request removed</span>'}</td>
        <td><div class="cell-main">${esc(r._donor?.pet_name || 'Donor')}</div><div class="cell-sub">${r._donor?.emergency_contact ? `<a href="tel:${esc(r._donor.emergency_contact)}">📞 ${esc(r._donor.emergency_contact)}</a>` : esc(r._owner?.full_name || '')}</div></td>
        <td>${personCell(r._requester, r.requester_id, r._requester?.phone || undefined)}</td>
        <td>${statusBadge(r.status)}${r.staff_note ? `<div class="cell-sub cell-clip">${esc(r.staff_note)}</div>` : ''}</td>
        <td class="actions"><button class="btn btn-outline btn-sm" data-action="edit-call" data-id="${esc(r.id)}">Update</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('📞', s === 'open' ? 'No call requests waiting' : 'Nothing here', 'When a requester cannot reach a donor in the app, they can ask the team to call. Those requests land here.');

    return `<div class="toolbar">${tabsHtml('blood', 'status', [['open', 'Open'], ['contacted', 'Contacted'], ['done', 'Done'], ['all', 'All']], s, counts)}</div>
      <div class="card">${table}</div>
      ${can('blood.contact') ? '' : '<p class="note">Phone numbers are shown only to roles with the blood.contact permission.</p>'}`;
  }

  ACTIONS['edit-call'] = (id) => {
    const r = escalationRows.find((x) => x.id === id);
    if (!r) return;
    openModal({
      title: 'Update call request',
      subtitle: r._req ? `${r._req.pet_name} · ${r._req.blood_group} · ${r._req.hospital_name}` : '',
      body: `
        ${r.note ? `<div class="field"><label>Requester’s note</label><div class="quote">${esc(r.note)}</div></div>` : ''}
        <div class="field"><label for="callStatus">Outcome</label>
          <select class="select" id="callStatus">${[['open', 'Open — not called yet'], ['contacted', 'Contacted — donor is helping'], ['donor_declined', 'Donor declined'], ['unreachable', 'Could not reach donor'], ['closed', 'Closed']]
    .map(([v, l]) => `<option value="${v}" ${v === r.status ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="callNote">Staff note</label>
          <textarea class="textarea" id="callNote" placeholder="Who you spoke to, what was agreed">${esc(r.staff_note || '')}</textarea></div>
        ${r.handled_by ? `<p class="note" style="margin:0">Last updated by ${esc(r.handled_by)} ${esc(ago(r.handled_at))}.</p>` : ''}`,
      foot: '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="m" data-id="save">Save</button>',
      handlers: {
        save: async (btn) => {
          await busy(btn, async () => {
            await act('escalation.update', r.id, { status: $('#callStatus').value, staff_note: $('#callNote').value.trim() || null });
            closeModal();
            toast('Call request updated.', 'success');
            renderCurrent(); refreshCounts();
          });
        },
      },
    });
  };

  async function renderDonors() {
    const contact = can('blood.contact');
    const rows = await q(sb.from('blood_donors')
      .select(`id, pet_name, species, breed, blood_group, city, area, is_available, last_donation_at, user_id, created_at${contact ? ', emergency_contact' : ''}`)
      .order('created_at', { ascending: false }).limit(500));
    const people = await profilesFor(rows.map((d) => d.user_id));
    const resting = (d) => d.last_donation_at && (Date.now() - new Date(d.last_donation_at)) < 90 * 864e5;
    const table = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Donor</th><th>Blood group</th><th>City</th><th>Availability</th><th class="hide-sm">Owner</th>${contact ? '<th>Contact</th>' : ''}</tr></thead><tbody>
      ${rows.map((d) => `<tr>
        <td><div class="cell-main">${esc(d.pet_name)}</div><div class="cell-sub">${esc(d.breed || titleCase(d.species))}</div></td>
        <td><span class="badge b-red">${esc(d.blood_group)}</span></td>
        <td>${esc(d.city)}${d.area ? `<div class="cell-sub">${esc(d.area)}</div>` : ''}</td>
        <td>${resting(d) ? `${badge('Resting', 'amber')}<div class="cell-sub">until ${esc(fmtDate(new Date(new Date(d.last_donation_at).getTime() + 90 * 864e5)))}</div>` : d.is_available ? badge('Available', 'green') : badge('Paused', 'slate')}</td>
        <td class="hide-sm">${personCell(people[d.user_id], d.user_id)}</td>
        ${contact ? `<td>${d.emergency_contact ? `<a href="tel:${esc(d.emergency_contact)}">${esc(d.emergency_contact)}</a>` : '—'}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('🐾', 'No registered donors', 'Pets registered as blood donors in the app appear here.');
    return `<div class="card">${table}</div>`;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Home banners
  // ════════════════════════════════════════════════════════════════════════════
  let bannerRows = [];

  function bannerState(b) {
    const now = Date.now();
    if (!b.is_active) return ['Draft', 'slate'];
    if (b.starts_at && new Date(b.starts_at) > now) return ['Scheduled', 'blue'];
    if (b.ends_at && new Date(b.ends_at) < now) return ['Ended', 'slate'];
    return ['Live', 'green'];
  }

  function bannerPreview(b) {
    const img = safeUrl(b.image_url);
    const bg = /^#[0-9a-f]{3,8}$/i.test(b.background_color || '') ? b.background_color : '#142C73';
    const fg = /^#[0-9a-f]{3,8}$/i.test(b.text_color || '') ? b.text_color : '#FFFFFF';
    return `<div class="banner-preview" style="background-color:${bg};${img ? `background-image:url('${esc(img)}');` : ''}color:${fg}">
      <h4>${esc(b.title || 'Banner title')}</h4>${b.subtitle ? `<p>${esc(b.subtitle)}</p>` : ''}
      ${b.cta_text ? `<span class="cta">${esc(b.cta_text)}</span>` : ''}</div>`;
  }

  RENDER.banners = async () => {
    const rows = await q(sb.from('promo_banners').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }));
    bannerRows = rows;
    const live = rows.filter((b) => bannerState(b)[0] === 'Live').length;
    const grid = rows.length ? `<div class="banner-grid">${rows.map((b) => {
      const [label, tone] = bannerState(b);
      return `<div class="card banner-card">${bannerPreview(b)}
        <div class="banner-meta">${badge(label, tone)}<span class="cell-sub">#${esc(b.sort_order ?? 0)}${b.ends_at ? ` · until ${esc(fmtDate(b.ends_at))}` : ''}</span>
          <span class="actions"><button class="btn btn-outline btn-sm" data-action="edit-banner" data-id="${esc(b.id)}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-action="delete-banner" data-id="${esc(b.id)}">Delete</button></span></div></div>`;
    }).join('')}</div>`
      : `<div class="card">${emptyHtml('🖼️', 'No banners', 'With no live banners the app shows no carousel at all. Add one to promote an offer or product.')}</div>`;
    return `<div class="toolbar"><p class="cell-sub grow">${esc(live)} live · lower numbers show first. Only offers that really exist in the shop should go here.</p>
      <button class="btn btn-primary" data-action="edit-banner" data-id="new">+ New banner</button></div>${grid}`;
  };

  const toLocalInput = (v) => {
    if (!v) return '';
    const d = new Date(v);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  ACTIONS['edit-banner'] = (id) => {
    const b = id === 'new'
      ? { title: '', subtitle: '', image_url: '', cta_text: 'Shop now', route_url: '/shop', background_color: '#142C73', text_color: '#FFFFFF', sort_order: (bannerRows.length + 1) * 10, is_active: false }
      : { ...bannerRows.find((x) => x.id === id) };
    if (!b) return;

    const read = () => ({
      title: $('#bnTitle').value.trim(),
      subtitle: $('#bnSubtitle').value.trim() || null,
      image_url: $('#bnImage').value.trim(),
      cta_text: $('#bnCta').value.trim() || null,
      route_url: $('#bnRoute').value.trim() || null,
      background_color: $('#bnBg').value,
      text_color: $('#bnFg').value,
      sort_order: Number($('#bnOrder').value) || 0,
      is_active: $('#bnActive').checked,
      starts_at: $('#bnStart').value ? new Date($('#bnStart').value).toISOString() : null,
      ends_at: $('#bnEnd').value ? new Date($('#bnEnd').value).toISOString() : null,
    });

    openModal({
      title: id === 'new' ? 'New banner' : 'Edit banner',
      wide: true,
      body: `
        <div id="bnPreview" class="banner-edit-preview">${bannerPreview(b)}</div>
        <div class="field-row">
          <div class="field"><label for="bnTitle">Title *</label><input class="input" id="bnTitle" maxlength="60" value="${esc(b.title)}"></div>
          <div class="field"><label for="bnSubtitle">Subtitle</label><input class="input" id="bnSubtitle" maxlength="90" value="${esc(b.subtitle || '')}"></div>
        </div>
        <div class="field"><label for="bnFile">Image *</label>
          <div class="image-drop"><img id="bnThumb" src="${esc(safeUrl(b.image_url))}" alt="" ${safeUrl(b.image_url) ? '' : 'hidden'}>
            <div class="grow"><input type="file" id="bnFile" accept="image/png,image/jpeg,image/webp">
            <div class="hint">PNG, JPG or WebP, up to 2 MB. Wide images (about 2.2 : 1) look best.</div></div></div>
          <input class="input" id="bnImage" placeholder="…or paste an https:// image URL" value="${esc(b.image_url || '')}" style="margin-top:8px"></div>
        <div class="field-row">
          <div class="field"><label for="bnCta">Button text</label><input class="input" id="bnCta" maxlength="24" value="${esc(b.cta_text || '')}"></div>
          <div class="field"><label for="bnRoute">Opens</label><input class="input" id="bnRoute" value="${esc(b.route_url || '')}" placeholder="/shop or /shop/product/<id>">
            <span class="hint">An app screen path, e.g. /shop</span></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="bnBg">Background colour</label><input class="input" type="color" id="bnBg" value="${esc(b.background_color || '#142C73')}" style="height:42px;padding:4px"></div>
          <div class="field"><label for="bnFg">Text colour</label><input class="input" type="color" id="bnFg" value="${esc(b.text_color || '#FFFFFF')}" style="height:42px;padding:4px"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="bnStart">Show from</label><input class="input" type="datetime-local" id="bnStart" value="${esc(toLocalInput(b.starts_at))}"></div>
          <div class="field"><label for="bnEnd">Show until</label><input class="input" type="datetime-local" id="bnEnd" value="${esc(toLocalInput(b.ends_at))}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="bnOrder">Order</label><input class="input" type="number" id="bnOrder" value="${esc(b.sort_order ?? 0)}"></div>
          <div class="field" style="justify-content:flex-end"><label class="check"><input type="checkbox" id="bnActive" ${b.is_active ? 'checked' : ''}> Active (shown in the app)</label></div>
        </div>`,
      foot: '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="m" data-id="save">Save banner</button>',
      handlers: {
        save: async (btn) => {
          const fields = read();
          if (!fields.title) { toast('Add a title.', 'warning'); return; }
          if (!safeUrl(fields.image_url)) { toast('Add an image (upload one or paste an https:// URL).', 'warning'); return; }
          if (fields.starts_at && fields.ends_at && fields.ends_at <= fields.starts_at) { toast('“Show until” must be after “Show from”.', 'warning'); return; }
          await busy(btn, async () => {
            await act('banner.save', id, { banner: fields });
            closeModal();
            toast('Banner saved.', 'success');
            renderCurrent();
          });
        },
      },
    });

    const repaint = () => { $('#bnPreview').innerHTML = bannerPreview(read()); };
    ['bnTitle', 'bnSubtitle', 'bnCta', 'bnBg', 'bnFg', 'bnImage'].forEach((f) => document.getElementById(f).addEventListener('input', repaint));
    const setThumb = (url) => { $('#bnThumb').src = url; $('#bnThumb').hidden = !url; };
    $('#bnImage').addEventListener('change', () => setThumb(safeUrl($('#bnImage').value.trim())));
    $('#bnFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Use a PNG, JPG or WebP image.', 'warning'); return; }
      if (file.size > 2 * 1024 * 1024) { toast('That image is over 2 MB. Please use a smaller one.', 'warning'); return; }
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
      toast('Uploading image…');
      const { error } = await sb.storage.from('promo-banners').upload(path, file, { contentType: file.type, upsert: false });
      if (error) { toast('Could not upload the image.', 'error'); return; }
      // Record who uploaded it (the Storage policy already required
      // banners.manage for the upload itself).
      act('banner.image_uploaded', 'new', { path }).catch(() => {});
      const { data } = sb.storage.from('promo-banners').getPublicUrl(path);
      $('#bnImage').value = data.publicUrl;
      setThumb(data.publicUrl);
      repaint();
      toast('Image uploaded.', 'success');
    });
  };

  ACTIONS['delete-banner'] = async (id, btn) => {
    const b = bannerRows.find((x) => x.id === id);
    if (!b) return;
    const ok = await confirmBox({ title: `Delete “${b.title}”?`, message: 'It disappears from the app. This cannot be undone — to hide it for now, edit it and turn Active off instead.', confirmLabel: 'Delete', tone: 'danger' });
    if (ok == null) return;
    await busy(btn, async () => {
      await act('banner.delete', id);
      toast('Banner deleted.', 'success');
      renderCurrent();
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // Notifications (announcements)
  // ════════════════════════════════════════════════════════════════════════════
  // Screens an announcement may open. The database (announcement_link_ok) and
  // the app accept only these.
  const ANNOUNCE_LINKS = [
    ['', 'Notifications inbox'],
    ['/home', 'Home'],
    ['/shop', 'Shop'],
    ['/pet-match', 'Pet Match'],
    ['/pet-care', 'Pet Care'],
    ['/blood-bank', 'Blood bank'],
    ['/pet-services', 'Pet services'],
    ['/my-pet', 'My pets'],
    ['/subscriptions', 'Subscriptions'],
    ['/home/loyalty', 'Paw Points'],
  ];
  const AUDIENCES = [
    ['all', 'Everyone'],
    ['city', 'People in one city'],
    ['donors', 'Registered blood donors'],
    ['user', 'One person'],
  ];
  const GROUP_LIMIT = 3;
  const blankAnnouncement = () => ({ title: '', body: '', audience: 'all', audience_value: '', link: '' });
  let announceDraft = blankAnnouncement();

  function audienceLabel(a, v) {
    if (a === 'city') return `People in ${v || '?'}`;
    if (a === 'user') return `One person (${v || '?'})`;
    return (AUDIENCES.find(([k]) => k === a) || [a, titleCase(a)])[1];
  }

  function pushPreview(d) {
    return `<div class="push-preview"><div class="push-head"><span class="push-app">🐾</span><span>Doggy Ji</span><span class="grow"></span><span>now</span></div>
      <div class="push-title">${esc(d.title || 'Title')}</div><div class="push-body">${esc(d.body || 'Your message appears here.')}</div></div>`;
  }

  RENDER.announce = async () => {
    const rows = await q(sb.from('admin_broadcasts').select('*').order('created_at', { ascending: false }).limit(50));
    const dayAgo = Date.now() - 864e5;
    const used = rows.filter((r) => r.audience !== 'user' && r.status !== 'failed' && new Date(r.created_at) > dayAgo).length;
    const d = announceDraft;
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');

    const form = `<div class="card card-pad">
      <div class="field-row">
        <div class="field"><label for="anAudience">Send to</label><select class="select" id="anAudience">${opt(AUDIENCES, d.audience)}</select></div>
        <div class="field" id="anValueField" ${d.audience === 'city' || d.audience === 'user' ? '' : 'hidden'}>
          <label for="anValue" id="anValueLabel">${d.audience === 'user' ? 'Username or user id' : 'City'}</label>
          <input class="input" id="anValue" maxlength="80" value="${esc(d.audience_value)}" placeholder="${d.audience === 'user' ? '@username' : 'e.g. Bengaluru'}"></div>
      </div>
      <div class="field"><label for="anTitle">Title * <span class="cell-sub" id="anTitleCount"></span></label>
        <input class="input" id="anTitle" maxlength="65" value="${esc(d.title)}" placeholder="e.g. New: Ragi Shots Mini"></div>
      <div class="field"><label for="anBody">Message * <span class="cell-sub" id="anBodyCount"></span></label>
        <textarea class="textarea" id="anBody" maxlength="240" placeholder="What do you want people to know?">${esc(d.body)}</textarea></div>
      <div class="field"><label for="anLink">Tapping it opens</label><select class="select" id="anLink">${opt(ANNOUNCE_LINKS, d.link)}</select></div>
      <p class="cell-sub" id="anReach">Check the reach before sending.</p>
      <div class="toolbar" style="margin:12px 0 0">
        <button class="btn btn-outline" data-action="announce-preview">Check reach</button>
        <span class="grow"></span>
        <button class="btn btn-primary" data-action="announce-send">Send announcement</button>
      </div>
      <p class="note">Group announcements used in the last 24 hours: ${esc(used)} of ${GROUP_LIMIT}. Messages to one person are not limited.
        People who turned off “News &amp; announcements” in the app get the inbox message without a push. Suspended accounts get nothing.</p>
    </div>`;

    const preview = `<div class="card card-pad"><div class="section-title" style="margin-top:0">Preview</div><div id="anPreview">${pushPreview(d)}</div>
      <p class="note">Every recipient also finds it in the app under Notifications, even if the push does not reach their phone.</p></div>`;

    const history = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Sent</th><th>Announcement</th><th>Audience</th><th>Reach</th><th>Status</th><th class="hide-sm">By</th></tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td class="nowrap">${esc(fmtDateTime(r.created_at))}</td>
        <td><div class="cell-main">${esc(r.title)}</div><div class="cell-sub">${esc(r.body)}</div></td>
        <td>${esc(audienceLabel(r.audience, r.audience_value))}</td>
        <td class="nowrap">${esc(r.recipients)} in inbox<div class="cell-sub">${esc(r.delivered)} of ${esc(r.devices)} phones${r.failed ? ` · ${esc(r.failed)} failed` : ''}</div></td>
        <td>${badge(titleCase(r.status), { sent: 'green', sending: 'amber', failed: 'red' }[r.status] || 'slate')}</td>
        <td class="hide-sm cell-sub">${esc(r.sent_by)}</td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('📣', 'Nothing sent yet', 'Announcements you send appear here with how many people they reached.');

    return `<div class="grid-2">${form}${preview}</div><div class="section-title">Sent</div><div class="card">${history}</div>`;
  };

  function readAnnouncement() {
    announceDraft = {
      title: $('#anTitle').value.trim(),
      body: $('#anBody').value.trim(),
      audience: $('#anAudience').value,
      audience_value: $('#anValue').value.trim(),
      link: $('#anLink').value,
    };
    return announceDraft;
  }

  function announcementProblem(d) {
    if (!d.title) return 'Add a title.';
    if (!d.body) return 'Add a message.';
    if (d.audience === 'city' && !d.audience_value) return 'Enter the city.';
    if (d.audience === 'user' && !d.audience_value) return 'Enter the username or user id.';
    return null;
  }

  AFTER.announce = () => {
    const counts = () => {
      $('#anTitleCount').textContent = `${$('#anTitle').value.length}/65`;
      $('#anBodyCount').textContent = `${$('#anBody').value.length}/240`;
    };
    const repaint = () => {
      const d = readAnnouncement();
      $('#anPreview').innerHTML = pushPreview(d);
      counts();
    };
    ['anTitle', 'anBody', 'anValue', 'anLink'].forEach((f) => document.getElementById(f).addEventListener('input', repaint));
    $('#anAudience').addEventListener('change', () => {
      const a = $('#anAudience').value;
      $('#anValueField').hidden = !(a === 'city' || a === 'user');
      $('#anValueLabel').textContent = a === 'user' ? 'Username or user id' : 'City';
      $('#anValue').placeholder = a === 'user' ? '@username' : 'e.g. Bengaluru';
      $('#anValue').value = '';
      $('#anReach').textContent = 'Check the reach before sending.';
      readAnnouncement();
    });
    counts();
  };

  async function announcementReach(d) {
    const r = await act('broadcast.preview', 'new', { broadcast: d });
    return { people: Number(r?.recipients ?? 0), phones: Number(r?.push_recipients ?? 0) };
  }

  ACTIONS['announce-preview'] = async (_, btn) => {
    const d = readAnnouncement();
    if ((d.audience === 'city' || d.audience === 'user') && !d.audience_value) { toast(announcementProblem(d), 'warning'); return; }
    await busy(btn, async () => {
      const { people, phones } = await announcementReach(d);
      $('#anReach').textContent = people
        ? `Reaches ${people} ${people === 1 ? 'person' : 'people'} in the inbox; ${phones} of them get a push on their phone.`
        : 'Nobody matches this audience.';
    });
  };

  ACTIONS['announce-send'] = async (_, btn) => {
    const d = readAnnouncement();
    const problem = announcementProblem(d);
    if (problem) { toast(problem, 'warning'); return; }
    const reach = await busy(btn, () => announcementReach(d));
    if (!reach) return;
    if (!reach.people) { toast('Nobody matches this audience.', 'warning'); return; }
    const ok = await confirmBox({
      title: `Send to ${reach.people} ${reach.people === 1 ? 'person' : 'people'}?`,
      message: `“${d.title}” goes to ${audienceLabel(d.audience, d.audience_value).toLowerCase()}: ${reach.people} in the inbox, ${reach.phones} with a push. It cannot be recalled once sent.`,
      confirmLabel: 'Send now',
    });
    if (ok == null) return;
    await busy(btn, async () => {
      const r = await act('broadcast.send', 'new', { broadcast: d });
      if (r?.push_error) toast(r.push_error, 'warning');
      else toast(`Sent: ${r.recipients} in the inbox, ${r.delivered} of ${r.devices} phones reached.`, 'success');
      if (r?.history_error) toast(r.history_error, 'warning');
      announceDraft = blankAnnouncement();
      renderCurrent();
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // Orders (read-only)
  // ════════════════════════════════════════════════════════════════════════════
  let orderRows = [];

  RENDER.orders = async () => {
    const term = state.orders.q.replace(/[,()%*]/g, ' ').trim();
    let query = sb.from('orders').select('*').order('placed_at', { ascending: false }).limit(200);
    if (term) query = query.or(['id', 'shopify_order_id', 'customer_name', 'customer_email', 'customer_phone'].map((c) => `${c}.ilike.%${term}%`).join(','));
    const rows = await q(query);
    orderRows = rows;
    const table = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Order</th><th>Customer</th><th>Placed</th><th>Total</th><th>Status</th><th class="hide-sm">Account</th><th></th></tr></thead><tbody>
      ${rows.map((o) => `<tr>
        <td><div class="cell-main">${esc(o.id)}</div>${o.coupon_code ? `<div class="cell-sub">Coupon ${esc(o.coupon_code)}</div>` : ''}</td>
        <td><div>${esc(o.customer_name || '—')}</div><div class="cell-sub">${esc(o.customer_email || o.customer_phone || '')}</div></td>
        <td class="nowrap">${esc(fmtDateTime(o.placed_at))}</td>
        <td>${esc(money(o.total_amount))}</td>
        <td>${badge(titleCase(o.status || 'unknown'), 'blue')}</td>
        <td class="hide-sm">${o.user_id ? badge('Linked', 'teal') : '<span class="cell-sub">Guest</span>'}</td>
        <td class="actions"><button class="btn btn-outline btn-sm" data-action="open-order" data-id="${esc(o.id)}">View</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('📦', term ? 'No matching orders' : 'No orders yet', term ? 'Try an order number, name, email or phone.' : 'Shopify orders appear here once the order webhook records them.');
    return `<div class="toolbar"><input class="input search" id="orderSearch" placeholder="Search order number, name, email or phone" value="${esc(state.orders.q)}">
      <span class="grow"></span><span class="cell-sub">To change an order, use Shopify admin.</span></div><div class="card">${table}</div>`;
  };

  AFTER.orders = () => {
    const input = document.getElementById('orderSearch');
    if (!input) return;
    input.addEventListener('input', debounce(() => {
      state.orders.q = input.value;
      renderCurrent().then(() => {
        const again = document.getElementById('orderSearch');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    }, 400));
  };

  ACTIONS['open-order'] = async (id) => {
    const o = orderRows.find((x) => x.id === id);
    if (!o) return;
    const { data: items } = await sb.from('order_items').select('*').eq('order_id', o.id);
    openModal({
      title: `Order ${o.id}`,
      subtitle: `Placed ${fmtDateTime(o.placed_at)} · ${titleCase(o.status || '')}`,
      wide: true,
      body: `
        <div class="detail-grid">
          <div class="detail"><div class="k">Customer</div><div class="v">${esc(o.customer_name || '—')}</div></div>
          <div class="detail"><div class="k">Contact</div><div class="v">${esc(o.customer_email || '—')}<br>${esc(o.customer_phone || '')}</div></div>
          <div class="detail full"><div class="k">Ship to</div><div class="quote">${esc(o.shipping_address || '—')}</div></div>
        </div>
        <div class="section-title">Items</div>
        ${(items || []).length ? `<div class="list-rows">${items.map((i) => `<div class="list-row"><div class="grow"><div class="cell-main">${esc(i.name)}</div>
          <div class="cell-sub">${esc(i.pack_name || '')}${i.is_subscription ? ' · subscription' : ''}</div></div>
          <span>${esc(i.quantity)} × ${esc(money(i.unit_price))}</span></div>`).join('')}</div>` : '<p class="note" style="margin:0">No line items recorded.</p>'}
        <div class="detail-grid" style="margin-top:14px">
          <div class="detail"><div class="k">Subtotal</div><div class="v">${esc(money(o.subtotal))}</div></div>
          <div class="detail"><div class="k">Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ''}</div><div class="v">${esc(money(o.discount_amount))}</div></div>
          <div class="detail"><div class="k">Shipping</div><div class="v">${esc(money(o.shipping_amount))}</div></div>
          <div class="detail"><div class="k">Total</div><div class="v cell-main">${esc(money(o.total_amount))}</div></div>
        </div>`,
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // Staff & roles
  // ════════════════════════════════════════════════════════════════════════════
  let staffRows = [];
  let roleRows = [];

  RENDER.staff = async () => {
    const [staff, roles, rolePerms, perms] = await Promise.all([
      q(sb.from('admin_users').select('*').order('created_at', { ascending: true })),
      q(sb.from('admin_roles').select('*').order('name')),
      q(sb.from('admin_role_permissions').select('*')),
      q(sb.from('admin_permissions').select('*').order('id')),
    ]);
    staffRows = staff;
    roleRows = roles;
    const roleName = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    const manage = can('employees.manage');
    const has = new Set(rolePerms.map((rp) => `${rp.role_id}|${rp.permission_id}`));

    const table = `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Staff member</th><th>Role</th><th>Status</th><th class="hide-sm">Login</th><th class="hide-sm">Employee ID</th><th></th></tr></thead><tbody>
      ${staff.map((s) => `<tr>
        <td>${personCell({ full_name: s.full_name }, s.id, s.email)}</td>
        <td>${esc(roleName[s.role_id] || s.role_id)}</td>
        <td>${s.status === 'active' ? badge('Active', 'green') : statusBadge(s.status)}</td>
        <td class="hide-sm">${s.auth_user_id ? badge('Linked', 'teal') : badge('No login yet', 'amber')}</td>
        <td class="hide-sm mono">${esc(s.employee_id)}</td>
        <td class="actions">${manage && s.id !== me.staff.id ? `<button class="btn btn-outline btn-sm" data-action="edit-staff" data-id="${esc(s.id)}">Edit</button>` : s.id === me.staff.id ? '<span class="cell-sub">You</span>' : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;

    const matrix = `<div class="table-wrap"><table class="table matrix"><thead><tr><th>Permission</th>${roles.map((r) => `<th>${esc(r.name)}</th>`).join('')}</tr></thead><tbody>
      ${perms.map((p) => `<tr><td><div class="cell-main mono">${esc(p.id)}</div><div class="cell-sub">${esc(p.description)}</div></td>
        ${roles.map((r) => `<td>${has.has(`${r.id}|${p.id}`) ? '<span class="yes">✓</span>' : '<span class="no">—</span>'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;

    return `<div class="toolbar"><span class="grow"></span>${manage ? '<button class="btn btn-outline" data-action="create-staff">+ Create account</button><button class="btn btn-primary" data-action="invite-staff">+ Invite staff member</button>' : ''}</div>
      <div class="card">${table}</div>
      <div class="card" style="margin-top:20px"><div class="card-head"><div><h3>What each role can do</h3><p>Enforced by the database and the admin-action function, not by this page.</p></div></div>
      <div style="padding:8px 0 4px">${matrix}</div></div>`;
  };

  ACTIONS['invite-staff'] = () => {
    openModal({
      title: 'Invite a staff member',
      body: `
        <div class="field"><label for="invName">Full name *</label><input class="input" id="invName"></div>
        <div class="field"><label for="invEmail">Email *</label><input class="input" type="email" id="invEmail"></div>
        <div class="field"><label for="invRole">Role *</label><select class="select" id="invRole">${roleRows.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></div>
        <p class="note" style="margin:0">A new email gets an invitation with a link to set a password. If the email already has a DoggyJi account that signs in with Google, that account is linked instead and no email is sent: staff sign in with a password only, so give them one with <b>Reset password</b> on their row. An existing password-only account is refused, because it does not prove the email is theirs.</p>`,
      foot: '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="m" data-id="send">Send invite</button>',
      handlers: {
        send: async (btn) => {
          const full_name = $('#invName').value.trim();
          const email = $('#invEmail').value.trim().toLowerCase();
          if (!full_name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter a name and a valid email.', 'warning'); return; }
          await busy(btn, async () => {
            const result = await act('staff.invite', 'new', { full_name, email, role_id: $('#invRole').value, redirect_to: location.origin + location.pathname });
            closeModal();
            toast(result.invited
              ? `Invitation sent to ${email}.`
              : `${email} already had a Google account — linked, no email sent. Use Reset password on their row to give them a one-time password.`, 'success');
            renderCurrent();
          });
        },
      },
    });
  };

  /**
   * Shows a one-time password once. It is not kept anywhere in the page after
   * the box closes, and the server never records it.
   */
  function showTempPassword({ title, email, password, expires }) {
    openModal({
      title,
      subtitle: email,
      body: `
        <p style="margin-bottom:12px">Give this temporary password to them privately (in person or a direct message). It is shown <b>only now</b>.</p>
        <div class="field"><label for="tmpPw">Temporary password</label>
          <input class="input mono" id="tmpPw" readonly value="${esc(password)}"></div>
        <p class="note" style="margin:0">They sign in with ${esc(email)} and this password, and must then choose their own before doing anything else.
          It stops working on ${esc(fmtDate(expires))}.</p>`,
      foot: '<button class="btn btn-outline" data-action="m" data-id="copy">Copy password</button><button class="btn btn-primary" data-action="close-modal">Done</button>',
      handlers: {
        copy: async () => {
          try {
            await navigator.clipboard.writeText(password);
            toast('Password copied.', 'success');
          } catch (_) {
            $('#tmpPw').select();
            toast('Select the password and copy it.', 'warning');
          }
        },
      },
    });
  }

  ACTIONS['create-staff'] = () => {
    openModal({
      title: 'Create a staff account',
      body: `
        <div class="field"><label for="crName">Full name *</label><input class="input" id="crName"></div>
        <div class="field"><label for="crEmail">Email *</label><input class="input" type="email" id="crEmail"></div>
        <div class="field"><label for="crRole">Role *</label><select class="select" id="crRole">${roleRows.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></div>
        <p class="note" style="margin:0">Makes their login now, with no email sent. You get a temporary password to give them; at their first sign-in they must choose their own. Use this when invitation emails do not arrive. An email that already has a DoggyJi account is refused — use Invite for those.</p>`,
      foot: '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="m" data-id="create">Create account</button>',
      handlers: {
        create: async (btn) => {
          const full_name = $('#crName').value.trim();
          const email = $('#crEmail').value.trim().toLowerCase();
          if (!full_name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter a name and a valid email.', 'warning'); return; }
          await busy(btn, async () => {
            const r = await act('staff.create', 'new', { full_name, email, role_id: $('#crRole').value });
            renderCurrent();
            showTempPassword({ title: 'Account created', email, password: r.temp_password, expires: r.temp_password_expires_at });
          });
        },
      },
    });
  };

  ACTIONS['edit-staff'] = (id) => {
    const s = staffRows.find((x) => x.id === id);
    if (!s) return;
    openModal({
      title: s.full_name,
      subtitle: s.email,
      body: `
        <div class="field"><label for="stRole">Role</label><select class="select" id="stRole">${roleRows.map((r) => `<option value="${esc(r.id)}" ${r.id === s.role_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="stStatus">Status</label><select class="select" id="stStatus">${[['active', 'Active'], ['suspended', 'Suspended'], ['disabled', 'Disabled']]
    .map(([v, l]) => `<option value="${v}" ${v === s.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="hint">Suspended or disabled staff cannot use the portal. Their sign-in still works for the app.</span></div>`,
      foot: `${s.auth_user_id ? '<button class="btn btn-ghost left" data-action="m" data-id="reset">Reset password</button>' : ''}
        <button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="m" data-id="save">Save</button>`,
      handlers: {
        reset: async (btn) => {
          const ok = await confirmBox({
            title: `Reset ${s.full_name}'s password?`,
            message: 'Their current password stops working. You get a temporary one to give them, and they must choose their own at their next sign-in.',
            confirmLabel: 'Reset password', tone: 'danger',
          });
          if (ok == null) return;
          await busy(btn, async () => {
            const r = await act('staff.reset_password', s.id);
            showTempPassword({ title: 'Password reset', email: s.email, password: r.temp_password, expires: r.temp_password_expires_at });
          });
        },
        save: async (btn) => {
          const changes = {};
          if ($('#stRole').value !== s.role_id) changes.role_id = $('#stRole').value;
          if ($('#stStatus').value !== s.status) changes.status = $('#stStatus').value;
          if (!Object.keys(changes).length) { closeModal(); return; }
          await busy(btn, async () => {
            await act('staff.update', s.id, changes);
            closeModal();
            toast('Staff member updated.', 'success');
            renderCurrent();
          });
        },
      },
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // Audit log
  // ════════════════════════════════════════════════════════════════════════════
  let auditRows = [];

  const auditActor = (a) => a.actor?.name || a.actor?.email || a.actor?.employee_id || 'System';
  const auditTarget = (a) => [a.target?.type, a.target?.id ? shortId(a.target.id) : null].filter(Boolean).join(' · ') || '—';

  RENDER.audit = async () => {
    const rows = await q(sb.from('admin_audit_logs').select('*').order('created_at', { ascending: false }).limit(500));
    auditRows = rows;
    const { result, q: term } = state.audit;
    const t = term.trim().toLowerCase();
    const list = rows.filter((a) => (result === 'all' || a.result === result) &&
      (!t || `${a.event_name} ${auditActor(a)} ${a.target?.id || ''} ${a.target?.type || ''}`.toLowerCase().includes(t)));
    const counts = { all: rows.length };
    rows.forEach((a) => { counts[a.result] = (counts[a.result] || 0) + 1; });

    const table = list.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>When</th><th>Staff</th><th>Event</th><th class="hide-sm">Target</th><th>Result</th><th></th></tr></thead><tbody>
      ${list.map((a) => `<tr>
        <td class="nowrap">${esc(fmtDateTime(a.created_at))}</td>
        <td><div class="cell-main">${esc(auditActor(a))}</div><div class="cell-sub">${esc(a.actor?.role ? titleCase(a.actor.role) : '')}</div></td>
        <td class="mono">${esc(a.event_name)}</td>
        <td class="hide-sm">${esc(auditTarget(a))}</td>
        <td>${badge(a.result || '—', a.result === 'SUCCESS' ? 'green' : a.result === 'DENIED' ? 'red' : 'amber')}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm" data-action="open-audit" data-id="${esc(a.id)}">Inspect</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyHtml('📜', 'No matching entries', 'Staff actions are recorded here as they happen.');

    return `<div class="toolbar">
        ${tabsHtml('audit', 'result', [['all', 'All'], ['SUCCESS', 'Success'], ['DENIED', 'Denied'], ['FAILURE', 'Failed']], result, counts)}
        <span class="grow"></span>
        <input class="input search" id="auditSearch" placeholder="Search event, staff or target" value="${esc(term)}">
        ${can('audit.export') ? '<button class="btn btn-outline" data-action="export-audit">Export JSON</button>' : ''}
      </div><div class="card">${table}</div><p class="note">Showing the latest 500 entries. Entries cannot be edited or deleted.</p>`;
  };

  AFTER.audit = () => {
    const input = document.getElementById('auditSearch');
    if (!input) return;
    input.addEventListener('input', debounce(() => {
      state.audit.q = input.value;
      renderCurrent().then(() => {
        const again = document.getElementById('auditSearch');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    }, 300));
  };

  ACTIONS['open-audit'] = (id) => {
    const a = auditRows.find((x) => x.id === id);
    if (!a) return;
    openModal({
      title: a.event_name,
      subtitle: `${fmtDateTime(a.created_at)} · ${a.result}`,
      wide: true,
      body: `<div class="detail-grid">
          <div class="detail"><div class="k">Staff</div><div class="v">${esc(auditActor(a))}${a.actor?.email ? ` · ${esc(a.actor.email)}` : ''}</div></div>
          <div class="detail"><div class="k">Target</div><div class="v">${esc(a.target?.type || '—')} <span class="mono">${esc(a.target?.id || '')}</span></div></div>
          ${a.business?.reason_text ? `<div class="detail full"><div class="k">Reason</div><div class="quote">${esc(a.business.reason_text)}</div></div>` : ''}
        </div>
        <div class="section-title">Full record</div><pre class="json">${esc(JSON.stringify(a, null, 2))}</pre>`,
    });
  };

  ACTIONS['export-audit'] = () => {
    download(`doggyji-audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(auditRows, null, 2));
    toast(`Exported ${auditRows.length} entries.`, 'success');
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    themeIcon();
    if (landingError) {
      showAuth('signin');
      toast(`That link did not work: ${landingError}. Ask for a new one.`, 'error');
      history.replaceState(null, '', location.pathname);
      return;
    }
    const { data: { session } } = await sb.auth.getSession();
    if (session && (landingType === 'invite' || landingType === 'recovery')) {
      showAuth('set-password', landingType);
      return;
    }
    if (!session) { showAuth('signin'); return; }
    await enter(false);
  }

  boot();
})();

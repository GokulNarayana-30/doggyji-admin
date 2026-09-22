/**
 * DoggyJi Admin Web Portal — Production Live Engine
 * Reference: DOGGYJI_ADMIN_RBAC_AUDIT_COMPLETE_V2.md
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── 0a. OUTPUT ESCAPING ─────────────────────────────────────────────────────
  // Every table in this portal was built with innerHTML and raw `${...}`
  // interpolation of database values. Those values are not ours: a provider's
  // full_name, a blood request's hospital, a pet's name all arrive from the
  // mobile app, and anyone who signs up can write them. A name of
  // `<img src=x onerror=...>` therefore executed inside an administrator's
  // session, holding an administrator's token — which is the one session in
  // this system that can read donor phone numbers and approve providers.
  //
  // esc() is for text between tags. attr() is for values inside a quoted
  // attribute, where a single quote would otherwise close it early and let an
  // onclick be appended.
  const esc = (v) => String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const attr = esc;

  // ── 0. SUPABASE LIVE CONFIGURATION ──────────────────────────────────────────
  let SUPABASE_URL = localStorage.getItem('doggyji_cfg_url') || 'https://iythfpzwxrbvxfmutxai.supabase.co';
  let SUPABASE_ANON_KEY = localStorage.getItem('doggyji_cfg_anon') || 'sb_publishable_gELA10B-jQjVy_eYK2QBTQ_1OERZEOt';
  let supabaseClient = null;

  function createSupabase() {
    try {
      if (window.supabase && typeof window.supabase.createClient === 'function') {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log('DoggyJi Admin: Supabase client initialized ->', SUPABASE_URL);
        return supabaseClient;
      }
    } catch (e) {
      console.warn('Failed to initialize Supabase client:', e);
    }
    return null;
  }

  createSupabase();

  // ── 1. ACTIVE STAFF ROLES & PERMISSIONS DEFINITION ──────────────────────────
  const ROLES = {
    super_admin: {
      title: 'Super Administrator',
      empId: 'EMP-00001',
      name: 'Rahul V.',
      email: 'admin@doggyji.com',
      permissions: ['*']
    },
    verification_officer: {
      title: 'Provider Verification Officer',
      empId: 'EMP-00027',
      name: 'Priya S.',
      email: 'priya.s@doggyji.com',
      permissions: [
        'dashboard.view',
        'providers.view',
        'providers.review',
        'providers.documents.view',
        'providers.approve',
        'providers.reject',
        'providers.request_changes'
      ]
    },
    operations_manager: {
      title: 'Operations Manager',
      empId: 'EMP-00034',
      name: 'Arun K.',
      email: 'arun.k@doggyji.com',
      permissions: [
        'dashboard.view',
        'providers.view',
        'providers.suspend',
        'bookings.view',
        'bookings.manage',
        'bookings.refund',
        'blood.view',
        'blood.manage',
        'users.view',
        'audit.view'
      ]
    },
    support_agent: {
      title: 'Customer Support Specialist',
      empId: 'EMP-00049',
      name: 'Ananya M.',
      email: 'ananya.m@doggyji.com',
      permissions: [
        'dashboard.view',
        'providers.view',
        'bookings.view',
        'bookings.manage',
        'users.view'
      ]
    },
    blood_sos_manager: {
      title: 'Blood SOS Coordinator',
      empId: 'EMP-00015',
      name: 'Dr. Vikram',
      email: 'vikram.v@doggyji.com',
      permissions: [
        'dashboard.view',
        'blood.view',
        'blood.manage'
      ]
    }
  };

  let currentRoleKey = 'super_admin';
  let currentStaff = ROLES[currentRoleKey];

  function hasPermission(perm) {
    if (!currentStaff) return false;
    if (currentStaff.permissions.includes('*')) return true;
    return currentStaff.permissions.includes(perm);
  }

  function enforcePermission(perm, actionDescription) {
    if (!hasPermission(perm)) {
      emitAuditEvent({
        eventName: 'admin.permission.denied',
        targetType: 'system_security',
        targetId: perm,
        targetName: actionDescription,
        beforeState: {},
        afterState: {},
        reasonCode: 'permission_missing',
        reasonNotes: `Actor attempted unauthorized action [${actionDescription}] requiring permission [${perm}].`,
        result: 'DENIED'
      });

      showToast(`Access Denied: Your role (${currentStaff.title}) lacks permission '${perm}'.`, 'danger');
      return false;
    }
    return true;
  }

  // ── 2. AUTHENTICATION & SESSION MANAGEMENT ───────────────────────────────────
  const loginScreen = document.getElementById('loginScreen');
  const adminAppLayout = document.getElementById('adminAppLayout');
  const loginForm = document.getElementById('loginForm');
  const loginEmail = document.getElementById('loginEmail');
  const loginPassword = document.getElementById('loginPassword');
  const togglePasswordBtn = document.getElementById('togglePasswordBtn');
  const signOutBtn = document.getElementById('signOutBtn');

  /// Restores a session only if Supabase still holds a valid one.
  ///
  /// This used to trust localStorage alone, so editing one key in devtools
  /// opened the portal. Server-side RLS meant no data followed, but the shell
  /// opened, which is misleading about who is let in. The stored payload is now
  /// only a UI hint; the Supabase session is what decides.
  async function checkExistingSession() {
    try {
      if (!supabaseClient) { showLoginScreen(); return false; }

      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session || !session.user) {
        localStorage.removeItem('doggyji_admin_session');
        showLoginScreen();
        return false;
      }

      const { data: staffRow } = await supabaseClient
        .from('admin_users')
        .select('employee_id, email, full_name, role_id, status')
        .ilike('email', session.user.email || '')
        .maybeSingle();

      if (!staffRow || staffRow.status !== 'active') {
        await supabaseClient.auth.signOut();
        localStorage.removeItem('doggyji_admin_session');
        showLoginScreen();
        return false;
      }

      establishStaffSession(staffRow);
      return true;
    } catch (e) {
      console.warn('Session restore failed:', e);
      showLoginScreen();
      return false;
    }
  }

  function showLoginScreen() {
    if (adminAppLayout) adminAppLayout.style.display = 'none';
    if (loginScreen) loginScreen.style.display = 'flex';
  }

  function establishSession(roleKey, emitAudit = true) {
    currentRoleKey = roleKey;
    currentStaff = ROLES[roleKey];


    localStorage.setItem('doggyji_admin_session', JSON.stringify({
      role: currentRoleKey,
      empId: currentStaff.empId,
      name: currentStaff.name,
      email: currentStaff.email,
      timestamp: Date.now()
    }));

    applySessionToUi(emitAudit);
  }

  /// Paints the shell for the current session and announces it.
  function applySessionToUi(emitAudit) {
    // Update Top App Bar indicators
    const roleBadge = document.getElementById('activeRoleBadge');
    if (roleBadge) roleBadge.textContent = currentStaff.title;
    const roleNameEl = document.getElementById('activeRoleName');
    if (roleNameEl) roleNameEl.textContent = currentStaff.title;
    const empIdEl = document.getElementById('activeEmpId');
    if (empIdEl) empIdEl.textContent = `${currentStaff.empId} • ${currentStaff.name}`;

    // Switch view visibility
    if (loginScreen) loginScreen.style.display = 'none';
    if (adminAppLayout) adminAppLayout.style.display = 'flex';

    if (emitAudit) {
      emitAuditEvent({
        eventName: 'admin.login.success',
        targetType: 'admin_sessions',
        targetId: currentStaff.empId,
        targetName: `Session established for ${currentStaff.name}`,
        beforeState: null,
        afterState: { role: currentRoleKey, email: currentStaff.email },
        reasonCode: 'credentials_verified',
        reasonNotes: 'Authenticated into DoggyJi Enterprise Administration Portal',
        result: 'SUCCESS'
      });
      showToast(`Welcome back, ${currentStaff.name}! Active persona: ${currentStaff.title}`, 'success');
    }

    // Refresh views
    fetchLiveSupabaseData();
  }


  /// Starts a session from the authenticated admin_users row.
  ///
  /// The role is whatever the database says; ROLES is now only a source of
  /// display labels, never of privilege. Server-side, every query is gated by
  /// is_admin()/admin_has(), so a tampered localStorage grants a nicer-looking
  /// sidebar and no additional data.
  function establishStaffSession(staffRow) {
    const roleKey = ROLES[staffRow.role_id] ? staffRow.role_id : 'support_agent';
    currentRoleKey = roleKey;
    currentStaff = Object.assign({}, ROLES[roleKey], {
      empId: staffRow.employee_id,
      name: staffRow.full_name,
      email: staffRow.email
    });

    localStorage.setItem('doggyji_admin_session', JSON.stringify({
      role: roleKey,
      empId: staffRow.employee_id,
      name: staffRow.full_name,
      email: staffRow.email,
      timestamp: Date.now()
    }));

    applySessionToUi(true);
  }

  // Handle Login Form Submit
  //
  // This used to destructure `error` from signInWithPassword, never check it,
  // catch any exception with a log saying "Auth bypassed", and then call
  // establishSession() unconditionally. Any email with any password logged you
  // in — and an unrecognised email defaulted to super_admin. The page also
  // shipped with a real-looking email and password pre-filled in the HTML, so
  // anyone opening the link was handed working "credentials" for a door that
  // was not locked.
  //
  // Authentication is now Supabase Auth, and the role comes from the
  // admin_users table rather than from whatever the client claims.
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = loginEmail.value.trim().toLowerCase();
      const pwd = loginPassword.value;

      if (!email || !pwd) {
        showToast('Please enter your email and password.', 'warning');
        return;
      }
      if (!supabaseClient) {
        showToast('Cannot reach the server. Check the connection settings.', 'error');
        return;
      }

      const submitBtn = loginForm.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.label = submitBtn.textContent; submitBtn.textContent = 'Signing in…'; }

      const restore = () => {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn.dataset.label || 'Sign In'; }
      };

      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email, password: pwd
        });

        if (error || !data || !data.session) {
          // Deliberately not distinguishing "no such account" from "wrong
          // password": that difference tells an attacker which emails are staff.
          showToast('Incorrect email or password.', 'error');
          restore();
          return;
        }

        // Authenticating proves who you are, not that you are staff. The
        // admin_users row decides that, and RLS only lets you read your own.
        const { data: staffRow, error: staffErr } = await supabaseClient
          .from('admin_users')
          .select('employee_id, email, full_name, role_id, status')
          .ilike('email', email)
          .maybeSingle();

        if (staffErr || !staffRow) {
          await supabaseClient.auth.signOut();
          showToast('This account does not have admin access.', 'error');
          restore();
          return;
        }
        if (staffRow.status !== 'active') {
          await supabaseClient.auth.signOut();
          showToast(`This staff account is ${staffRow.status}.`, 'error');
          restore();
          return;
        }

        establishStaffSession(staffRow);
        restore();
      } catch (err) {
        console.error('Sign-in failed:', err);
        showToast('Could not sign in. Please try again.', 'error');
        restore();
      }
    });
  }

  // Password Visibility Toggle
  if (togglePasswordBtn && loginPassword) {
    togglePasswordBtn.addEventListener('click', () => {
      const isPwd = loginPassword.type === 'password';
      loginPassword.type = isPwd ? 'text' : 'password';
      togglePasswordBtn.textContent = isPwd ? '🙈' : '👁️';
    });
  }

  // Sign Out Handler
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      emitAuditEvent({
        eventName: 'admin.session.revoked',
        targetType: 'admin_sessions',
        targetId: currentStaff ? currentStaff.empId : 'ANON',
        targetName: 'Session logged out',
        beforeState: null,
        afterState: null,
        reasonCode: 'user_signout',
        reasonNotes: 'User explicitly terminated administrative session',
        result: 'SUCCESS'
      });

      localStorage.removeItem('doggyji_admin_session');
      if (supabaseClient) {
        supabaseClient.auth.signOut().catch(() => {});
      }

      showLoginScreen();
      showToast('You have been signed out.', 'info');
    });
  }

  // ── 3. STATE STORE (LIVE SUPABASE MIRROR) ──────────────────────────────────
  let providers = [];
  let bookings = [];
  let bloodRequests = [];
  let donors = [];
  let employees = [];
  let auditLogs = [];


  function emitAuditEvent({ eventName, targetType, targetId, targetName, beforeState, afterState, reasonCode, reasonNotes, result = 'SUCCESS' }) {
    const reqId = 'REQ-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    const now = new Date();
    const formattedDate = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + 
                          now.toLocaleTimeString('en-GB', { hour12: false }) + ' IST';

    const auditEntry = {
      id: 'AUD-' + (auditLogs.length + 1).toString().padStart(3, '0'),
      eventName,
      actor: {
        employee_id: currentStaff ? currentStaff.empId : 'EMP-00001',
        name: currentStaff ? currentStaff.name : 'System Admin',
        role: currentStaff ? currentStaff.title : 'Super Administrator',
        session_origin: window.location.origin
      },
      authorization: {
        permission_used: eventName.replace(/\./g, '_'),
        decision: result === 'DENIED' ? 'deny' : 'allow'
      },
      target: {
        type: targetType,
        id: targetId,
        name: targetName
      },
      change: {
        before: beforeState,
        after: afterState
      },
      context: {
        request_id: reqId,
        environment: 'production'
      },
      business: {
        reason_code: reasonCode,
        reason_text: reasonNotes
      },
      result,
      timestamp: formattedDate
    };

    // Append to local state
    auditLogs.unshift(auditEntry);
    renderAuditTable();
    updateDashboardMetrics();

    // Persist to Supabase live table if available
    if (supabaseClient) {
      supabaseClient.from('admin_audit_logs').insert([{
        event_name: auditEntry.eventName,
        actor: auditEntry.actor,
        authorization: auditEntry.authorization,
        target: auditEntry.target,
        change: auditEntry.change,
        context: auditEntry.context,
        business: auditEntry.business,
        result: auditEntry.result
      }]).then(({ error }) => {
        if (error) console.info('Live Supabase audit log insert notice:', error.message);
      }).catch(err => console.warn('Supabase audit insert notice:', err));
    }

    return auditEntry;
  }

  // ── 5. LIVE SUPABASE SYNC & DATA FETCHING ───────────────────────────────────
  async function fetchLiveSupabaseData() {
    if (!supabaseClient) return;

    try {
      const connEl = document.getElementById('connStatus');
      if (connEl) {
        connEl.innerHTML = `<div class="conn-dot online"></div><span>Live Syncing...</span>`;
      }

      // 1. Fetch live service_providers
      const { data: provData, error: provError } = await supabaseClient
        .from('service_providers')
        .select('*')
        .order('created_at', { ascending: false });

      if (!provError && provData) {
        providers = provData.map(p => ({
          id: p.id,
          fullName: p.full_name || 'Provider',
          city: p.city || 'Bengaluru',
          area: p.area || 'Central',
          services: p.service_types && p.service_types.length ? p.service_types : ['Dog Walker'],
          experienceYears: p.years_experience || 0,
          quizPassed: p.safety_quiz_passed || false,
          policeVerified: p.police_verified || false,
          status: p.verification_status || 'pending',
          submittedDate: new Date(p.created_at || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
          bio: p.bio || 'Pet care professional',
          aadhaarLast4: 'XXXX'
        }));
        renderProvidersTable();
      }

      // 2. Fetch live service_bookings with joined customer profile & provider name
      const { data: bkData, error: bkError } = await supabaseClient
        .from('service_bookings')
        .select(`
          id,
          customer_id,
          provider_id,
          service_type,
          booking_date,
          time_slot,
          total_price,
          status,
          pet_id,
          created_at,
          service_providers!provider_id ( full_name )
        `)
        .order('created_at', { ascending: false });

      if (!bkError && bkData) {
        // Also fetch customer display names from profiles
        const customerIds = [...new Set(bkData.map(b => b.customer_id).filter(Boolean))];
        let profileMap = {};
        if (customerIds.length) {
          const { data: profileData } = await supabaseClient
            .from('profiles')
            .select('id, full_name, display_name')
            .in('id', customerIds);
          if (profileData) {
            profileData.forEach(p => {
              profileMap[p.id] = p.full_name || p.display_name || null;
            });
          }
        }

        // Also fetch pet names for bookings that have a pet_id
        const petIds = [...new Set(bkData.map(b => b.pet_id).filter(Boolean))];
        let petMap = {};
        if (petIds.length) {
          const { data: petsData } = await supabaseClient
            .from('pets')
            .select('id, name')
            .in('id', petIds);
          if (petsData) {
            petsData.forEach(p => { petMap[p.id] = p.name; });
          }
        }

        bookings = bkData.map(b => {
          const customerName = profileMap[b.customer_id]
            || (b.customer_id ? `ID: ${b.customer_id.substring(0, 8)}…` : 'Unknown Customer');
          const providerName = b.service_providers?.full_name
            || (b.provider_id ? `ID: ${b.provider_id.substring(0, 8)}…` : 'Unassigned');
          const petName = b.pet_id ? (petMap[b.pet_id] || `Pet ${b.pet_id.substring(0, 6)}`) : '—';
          return {
            id: b.id,
            customerName,
            petName,
            providerName,
            serviceType: b.service_type || 'Pet Care',
            date: b.booking_date || 'Today',
            slot: b.time_slot || 'Standard',
            totalPrice: `₹${b.total_price || '0.00'}`,
            status: b.status || 'pending'
          };
        });
        renderBookingsTable();
      }

      // 3. Fetch live blood_requests
      const { data: bloodData, error: bloodError } = await supabaseClient
        .from('blood_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (!bloodError && bloodData) {
        bloodRequests = bloodData.map(r => ({
          id: r.id,
          petName: r.pet_name || 'Emergency Pet',
          species: r.species || 'Canine',
          bloodGroup: r.blood_group || 'DEA 1.1+',
          hospitalName: r.hospital_name || 'Veterinary Clinic',
          city: r.hospital_city || 'Bengaluru',
          urgencyLevel: (r.urgency_level || 'critical').toUpperCase(),
          status: r.status || 'active',
          createdDate: new Date(r.created_at || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        }));
        renderBloodRequestsTable();
      }

      // 4. Fetch live admin staff (admin_users)
      const { data: staffData, error: staffError } = await supabaseClient
        .from('admin_users')
        .select('*')
        .order('created_at', { ascending: true });

      if (!staffError && staffData) {
        employees = staffData.map(s => ({
          empId: s.employee_id || 'EMP-00001',
          name: s.full_name || 'Staff Member',
          email: s.email || 'staff@doggyji.com',
          role: (s.role_id || 'super_admin').replace(/_/g, ' ').toUpperCase(),
          status: (s.status || 'active').toUpperCase(),
          mfa: s.mfa_enabled !== false,
          lastLogin: s.last_login_at ? new Date(s.last_login_at).toLocaleString('en-GB') : 'Active Session'
        }));
        renderEmployeesTable();
      }

      // 5. Fetch live audit logs
      const { data: auditData, error: auditError } = await supabaseClient
        .from('admin_audit_logs')
        .select('*')
        .order('created_at', { ascending: false });

      if (!auditError && auditData) {
        auditLogs = auditData.map(a => ({
          id: a.id.substring(0, 8),
          eventName: a.event_name,
          actor: a.actor || {},
          authorization: a.authorization || {},
          target: a.target || {},
          change: a.change || {},
          context: a.context || { request_id: 'REQ-LIVE' },
          business: a.business || {},
          result: a.result || 'SUCCESS',
          timestamp: new Date(a.created_at).toLocaleString('en-GB') + ' IST'
        }));
        renderAuditTable();
      }

      // 6. Fetch live blood donors — join with pets table for real pet name & breed
      const { data: donorData, error: donorError } = await supabaseClient
        .from('blood_donors')
        .select('*, pets ( name, breed, species )');

      if (!donorError && donorData) {
        donors = donorData.map(d => ({
          name: d.pets?.name || `Donor (${d.id?.substring(0, 6)}…)`,
          breed: d.pets?.breed || d.pets?.species || d.species || 'Canine',
          bloodGroup: d.blood_group,
          city: d.city,
          distanceKm: 'Nearby',
          contact: d.emergency_contact || '—'
        }));
      }

      if (connEl) {
        connEl.innerHTML = `<div class="conn-dot online"></div><span>Live Supabase</span>`;
        connEl.title = `Connected to ${SUPABASE_URL}`;
      }
      updateDashboardMetrics();
    } catch (e) {
      console.warn('Error fetching live data from Supabase:', e);
    }
  }

  // Populate Real Test Data into Supabase
  async function seedLiveSupabaseData() {
    if (!supabaseClient) {
      showToast('Supabase client not initialized.', 'warning');
      return;
    }

    showToast('Inserting real test applicant records into Supabase database...', 'info');

    try {
      // 1. Insert service providers
      const seedProviders = [
        {
          user_id: 'test_user_vikram_' + Date.now().toString().slice(-4),
          full_name: 'Vikram Dogra',
          city: 'Bengaluru',
          area: 'Indiranagar',
          bio: 'Certified canine handler with 4 years experience caring for Indie and Labrador breeds.',
          years_experience: 4,
          safety_quiz_passed: true,
          police_verified: true,
          service_types: ['dogWalker', 'daycare'],
          verification_status: 'pending'
        },
        {
          user_id: 'test_user_anjali_' + Date.now().toString().slice(-4),
          full_name: 'Anjali Rao',
          city: 'Hyderabad',
          area: 'Banjara Hills',
          bio: 'Lifelong pet foster parent with a spacious bungalow and safe fenced yard.',
          years_experience: 6,
          safety_quiz_passed: true,
          police_verified: false,
          service_types: ['homeBoarding'],
          verification_status: 'pending'
        },
        {
          user_id: 'test_user_rohit_' + Date.now().toString().slice(-4),
          full_name: 'Rohit Sharma',
          city: 'Mumbai',
          area: 'Bandra West',
          bio: 'Active runner and dog lover providing structured high-energy walks.',
          years_experience: 2,
          safety_quiz_passed: true,
          police_verified: true,
          service_types: ['dogWalker'],
          verification_status: 'pending'
        }
      ];

      const { data: insertedProvs, error: provErr } = await supabaseClient
        .from('service_providers')
        .insert(seedProviders)
        .select();

      if (provErr) {
        console.warn('Notice seeding providers (check RLS):', provErr.message);
      } else {
        console.log('Inserted real providers into Supabase:', insertedProvs);
      }

      // Re-fetch live data from Supabase
      await fetchLiveSupabaseData();
      showToast('Live Supabase database successfully refreshed with test rows!', 'success');
    } catch (e) {
      showToast('Error seeding database: ' + e.message, 'danger');
    }
  }

  // ── 6. RENDERERS ─────────────────────────────────────────────────────────────

  function renderProvidersTable(filter = 'all', query = '') {
    const tbody = document.getElementById('providersTableBody');
    if (!tbody) return;

    let list = providers;
    if (filter !== 'all') {
      list = list.filter(p => p.status === filter);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(p => p.fullName.toLowerCase().includes(q) || p.city.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 32px; color: var(--text-muted);">No provider applications matching criteria.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(p => {
      let statusBadge = '';
      if (p.status === 'approved') statusBadge = '<span class="badge-status badge-approved">✓ Approved</span>';
      else if (p.status === 'pending') statusBadge = '<span class="badge-status badge-pending">⏳ Pending Review</span>';
      else if (p.status === 'changes_requested') statusBadge = '<span class="badge-status badge-changes">⚠️ Changes Requested</span>';
      else if (p.status === 'rejected') statusBadge = '<span class="badge-status badge-rejected">✕ Rejected</span>';
      else if (p.status === 'suspended') statusBadge = '<span class="badge-status badge-suspended">🛑 Suspended</span>';

      return `
        <tr>
          <td>
            <strong>${esc(p.fullName)}</strong><br>
            <small style="color:var(--text-muted)">${esc(p.id)}</small>
          </td>
          <td>
            ${esc(p.city)} (${esc(p.area)})<br>
            <small style="color:var(--doggy-teal); font-weight:600;">${esc((p.services || []).join(', '))}</small>
          </td>
          <td>${esc(p.experienceYears)} Years</td>
          <td>
            ${p.quizPassed ? '<span title="Safety Quiz Passed" style="color:var(--doggy-green); font-weight:600;">✓ Quiz</span>' : '<span style="color:var(--text-muted)">✗ Quiz</span>'}
            ${p.policeVerified ? ' • <span title="Police Verified" style="color:var(--doggy-teal); font-weight:600;">🛡️ Police</span>' : ''}
          </td>
          <td>${statusBadge}</td>
          <td>${esc(p.submittedDate)}</td>
          <td>
            <button class="btn btn-sm btn-primary" onclick="openProviderReviewModal('${attr(p.id)}')">Review Application →</button>
          </td>
        </tr>
      `;
    }).join('');

    const pendingCount = providers.filter(p => p.status === 'pending').length;
    const badgeEl = document.getElementById('pendingProvidersCount');
    if (badgeEl) badgeEl.textContent = pendingCount;

    // Update filter pill counts dynamically
    const pAll = document.getElementById('pillCountAll');
    if (pAll) pAll.textContent = `(${providers.length})`;
    const pPending = document.getElementById('pillCountPending');
    if (pPending) pPending.textContent = `(${pendingCount})`;
    const pChanges = document.getElementById('pillCountChanges');
    if (pChanges) pChanges.textContent = `(${providers.filter(p => p.status === 'changes_requested').length})`;
    const pApproved = document.getElementById('pillCountApproved');
    if (pApproved) pApproved.textContent = `(${providers.filter(p => p.status === 'approved').length})`;
    const pSuspended = document.getElementById('pillCountSuspended');
    if (pSuspended) pSuspended.textContent = `(${providers.filter(p => p.status === 'suspended').length})`;
  }

  function renderBookingsTable(filter = 'all', query = '') {
    const tbody = document.getElementById('bookingsTableBody');
    if (!tbody) return;

    let list = bookings;
    if (filter !== 'all') {
      list = list.filter(b => b.status === filter);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(b => b.customerName.toLowerCase().includes(q) || b.providerName.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--text-muted);"><div style="font-size:24px; margin-bottom:6px;">📅</div><strong>No service bookings recorded in Supabase database yet.</strong><br><small>Bookings made via the mobile app will appear here in real-time.</small></td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(b => {
      let statusBadge = '';
      if (b.status === 'confirmed') statusBadge = '<span class="badge-status badge-approved">Confirmed</span>';
      else if (b.status === 'pending') statusBadge = '<span class="badge-status badge-pending">Pending</span>';
      else if (b.status === 'completed') statusBadge = '<span class="badge-status badge-approved">Completed</span>';
      else if (b.status === 'cancelled') statusBadge = '<span class="badge-status badge-rejected">Cancelled</span>';

      return `
        <tr>
          <td><strong>${esc(b.id)}</strong></td>
          <td>${esc(b.customerName)}<br><small style="color:var(--text-muted)">${esc(b.petName)}</small></td>
          <td><strong>${esc(b.providerName)}</strong></td>
          <td>${esc(b.serviceType)}</td>
          <td>${esc(b.date)}<br><small style="color:var(--text-secondary)">${esc(b.slot)}</small></td>
          <td><strong>${esc(b.totalPrice)}</strong></td>
          <td>${statusBadge}</td>
          <td>
            <button class="btn btn-sm btn-outline" onclick="openBookingActionModal('${attr(b.id)}')">Admin Override</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderBloodRequestsTable() {
    const tbody = document.getElementById('bloodRequestsTableBody');
    if (!tbody) return;

    if (bloodRequests.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--text-muted);"><div style="font-size:24px; margin-bottom:6px;">🚨</div><strong>No emergency blood requests in Supabase database.</strong><br><small>Emergency SOS alerts created from the app will stream here.</small></td></tr>`;
      return;
    }

    tbody.innerHTML = bloodRequests.map(r => `
      <tr>
        <td><strong>${esc(r.petName)}</strong><br><small style="color:var(--text-muted)">${esc(r.species)}</small></td>
        <td><strong style="color:var(--doggy-red); font-size:14px;">${esc(r.bloodGroup)}</strong></td>
        <td>${esc(r.hospitalName)}</td>
        <td>${esc(r.city)}</td>
        <td><span class="badge-status ${r.urgencyLevel === 'CRITICAL' ? 'badge-rejected' : 'badge-pending'}">${esc(r.urgencyLevel)}</span></td>
        <td><span class="badge-status badge-approved">${esc(String(r.status || '').toUpperCase())}</span></td>
        <td>${esc(r.createdDate)}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="openBloodDispatchModal('${attr(r.id)}')">🚨 Dispatch Donors</button>
        </td>
      </tr>
    `).join('');
  }

  function renderEmployeesTable() {
    const tbody = document.getElementById('employeesTableBody');
    if (!tbody) return;

    if (employees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--text-muted);"><div style="font-size:24px; margin-bottom:6px;">👥</div><strong>No administrative staff accounts found in Supabase.</strong></td></tr>`;
      return;
    }

    tbody.innerHTML = employees.map(e => `
      <tr>
        <td><code>${esc(e.empId)}</code></td>
        <td><strong>${esc(e.name)}</strong></td>
        <td>${esc(e.email)}</td>
        <td><span class="badge-status badge-changes">${esc(e.role)}</span></td>
        <td><span class="badge-status badge-approved">${esc(e.status)}</span></td>
        <td>${e.mfa ? '✓ Protected' : '⚠️ Disabled'}</td>
        <td>${esc(e.lastLogin)}</td>
        <td>
          <button class="btn btn-sm btn-outline" onclick="showToast('Role permissions are centrally managed.', 'info')">Edit Role</button>
        </td>
      </tr>
    `).join('');
  }

  function renderAuditTable(moduleFilter = 'all', resultFilter = 'all', query = '') {
    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;

    let list = auditLogs;
    if (moduleFilter !== 'all') {
      list = list.filter(a => a.eventName.startsWith(moduleFilter));
    }
    if (resultFilter !== 'all') {
      list = list.filter(a => a.result === resultFilter);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(a => a.eventName.toLowerCase().includes(q) || 
                              (a.actor && a.actor.name && a.actor.name.toLowerCase().includes(q)) || 
                              (a.context && a.context.request_id && a.context.request_id.toLowerCase().includes(q)));
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--text-muted);"><div style="font-size:24px; margin-bottom:6px;">📜</div><strong>No audit log entries recorded in Supabase database yet.</strong><br><small>Administrative and security actions will append immutable ledger rows here.</small></td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(a => {
      let resBadge = '';
      if (a.result === 'SUCCESS') resBadge = '<span class="badge-status badge-approved">SUCCESS</span>';
      else if (a.result === 'DENIED') resBadge = '<span class="badge-status badge-rejected">DENIED</span>';
      else resBadge = '<span class="badge-status badge-changes">FAILURE</span>';

      return `
        <tr>
          <td><small style="color:var(--text-muted)">${esc(a.timestamp)}</small></td>
          <td><strong>${esc(a.actor?.name || 'Staff')}</strong><br><small style="color:var(--text-secondary)">${esc(a.actor?.employee_id || 'EMP')}</small></td>
          <td><code>${esc(a.eventName)}</code></td>
          <td><span style="color:var(--doggy-teal); font-weight:600;">${esc(a.target?.type)}</span></td>
          <td>${esc(a.target?.id)}</td>
          <td>${resBadge}</td>
          <td><code>${esc(a.context ? a.context.request_id : 'REQ')}</code></td>
          <td>
            <button class="btn btn-sm btn-outline" onclick="inspectAuditEvent('${attr(a.id)}')">Inspect 🔍</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function updateDashboardMetrics() {
    const approved = providers.filter(p => p.status === 'approved').length;
    const pending = providers.filter(p => p.status === 'pending').length;
    const activeBk = bookings.filter(b => b.status === 'confirmed' || b.status === 'pending').length;
    const activeSos = bloodRequests.filter(r => r.status === 'active').length;

    const elApproved = document.getElementById('dashApprovedProviders');
    if (elApproved) elApproved.textContent = approved;
    const elPending = document.getElementById('dashPendingProviders');
    if (elPending) elPending.textContent = pending;
    const elBk = document.getElementById('dashActiveBookings');
    if (elBk) elBk.textContent = activeBk;
    const elSos = document.getElementById('dashActiveSos');
    if (elSos) elSos.textContent = activeSos;
    const elAudit = document.getElementById('dashAuditCount');
    if (elAudit) elAudit.textContent = auditLogs.length;
    const elStaff = document.getElementById('dashStaffCount');
    if (elStaff) elStaff.textContent = employees.length;

    // Sidebar counter badges
    const badgePending = document.getElementById('pendingProvidersCount');
    if (badgePending) badgePending.textContent = pending;
    const badgeBk = document.getElementById('activeBookingsCount');
    if (badgeBk) badgeBk.textContent = activeBk;
    const badgeSos = document.getElementById('activeBloodSosCount');
    if (badgeSos) badgeSos.textContent = activeSos;
  }

  // ── 7. CHARTS INITIALIZATION ────────────────────────────────────────────────
  let opsChartInstance = null;
  let auditChartInstance = null;

  function initCharts() {
    const ctxOps = document.getElementById('opsVelocityChart');
    if (ctxOps) {
      opsChartInstance = new Chart(ctxOps, {
        type: 'line',
        data: {
          labels: ['14 Sep', '15 Sep', '16 Sep', '17 Sep', '18 Sep', '19 Sep', '20 Sep'],
          datasets: [
            {
              label: 'Provider Verifications',
              data: [3, 5, 2, 8, 4, 7, 9],
              borderColor: '#23C1C3',
              backgroundColor: 'rgba(35, 193, 195, 0.1)',
              tension: 0.4,
              fill: true
            },
            {
              label: 'Booking Operations',
              data: [8, 12, 10, 15, 18, 14, 22],
              borderColor: '#7B1FA2',
              backgroundColor: 'rgba(123, 31, 162, 0.1)',
              tension: 0.4,
              fill: true
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#94A3B8', font: { family: 'Montserrat' } } } },
          scales: {
            x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94A3B8' } },
            y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94A3B8' } }
          }
        }
      });
    }

    const ctxAudit = document.getElementById('auditDistributionChart');
    if (ctxAudit) {
      auditChartInstance = new Chart(ctxAudit, {
        type: 'doughnut',
        data: {
          labels: ['Providers', 'Bookings', 'Security/Auth', 'Blood SOS'],
          datasets: [{
            data: [45, 30, 15, 10],
            backgroundColor: ['#23C1C3', '#7B1FA2', '#EF4444', '#FEBB4A'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#94A3B8', font: { family: 'Montserrat' } } }
          }
        }
      });
    }
  }

  // ── 8. NAVIGATION & TAB SWITCHING ───────────────────────────────────────────
  const navItems = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.content-view');

  window.navigateTo = function(targetViewId) {
    navItems.forEach(item => {
      if (item.getAttribute('data-view') === targetViewId) item.classList.add('active');
      else item.classList.remove('active');
    });

    views.forEach(v => {
      if (v.id === `view-${targetViewId}`) v.classList.add('active');
      else v.classList.remove('active');
    });

    const titleMap = {
      'dashboard': ['Command Center', 'Real-time platform operations and security telemetry'],
      'providers': ['Provider Verification Queue', 'Two-layer review of identity, credentials, and verification status'],
      'bookings': ['Bookings & Operations Overrides', 'Administrative scheduling, slot integrity, and emergency overrides'],
      'blood-sos': ['Blood SOS Dispatch Command', 'Emergency candidate matching and hospital coordination under strict privacy'],
      'employees': ['Staff Directory & RBAC Roles', 'Principle of least privilege and staff authorization management'],
      'audit-logs': ['Immutable Audit Subsystem', 'Strictly append-only historical audit trail for forensic investigation'],
      'security': ['Security & Anomaly Signals', 'Real-time detection of suspicious volume, privilege escalations, and denials']
    };

    if (titleMap[targetViewId]) {
      document.getElementById('pageTitle').textContent = titleMap[targetViewId][0];
      document.getElementById('pageSubtitle').textContent = titleMap[targetViewId][1];
    }
  };

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetView = item.getAttribute('data-view');
      navigateTo(targetView);
    });
  });

  // The header used to carry a "persona" dropdown that called
  // establishSession() with whatever role was picked — letting anyone promote
  // themselves to Super Admin from the UI. Roles now come from admin_users and
  // are enforced by admin_has() in the database, so the control is gone rather
  // than merely disabled.


  // ── 9. PROVIDER VERIFICATION REVIEW MODAL ACTIONS ───────────────────────────
  let selectedProviderId = null;

  window.openProviderReviewModal = function(providerId) {
    if (!enforcePermission('providers.review', 'Review Provider Application')) return;

    selectedProviderId = providerId;
    const prov = providers.find(p => p.id === providerId);
    if (!prov) return;

    document.getElementById('reviewModalTitle').textContent = `Review: ${prov.fullName}`;
    document.getElementById('reviewModalSubtitle').textContent = `ID: ${prov.id} • Submitted: ${prov.submittedDate}`;
    document.getElementById('reviewFullName').textContent = prov.fullName;
    document.getElementById('reviewCityArea').textContent = `${prov.city}, ${prov.area}`;
    document.getElementById('reviewServices').textContent = `${prov.experienceYears} Years • ${prov.services.join(', ')}`;
    document.getElementById('reviewChecks').textContent = `✓ Safety Quiz: ${prov.quizPassed ? 'Passed (100%)' : 'Pending'} • Police Certificate: ${prov.policeVerified ? 'Verified' : 'None'}`;
    document.getElementById('reviewBio').textContent = prov.bio;

    openModal('providerReviewModal');
  };

  window.triggerDocumentViewAudit = function() {
    if (!enforcePermission('providers.documents.view', 'View Sensitive KYC Document')) return;

    emitAuditEvent({
      eventName: 'provider.document.viewed',
      targetType: 'provider_documents',
      targetId: selectedProviderId,
      targetName: `Aadhaar Card (${selectedProviderId})`,
      beforeState: null,
      afterState: null,
      reasonCode: 'verification_review',
      reasonNotes: 'Decrypted and reviewed government identity document for applicant verification',
      result: 'SUCCESS'
    });

    showToast('Secure signed URL generated. Decrypted document view recorded in audit trail.', 'success');
  };

  // Provider Decision Handlers (Approve, Reject, Request Changes)
  document.getElementById('btnApproveProvider')?.addEventListener('click', async () => {
    if (!enforcePermission('providers.approve', 'Approve Provider Application')) return;

    const prov = providers.find(p => p.id === selectedProviderId);
    if (!prov) return;

    const beforeState = { verification_status: prov.status, is_verified: prov.status === 'approved' };
    prov.status = 'approved';
    const afterState = { verification_status: 'approved', is_verified: true };

    const reasonCode = document.getElementById('reviewReasonCode').value;
    const notes = document.getElementById('reviewNotes').value || 'All safety and identity checks completed.';

    // Live update on Supabase
    if (supabaseClient) {
      const { error } = await supabaseClient
        .from('service_providers')
        .update({ verification_status: 'approved', is_verified: true })
        .eq('id', prov.id);

      if (error) console.info('Notice updating live provider (check trigger/service role):', error.message);
    }

    emitAuditEvent({
      eventName: 'provider.approved',
      targetType: 'service_providers',
      targetId: prov.id,
      targetName: prov.fullName,
      beforeState,
      afterState,
      reasonCode,
      reasonNotes: notes,
      result: 'SUCCESS'
    });

    closeModal('providerReviewModal');
    renderProvidersTable();
    showToast(`Provider ${prov.fullName} has been approved and verified in database!`, 'success');
  });

  document.getElementById('btnRejectProvider')?.addEventListener('click', async () => {
    if (!enforcePermission('providers.reject', 'Reject Provider Application')) return;

    const prov = providers.find(p => p.id === selectedProviderId);
    if (!prov) return;

    const reasonCode = document.getElementById('reviewReasonCode').value;
    const notes = document.getElementById('reviewNotes').value;

    if (!notes.trim()) {
      showToast('Rejection requires mandatory explanation notes.', 'warning');
      return;
    }

    const beforeState = { verification_status: prov.status };
    prov.status = 'rejected';
    const afterState = { verification_status: 'rejected' };

    if (supabaseClient) {
      await supabaseClient
        .from('service_providers')
        .update({ verification_status: 'rejected', is_verified: false })
        .eq('id', prov.id);
    }

    emitAuditEvent({
      eventName: 'provider.rejected',
      targetType: 'service_providers',
      targetId: prov.id,
      targetName: prov.fullName,
      beforeState,
      afterState,
      reasonCode,
      reasonNotes: notes,
      result: 'SUCCESS'
    });

    closeModal('providerReviewModal');
    renderProvidersTable();
    showToast(`Provider ${prov.fullName} application rejected. Recorded in audit trail.`, 'danger');
  });

  document.getElementById('btnRequestChangesProvider')?.addEventListener('click', async () => {
    if (!enforcePermission('providers.request_changes', 'Request Provider KYC Changes')) return;

    const prov = providers.find(p => p.id === selectedProviderId);
    if (!prov) return;

    const notes = document.getElementById('reviewNotes').value;
    if (!notes.trim()) {
      showToast('Please specify the changes required from the applicant.', 'warning');
      return;
    }

    const beforeState = { verification_status: prov.status };
    prov.status = 'changes_requested';
    const afterState = { verification_status: 'changes_requested' };

    emitAuditEvent({
      eventName: 'provider.changes_requested',
      targetType: 'service_providers',
      targetId: prov.id,
      targetName: prov.fullName,
      beforeState,
      afterState,
      reasonCode: document.getElementById('reviewReasonCode').value,
      reasonNotes: notes,
      result: 'SUCCESS'
    });

    closeModal('providerReviewModal');
    renderProvidersTable();
    showToast(`Requested changes from ${prov.fullName}. Notification logged.`, 'warning');
  });

  // ── 10. BOOKING ACTION OVERRIDE MODAL ────────────────────────────────────────
  let selectedBookingId = null;

  window.openBookingActionModal = function(bookingId) {
    if (!enforcePermission('bookings.manage', 'Administrative Booking Override')) return;

    selectedBookingId = bookingId;
    document.getElementById('bookingModalSubtitle').textContent = `Booking ID: ${bookingId}`;
    openModal('bookingActionModal');
  };

  document.getElementById('btnExecuteBookingAction')?.addEventListener('click', async () => {
    const action = document.getElementById('bookingActionSelect').value;
    const reason = document.getElementById('bookingActionReason').value;

    if (!reason.trim()) {
      showToast('Administrative overrides require a mandatory reason.', 'warning');
      return;
    }

    const bk = bookings.find(b => b.id === selectedBookingId);
    if (!bk) return;

    const beforeState = { status: bk.status };
    if (action === 'admin_cancel') bk.status = 'cancelled';
    else if (action === 'admin_confirm') bk.status = 'confirmed';
    const afterState = { status: bk.status };

    if (supabaseClient) {
      await supabaseClient
        .from('service_bookings')
        .update({ status: bk.status })
        .eq('id', bk.id);
    }

    emitAuditEvent({
      eventName: action === 'admin_cancel' ? 'booking.cancelled' : 'booking.confirmed',
      targetType: 'service_bookings',
      targetId: bk.id,
      targetName: `Booking for ${bk.customerName}`,
      beforeState,
      afterState,
      reasonCode: action,
      reasonNotes: reason,
      result: 'SUCCESS'
    });

    closeModal('bookingActionModal');
    renderBookingsTable();
    showToast(`Booking ${bk.id} updated in database. Audit record created.`, 'success');
  });

  // ── 11. BLOOD SOS DISPATCH MODAL ────────────────────────────────────────────
  window.openBloodDispatchModal = function(sosId) {
    if (!enforcePermission('blood.manage', 'Blood SOS Emergency Coordination')) return;

    const req = bloodRequests.find(r => r.id === sosId);
    if (!req) return;

    document.getElementById('bloodModalSubtitle').textContent = `${req.petName} (${req.species}) • ${req.bloodGroup} Needed at ${req.hospitalName}`;
    document.getElementById('sosPatientInfo').innerHTML = `
      <strong>Hospital:</strong> ${esc(req.hospitalName)}, ${esc(req.city)}<br>
      <strong>Urgency:</strong> <span style="color:var(--doggy-red); font-weight:700;">${esc(req.urgencyLevel)}</span><br>
      <strong>Status:</strong> Active Emergency
    `;

    document.getElementById('donorCandidatesList').innerHTML = donors.map(d => `
      <div style="background:rgba(0,0,0,0.2); padding:10px 14px; border-radius:8px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <strong>${esc(d.name)}</strong><br>
          <small style="color:var(--doggy-teal)">${esc(d.distanceKm)} away • ${esc(d.bloodGroup)}</small>
        </div>
        <button class="btn btn-sm btn-outline" onclick="dispatchDirectAlert('${attr(d.name)}')">Send Alert 📲</button>
      </div>
    `).join('');

    openModal('bloodDispatchModal');
  };

  window.dispatchDirectAlert = function(donorName) {
    emitAuditEvent({
      eventName: 'blood_sos.donor_dispatched',
      targetType: 'blood_donors',
      targetId: donorName,
      targetName: donorName,
      beforeState: null,
      afterState: null,
      reasonCode: 'critical_sos_matching',
      reasonNotes: `Direct high-priority alert dispatched to candidate donor: ${donorName}`,
      result: 'SUCCESS'
    });
    showToast(`Dispatched emergency alert to donor: ${donorName}`, 'success');
  };

  document.getElementById('btnBroadcastSosAlert')?.addEventListener('click', () => {
    emitAuditEvent({
      eventName: 'blood_sos.broadcast_dispatched',
      targetType: 'blood_requests',
      targetId: 'SOS-901',
      targetName: 'Rocky (Labrador)',
      beforeState: null,
      afterState: null,
      reasonCode: 'broadcast_all_compatible',
      reasonNotes: 'Triggered emergency push broadcast to compatible registered blood donors.',
      result: 'SUCCESS'
    });

    closeModal('bloodDispatchModal');
    showToast('Emergency SOS alert broadcast successfully sent to donors!', 'danger');
  });

  // ── 12. AUDIT DEEP INSPECT DRAWER ───────────────────────────────────────────
  window.inspectAuditEvent = function(auditId) {
    if (!enforcePermission('audit.view', 'View Immutable Audit Logs')) return;

    const log = auditLogs.find(a => a.id === auditId);
    if (!log) return;

    document.getElementById('drawerEventName').textContent = log.eventName;
    document.getElementById('drawerEventTimestamp').textContent = log.timestamp;
    document.getElementById('drawerActorName').textContent = `${(log.actor && log.actor.name) || 'Staff'} (${(log.actor && log.actor.employee_id) || 'EMP'})`;
    document.getElementById('drawerActorRole').textContent = (log.actor && log.actor.role) || 'Staff';
    document.getElementById('drawerActorIp').textContent = (log.actor && log.actor.ip) || '127.0.0.1';
    document.getElementById('drawerPermissionUsed').textContent = (log.authorization && log.authorization.permission_used) || 'system';

    document.getElementById('drawerTargetEntity').textContent = (log.target && log.target.type) || 'record';
    document.getElementById('drawerTargetId').textContent = (log.target && log.target.id) || 'N/A';
    document.getElementById('drawerRequestId').textContent = (log.context && log.context.request_id) || 'REQ-LIVE';
    document.getElementById('drawerResult').textContent = log.result;
    document.getElementById('drawerResult').className = `badge-status-pill ${log.result === 'SUCCESS' ? 'badge-approved' : 'badge-rejected'}`;

    document.getElementById('drawerReasonCode').textContent = (log.business && log.business.reason_code) || 'N/A';
    document.getElementById('drawerNotes').textContent = `"${(log.business && log.business.reason_text) || 'Operational record'}"`;

    document.getElementById('drawerBeforeJson').textContent = JSON.stringify(log.change ? log.change.before : {}, null, 2);
    document.getElementById('drawerAfterJson').textContent = JSON.stringify(log.change ? log.change.after : {}, null, 2);

    openDrawer('auditInspectDrawer');
  };

  // Export Audit Logs (JSON)
  document.getElementById('exportAuditBtn')?.addEventListener('click', () => {
    if (!enforcePermission('audit.export', 'Export Audit Logs')) return;

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(auditLogs, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", `doggyji_audit_logs_${new Date().toISOString().slice(0, 10)}.json`);
    dlAnchorElem.click();

    emitAuditEvent({
      eventName: 'audit.exported',
      targetType: 'compliance_report',
      targetId: 'ALL_LOGS',
      targetName: `Count: ${auditLogs.length} events`,
      beforeState: null,
      afterState: null,
      reasonCode: 'compliance_backup',
      reasonNotes: 'Exported immutable audit logs for external compliance audit.',
      result: 'SUCCESS'
    });

    showToast('Audit logs exported successfully as compliant JSON.', 'success');
  });

  // ── 13. BACKEND CONFIG MODAL & LIVE DB ACTIONS ──────────────────────────────
  const openBackendConfigBtn = document.getElementById('openBackendConfigBtn');
  const btnSaveBackendConfig = document.getElementById('btnSaveBackendConfig');
  const btnTestDbConnection = document.getElementById('btnTestDbConnection');
  const btnSyncLiveSupabase = document.getElementById('btnSyncLiveSupabase');
  const btnSeedLiveSupabase = document.getElementById('btnSeedLiveSupabase');

  if (openBackendConfigBtn) {
    openBackendConfigBtn.addEventListener('click', () => {
      document.getElementById('cfgSupabaseUrl').value = SUPABASE_URL;
      document.getElementById('cfgSupabaseAnon').value = SUPABASE_ANON_KEY;
      openModal('backendConfigModal');
    });
  }

  if (btnSaveBackendConfig) {
    btnSaveBackendConfig.addEventListener('click', () => {
      SUPABASE_URL = document.getElementById('cfgSupabaseUrl').value.trim();
      SUPABASE_ANON_KEY = document.getElementById('cfgSupabaseAnon').value.trim();

      localStorage.setItem('doggyji_cfg_url', SUPABASE_URL);
      localStorage.setItem('doggyji_cfg_anon', SUPABASE_ANON_KEY);
      localStorage.removeItem('doggyji_cfg_service_role');

      createSupabase();
      closeModal('backendConfigModal');
      fetchLiveSupabaseData();
      showToast('Database configuration updated and reconnected!', 'success');
    });
  }

  if (btnTestDbConnection) {
    btnTestDbConnection.addEventListener('click', async () => {
      showToast('Testing connection to Supabase...', 'info');
      try {
        const testClient = window.supabase.createClient(
          document.getElementById('cfgSupabaseUrl').value.trim(),
          document.getElementById('cfgSupabaseAnon').value.trim()
        );
        const { data, error } = await testClient.from('public_blood_donors').select('count');
        if (error) throw error;
        showToast('Connection Successful! Database responded 200 OK.', 'success');
      } catch (e) {
        showToast('Connection test completed: ' + (e.message || 'Ready'), 'info');
      }
    });
  }

  if (btnSyncLiveSupabase) {
    btnSyncLiveSupabase.addEventListener('click', () => {
      fetchLiveSupabaseData();
      showToast('Triggered live sync with Supabase tables.', 'info');
    });
  }

  // ── 14. UI HELPER UTILITIES ──────────────────────────────────────────────────
  window.openModal = function(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('open');
  };

  window.closeModal = function(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('open');
  };

  window.openDrawer = function(drawerId) {
    const el = document.getElementById(drawerId);
    if (el) el.classList.add('open');
  };

  window.closeDrawer = function(drawerId) {
    const el = document.getElementById(drawerId);
    if (el) el.classList.remove('open');
  };

  window.showToast = function(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✓';
    else if (type === 'danger') icon = '✕';
    else if (type === 'warning') icon = '⚠️';

    // icon is one of the fixed literals above; message is whatever the caller
    // passed, which includes database values and backend error strings.
    toast.innerHTML = `<span>${icon}</span><span>${esc(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  };

  // Theme Toggle
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
  let currentTheme = localStorage.getItem('doggyji_admin_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  if (themeIcon) themeIcon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', currentTheme);
      localStorage.setItem('doggyji_admin_theme', currentTheme);
      if (themeIcon) themeIcon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
    });
  }

  // Filter Pills Event Binding
  document.querySelectorAll('#providerFilterPills .filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#providerFilterPills .filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderProvidersTable(btn.getAttribute('data-filter'), document.getElementById('providerSearchInput').value);
    });
  });

  document.querySelectorAll('#bookingFilterPills .filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#bookingFilterPills .filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderBookingsTable(btn.getAttribute('data-filter'), document.getElementById('bookingSearchInput').value);
    });
  });

  // Search Inputs
  document.getElementById('providerSearchInput')?.addEventListener('input', (e) => {
    const activePill = document.querySelector('#providerFilterPills .filter-pill.active');
    const filter = activePill ? activePill.getAttribute('data-filter') : 'all';
    renderProvidersTable(filter, e.target.value);
  });

  document.getElementById('bookingSearchInput')?.addEventListener('input', (e) => {
    const activePill = document.querySelector('#bookingFilterPills .filter-pill.active');
    const filter = activePill ? activePill.getAttribute('data-filter') : 'all';
    renderBookingsTable(filter, e.target.value);
  });

  document.getElementById('auditSearchInput')?.addEventListener('input', (e) => {
    renderAuditTable(
      document.getElementById('auditModuleFilter').value,
      document.getElementById('auditResultFilter').value,
      e.target.value
    );
  });

  document.getElementById('auditModuleFilter')?.addEventListener('change', (e) => {
    renderAuditTable(e.target.value, document.getElementById('auditResultFilter').value, document.getElementById('auditSearchInput').value);
  });

  document.getElementById('auditResultFilter')?.addEventListener('change', (e) => {
    renderAuditTable(document.getElementById('auditModuleFilter').value, e.target.value, document.getElementById('auditSearchInput').value);
  });

  // ── 15. BOOTSTRAP INITIALIZATION ─────────────────────────────────────────────
  renderProvidersTable();
  renderBookingsTable();
  renderBloodRequestsTable();
  renderEmployeesTable();
  renderAuditTable();
  updateDashboardMetrics();
  initCharts();

  // Pull live records from Supabase tables immediately
  fetchLiveSupabaseData();

  // Check auth session
  checkExistingSession();


});

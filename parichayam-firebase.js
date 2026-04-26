(function () {
  const DEFAULT_TRIAL_SETTINGS = {
    durationDays: 30,
    trialConnects: 30,
    freeConnects: 5,
    freeDailyInterests: 5,
    freeMonthlyInterests: 30,
  };

  const DEFAULT_KUNDALI_SETTINGS = {
    enabled: true,
    enableForTrial: true,
    enableForPaid: true,
    enableForFree: false,
    sameGotraPolicy: "hard",
    showScoreOnCards: true,
    weight: 55,
  };

  const DEFAULT_DASHBOARD_NOTICE = {
    enabled: false,
    text: "",
    color: "gold",
    icon: "",
    cta: "",
    action: "settings",
    validUntil: "",
  };

  const DEFAULT_AGENT_DIRECTORY = [];
  const DEFAULT_VERIFICATION_SETTINGS = {
    aadhaarFee: 100,
    incomeFee: 100,
    turnaroundHours: 24,
    reminderHours: 5,
    enabled: true,
  };
  const DEFAULT_KUNDALI_PACK_SETTINGS = {
    enabled: true,
    price: 100,
    checks: 5,
    validityDays: 30,
    title: "Kundali Match Pack",
    description: "Validate Jathakam compatibility with a limited-use paid pack.",
  };
  const DEFAULT_AUTH_SETTINGS = {
    enabled: false,
    mode: "firebase-password",
    requireSignupOtp: false,
    allowPasswordFallback: true,
    widgetId: "",
    authToken: "",
    countryCode: "91",
    verifyEndpoint: "https://us-central1-parichayam-9ee09.cloudfunctions.net/msg91VerifyAccessToken",
    brandLabel: "Parichayam",
  };
  const DEFAULT_PUBLIC_PROFILE_FIELDS = {
    profileNumber: true,
    name: true,
    age: true,
    city: true,
    community: true,
    education: true,
    profession: true,
    nakshatra: true,
    rashi: true,
    gotra: true,
    padam: false,
    about: true,
    verification: true,
  };

  const BRIDGE_KEYS = new Set([
    "parichayam_trial_settings",
    "parichayam_kundali_settings",
    "parichayam_dashboard_notice",
    "parichayam_plan_prices",
    "parichayam_site_settings",
    "parichayam_payment_settings",
    "parichayam_coupons",
    "parichayam_addon_prices",
    "parichayam_connect_packs",
    "parichayam_connect_costs",
    "parichayam_agent_referral_settings",
    "parichayam_agent_payout_history",
    "parichayam_agent_directory",
    "parichayam_connect_requests",
    "parichayam_gotra_requests",
    "parichayam_gotras",
    "parichayam_ads",
    "parichayam_user_access",
    "parichayam_dash_vis",
    "parichayam_form_fields",
    "parichayam_communities",
    "parichayam_custom_fields",
    "parichayam_verification_settings",
    "parichayam_kundali_pack_settings",
    "parichayam_auth_settings",
    "parichayam_public_profile_fields",
  ]);

  const firebaseConfig = window.PARICHAYAM_FIREBASE_CONFIG || {};
  const options = Object.assign(
    {
      appUrl: "https://parichayam.co.in",
      supportEmail: "hello@parichayam.co.in",
      supportPhone: "9440176078",
      adminEmails: [],
      stateCollection: "appState",
      membersCollection: "members",
      phoneIndexCollection: "memberPhoneIndex",
      publicProfilesCollection: "publicProfiles",
      countersCollection: "systemCounters",
    },
    window.PARICHAYAM_FIREBASE_OPTIONS || {}
  );
  const sqlReporting = {
    url: String(window.PARICHAYAM_SQL_API || "").trim(),
    apiKey: String(window.PARICHAYAM_SQL_API_KEY || "").trim(),
  };
  const REGISTRATION_DRAFT_KEY = "parichayam_registration_draft";
  const AUTH_READY_TIMEOUT_MS = 8000;
  const FIRESTORE_OP_TIMEOUT_MS = 12000;
  const SKIP_AUTH_READY_PATHS = new Set([
    "/auth/register",
    "/auth/login",
    "/auth/forgot-password/request",
    "/public/settings",
  ]);

  const requiredConfigKeys = ["apiKey", "authDomain", "projectId", "appId"];
  const isConfigured = requiredConfigKeys.every((key) => String(firebaseConfig[key] || "").trim());

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const originalLocalSetItem = window.localStorage?.setItem?.bind(window.localStorage);
  const originalLocalRemoveItem = window.localStorage?.removeItem?.bind(window.localStorage);

  let app = null;
  let auth = null;
  let db = null;
  let storage = null;
  let bootPromise = null;
  let authReadyPromise = Promise.resolve(null);
  let isApplyingRemoteState = false;

  function normalizePhone(value) {
    return String(value || "").replace(/[^\d]/g, "").replace(/^91/, "").slice(-10);
  }

  function normalizeAgentRefId(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-");
  }

  function normalizeProfileNumber(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  function toLowerEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function profileNumberFromCounter(counter) {
    const numeric = Math.max(100001, parseInt(counter, 10) || 100001);
    return `P${String(numeric).padStart(6, "0")}`;
  }

  function parseMaybeJson(value) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return value;
    }
  }

  function writeLocalCache(key, value) {
    if (!originalLocalSetItem) return;
    originalLocalSetItem(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  function postSqlReporting(path, payload) {
    if (!sqlReporting.url || !originalFetch) return;
    const base = sqlReporting.url.replace(/\/+$/, "");
    const endpoint = path.startsWith("/") ? path : "/" + path;
    originalFetch(base + endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sqlReporting.apiKey ? { "x-sql-api-key": sqlReporting.apiKey } : {}),
      },
      body: JSON.stringify(payload || {}),
    }).catch(() => {});
  }

  function trackSqlEvent(type, payload) {
    if (!type) return;
    const map = {
      member: "/reporting/member",
      payment: "/reporting/payment",
      invoice: "/reporting/invoice",
      payout: "/reporting/payout",
      verification: "/reporting/verification",
    };
    const path = map[type];
    if (!path) return;
    postSqlReporting(path, payload);
  }

  function removeLocalCache(key) {
    if (!originalLocalRemoveItem) return;
    originalLocalRemoveItem(key);
  }

  function buildError(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code || "";
    return error;
  }

  function withTimeout(promise, ms, message, code) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => {
        reject(buildError(504, message || "Request timed out.", code || "timeout"));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) window.clearTimeout(timer);
    });
  }

  function firebaseMessage(error, fallback) {
    const code = String(error?.code || "");
    const map = {
      "auth/email-already-in-use": "Email is already registered. Sign in instead.",
      "auth/invalid-email": "Enter a valid email address.",
      "auth/user-not-found": "No account found for these credentials.",
      "auth/wrong-password": "Incorrect password.",
      "auth/invalid-credential": "Invalid email/mobile or password.",
      "auth/too-many-requests": "Too many attempts. Please try again later.",
      "auth/network-request-failed": "Network issue. Please check your internet connection.",
      "permission-denied": "You do not have permission for this action.",
    };
    return map[code] || error?.message || fallback || "Request failed.";
  }

  function maskEmail(email) {
    const value = String(email || "");
    const parts = value.split("@");
    if (parts.length !== 2) return "your registered email";
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 2) return name.charAt(0) + "*@" + domain;
    return name.slice(0, 2) + "*".repeat(Math.max(1, name.length - 2)) + "@" + domain;
  }

  function normalizeTrialSettings(raw) {
    const saved = raw || {};
    return {
      ...DEFAULT_TRIAL_SETTINGS,
      ...saved,
      durationDays: Math.max(1, parseInt(saved.durationDays ?? DEFAULT_TRIAL_SETTINGS.durationDays, 10) || DEFAULT_TRIAL_SETTINGS.durationDays),
      trialConnects: Math.max(1, parseInt(saved.trialConnects ?? DEFAULT_TRIAL_SETTINGS.trialConnects, 10) || DEFAULT_TRIAL_SETTINGS.trialConnects),
      freeConnects: Math.max(0, parseInt(saved.freeConnects ?? DEFAULT_TRIAL_SETTINGS.freeConnects, 10) || DEFAULT_TRIAL_SETTINGS.freeConnects),
      freeDailyInterests: Math.max(1, parseInt(saved.freeDailyInterests ?? DEFAULT_TRIAL_SETTINGS.freeDailyInterests, 10) || DEFAULT_TRIAL_SETTINGS.freeDailyInterests),
      freeMonthlyInterests: Math.max(1, parseInt(saved.freeMonthlyInterests ?? DEFAULT_TRIAL_SETTINGS.freeMonthlyInterests, 10) || DEFAULT_TRIAL_SETTINGS.freeMonthlyInterests),
    };
  }

  function normalizeKundaliSettings(raw) {
    const saved = raw || {};
    return {
      ...DEFAULT_KUNDALI_SETTINGS,
      ...saved,
      weight: Math.max(0, Math.min(100, parseInt(saved.weight ?? DEFAULT_KUNDALI_SETTINGS.weight, 10) || DEFAULT_KUNDALI_SETTINGS.weight)),
    };
  }

  function normalizeNotice(raw) {
    const saved = raw || {};
    return {
      ...DEFAULT_DASHBOARD_NOTICE,
      ...saved,
      validUntil: saved.validUntil ? String(saved.validUntil) : "",
    };
  }

  function normalizeAgentDirectory(raw) {
    const items = Array.isArray(raw) ? raw : [];
    return items
      .map((item) => {
        const refId = normalizeAgentRefId(item?.refId || item?.agentRefId || "");
        if (!refId) return null;
        return {
          refId,
          name: String(item?.name || "").trim(),
          city: String(item?.city || "").trim(),
          tier: String(item?.tier || "").trim(),
          mobile: normalizePhone(item?.mobile || ""),
          status: String(item?.status || "active").toLowerCase(),
          active: item?.active !== false && String(item?.status || "active").toLowerCase() !== "revoked",
          joined: String(item?.joined || "").trim(),
        };
      })
      .filter(Boolean);
  }

  function normalizeVerificationSettings(raw) {
    const saved = raw || {};
    return {
      ...DEFAULT_VERIFICATION_SETTINGS,
      ...saved,
      aadhaarFee: Math.max(0, parseInt(saved.aadhaarFee ?? DEFAULT_VERIFICATION_SETTINGS.aadhaarFee, 10) || DEFAULT_VERIFICATION_SETTINGS.aadhaarFee),
      incomeFee: Math.max(0, parseInt(saved.incomeFee ?? DEFAULT_VERIFICATION_SETTINGS.incomeFee, 10) || DEFAULT_VERIFICATION_SETTINGS.incomeFee),
      turnaroundHours: Math.max(1, parseInt(saved.turnaroundHours ?? DEFAULT_VERIFICATION_SETTINGS.turnaroundHours, 10) || DEFAULT_VERIFICATION_SETTINGS.turnaroundHours),
      reminderHours: Math.max(1, parseInt(saved.reminderHours ?? DEFAULT_VERIFICATION_SETTINGS.reminderHours, 10) || DEFAULT_VERIFICATION_SETTINGS.reminderHours),
      enabled: saved.enabled !== false,
    };
  }

  function normalizeKundaliPackSettings(raw) {
    const saved = raw || {};
    return {
      ...DEFAULT_KUNDALI_PACK_SETTINGS,
      ...saved,
      enabled: saved.enabled !== false,
      price: Math.max(0, parseInt(saved.price ?? DEFAULT_KUNDALI_PACK_SETTINGS.price, 10) || DEFAULT_KUNDALI_PACK_SETTINGS.price),
      checks: Math.max(1, parseInt(saved.checks ?? DEFAULT_KUNDALI_PACK_SETTINGS.checks, 10) || DEFAULT_KUNDALI_PACK_SETTINGS.checks),
      validityDays: Math.max(1, parseInt(saved.validityDays ?? DEFAULT_KUNDALI_PACK_SETTINGS.validityDays, 10) || DEFAULT_KUNDALI_PACK_SETTINGS.validityDays),
      title: String(saved.title || DEFAULT_KUNDALI_PACK_SETTINGS.title).trim() || DEFAULT_KUNDALI_PACK_SETTINGS.title,
      description: String(saved.description || DEFAULT_KUNDALI_PACK_SETTINGS.description).trim() || DEFAULT_KUNDALI_PACK_SETTINGS.description,
    };
  }

  function normalizeAuthSettings(raw) {
    const configFallback = window.PARICHAYAM_MSG91_OPTIONS || {};
    const saved = raw || {};
    const mode = String(saved.mode || configFallback.mode || DEFAULT_AUTH_SETTINGS.mode).trim().toLowerCase();
    const allowedModes = new Set(["firebase-password", "msg91-hybrid", "msg91-mobile-first"]);
    return {
      ...DEFAULT_AUTH_SETTINGS,
      ...configFallback,
      ...saved,
      enabled: saved.enabled === true || configFallback.enabled === true,
      mode: allowedModes.has(mode) ? mode : DEFAULT_AUTH_SETTINGS.mode,
      requireSignupOtp: saved.requireSignupOtp === true || configFallback.requireSignupOtp === true,
      allowPasswordFallback: saved.allowPasswordFallback !== false && configFallback.allowPasswordFallback !== false,
      widgetId: String(saved.widgetId || configFallback.widgetId || "").trim(),
      authToken: String(saved.authToken || configFallback.authToken || "").trim(),
      countryCode: String(saved.countryCode || configFallback.countryCode || DEFAULT_AUTH_SETTINGS.countryCode)
        .replace(/[^\d]/g, "")
        .slice(0, 4) || DEFAULT_AUTH_SETTINGS.countryCode,
      verifyEndpoint: String(saved.verifyEndpoint || configFallback.verifyEndpoint || "").trim(),
      brandLabel: String(saved.brandLabel || configFallback.brandLabel || DEFAULT_AUTH_SETTINGS.brandLabel).trim() || DEFAULT_AUTH_SETTINGS.brandLabel,
    };
  }

  const MATCHMAKER_PIPELINE_STATUSES = [
    "new",
    "contacted",
    "profile_pending",
    "verification_pending",
    "shortlisted",
    "family_discussion",
    "meeting_planned",
    "negotiation",
    "converted",
    "closed",
    "on_hold",
  ];

  const EMPLOYEE_ASSIGNMENT_STATUSES = [
    "new",
    "verification_pending",
    "in_review",
    "awaiting_member",
    "resolved",
    "closed",
    "on_hold",
  ];

  function normalizeAssignmentStatus(value, assignedRole) {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
    const role = normalizeRole(assignedRole || "MATCHMAKER");
    const allowed = role === "EMPLOYEE" ? EMPLOYEE_ASSIGNMENT_STATUSES : MATCHMAKER_PIPELINE_STATUSES;
    return allowed.includes(normalized) ? normalized : allowed[0];
  }

  function isAdminMember(member) {
    return String(member?.role || "").toUpperCase() === "ADMIN";
  }

  function normalizeRole(value) {
    return String(value || "MEMBER").trim().toUpperCase();
  }

  function isStaffMember(member) {
    const role = normalizeRole(member?.role);
    return role === "ADMIN" || role === "MATCHMAKER" || role === "EMPLOYEE";
  }

  function isMatchmakerMember(member) {
    const role = normalizeRole(member?.role);
    return role === "ADMIN" || role === "MATCHMAKER";
  }

  function makeResponse(status, payload) {
    return new Response(JSON.stringify(payload || {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function serverTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  function nowIso() {
    return new Date().toISOString();
  }

  async function ensureAuthReady() {
    try {
      await withTimeout(authReadyPromise, AUTH_READY_TIMEOUT_MS, "Authentication service is taking longer than expected. Please refresh and try again.", "auth/timeout");
    } catch (error) {}
    return auth?.currentUser || null;
  }

  async function waitForCurrentUser(expectedUid, timeoutMs) {
    if (!auth || !expectedUid) return auth?.currentUser || null;
    if (auth.currentUser?.uid === expectedUid) return auth.currentUser;
    return withTimeout(
      new Promise((resolve) => {
        const unsubscribe = auth.onAuthStateChanged((user) => {
          if (user?.uid === expectedUid) {
            unsubscribe();
            resolve(user);
          }
        });
      }),
      timeoutMs || AUTH_READY_TIMEOUT_MS,
      "We created the account but could not finish starting your session. Please try signing in once.",
      "auth/session-timeout"
    );
  }

  async function setBridgedState(key, value, meta) {
    if (!db || !BRIDGE_KEYS.has(key)) return;
    await db.collection(options.stateCollection).doc(key).set(
      {
        key,
        value,
        updatedAt: serverTimestamp(),
        updatedBy: meta?.updatedBy || "",
      },
      { merge: true }
    );
  }

  async function deleteBridgedState(key) {
    if (!db || !BRIDGE_KEYS.has(key)) return;
    await db.collection(options.stateCollection).doc(key).delete();
  }

  const PAGE_BRIDGE_KEYS = {
    index: [
      "parichayam_plan_prices",
      "parichayam_site_settings",
      "parichayam_trial_settings",
    ],
    auth: [
      "parichayam_plan_prices",
      "parichayam_site_settings",
      "parichayam_trial_settings",
      "parichayam_agent_directory",
      "parichayam_kundali_pack_settings",
      "parichayam_auth_settings",
    ],
    dashboard: [
      "parichayam_trial_settings",
      "parichayam_kundali_settings",
      "parichayam_kundali_pack_settings",
      "parichayam_verification_settings",
      "parichayam_dashboard_notice",
      "parichayam_plan_prices",
      "parichayam_site_settings",
      "parichayam_addon_prices",
      "parichayam_connect_packs",
      "parichayam_connect_costs",
      "parichayam_coupons",
      "parichayam_gotras",
      "parichayam_ads",
      "parichayam_dash_vis",
      "parichayam_communities",
      "parichayam_agent_directory",
      "parichayam_public_profile_fields",
    ],
    checkout: [
      "parichayam_plan_prices",
      "parichayam_site_settings",
      "parichayam_payment_settings",
      "parichayam_coupons",
      "parichayam_kundali_pack_settings",
      "parichayam_verification_settings",
    ],
    admin: [
      "parichayam_trial_settings",
      "parichayam_kundali_settings",
      "parichayam_kundali_pack_settings",
      "parichayam_verification_settings",
      "parichayam_dashboard_notice",
      "parichayam_plan_prices",
      "parichayam_site_settings",
      "parichayam_payment_settings",
      "parichayam_coupons",
      "parichayam_addon_prices",
      "parichayam_connect_packs",
      "parichayam_connect_costs",
      "parichayam_connect_requests",
      "parichayam_gotra_requests",
      "parichayam_gotras",
      "parichayam_ads",
      "parichayam_user_access",
      "parichayam_dash_vis",
      "parichayam_form_fields",
      "parichayam_communities",
      "parichayam_custom_fields",
      "parichayam_agent_referral_settings",
      "parichayam_agent_payout_history",
      "parichayam_agent_directory",
      "parichayam_auth_settings",
      "parichayam_public_profile_fields",
    ],
    agent: ["parichayam_plan_prices"],
    matchmaker: [
      "parichayam_site_settings",
      "parichayam_verification_settings",
      "parichayam_dashboard_notice",
    ],
  };

  async function hydrateBridgedState(pageName, member) {
    if (!db) return;
    const requestedKeys = new Set(PAGE_BRIDGE_KEYS[pageName] || []);
    if (pageName === "admin" && !isAdminMember(member)) return;
    if (!requestedKeys.size) return;
    isApplyingRemoteState = true;
    try {
      for (const key of requestedKeys) {
        const doc = await db.collection(options.stateCollection).doc(key).get();
        if (!doc.exists) continue;
        const data = doc.data() || {};
        writeLocalCache(key, data.value ?? {});
      }
    } finally {
      isApplyingRemoteState = false;
    }
  }

  async function readStateValue(key, fallback) {
    if (!db) return fallback;
    const doc = await db.collection(options.stateCollection).doc(key).get();
    if (!doc.exists) return fallback;
    return doc.data()?.value ?? fallback;
  }

  async function getPublicSettingsBundle() {
    const [trial, kundali, notice, verification, kundaliPack, authSettings] = await Promise.all([
      readStateValue("parichayam_trial_settings", DEFAULT_TRIAL_SETTINGS),
      readStateValue("parichayam_kundali_settings", DEFAULT_KUNDALI_SETTINGS),
      readStateValue("parichayam_dashboard_notice", DEFAULT_DASHBOARD_NOTICE),
      readStateValue("parichayam_verification_settings", DEFAULT_VERIFICATION_SETTINGS),
      readStateValue("parichayam_kundali_pack_settings", DEFAULT_KUNDALI_PACK_SETTINGS),
      readStateValue("parichayam_auth_settings", DEFAULT_AUTH_SETTINGS),
    ]);
    return {
      trial: normalizeTrialSettings(trial),
      kundali: normalizeKundaliSettings(kundali),
      notice: normalizeNotice(notice),
      verification: normalizeVerificationSettings(verification),
      kundaliPack: normalizeKundaliPackSettings(kundaliPack),
      auth: normalizeAuthSettings(authSettings),
    };
  }

  async function getAgentDirectory() {
    return normalizeAgentDirectory(
      await readStateValue("parichayam_agent_directory", DEFAULT_AGENT_DIRECTORY)
    );
  }

  function getVerificationLabel(member) {
    const aadhaarVerified = member?.aadhaarVerified === true || member?.verificationStatus?.aadhaar === "verified";
    const incomeVerified = member?.incomeVerified === true || member?.verificationStatus?.income === "verified";
    if (aadhaarVerified && incomeVerified) return "ID + Income Verified";
    if (aadhaarVerified) return "ID Verified";
    if (incomeVerified) return "Income Verified";
    return "Verification Pending";
  }

  function buildPublicProfileDoc(member) {
    const name = String(member?.name || member?.fullName || "").trim();
    const ageRaw = parseInt(member?.age ?? member?.profileAge ?? "", 10);
    return {
      uid: String(member?.uid || member?.id || "").trim(),
      profileNumber: normalizeProfileNumber(member?.profileNumber || ""),
      name,
      age: Number.isFinite(ageRaw) && ageRaw > 0 ? ageRaw : null,
      city: String(member?.city || member?.currentCity || member?.location || "").trim(),
      state: String(member?.state || "").trim(),
      community: String(member?.community || member?.caste || "").trim(),
      education: String(member?.education || member?.edu || "").trim(),
      profession: String(member?.profession || member?.designation || member?.job || "").trim(),
      nakshatra: String(member?.nakshatra || member?.nak || "").trim(),
      rashi: String(member?.rashi || "").trim(),
      gotra: String(member?.gotra || "").trim(),
      padam: String(member?.padam || "").trim(),
      about: String(member?.about || "").trim(),
      gender: String(member?.gender || "").trim(),
      verificationLabel: getVerificationLabel(member),
      aadhaarVerified: member?.aadhaarVerified === true || member?.verificationStatus?.aadhaar === "verified",
      incomeVerified: member?.incomeVerified === true || member?.verificationStatus?.income === "verified",
      updatedAt: member?.updatedAt || nowIso(),
      createdAt: member?.createdAt || member?.registeredOn || nowIso(),
    };
  }

  async function syncPublicProfileDoc(member) {
    if (!db) return null;
    const docData = buildPublicProfileDoc(member);
    if (!docData.uid || !docData.profileNumber) return null;
    await withTimeout(
      db.collection(options.publicProfilesCollection).doc(docData.profileNumber).set(docData, { merge: true }),
      FIRESTORE_OP_TIMEOUT_MS,
      "Unable to refresh the public profile record right now. Please try again.",
      "firestore/public-profile-timeout"
    );
    return docData;
  }

  async function assignProfileNumberIfMissing(uid) {
    if (!db || !uid) return "";
    const memberRef = db.collection(options.membersCollection).doc(uid);
    const counterRef = db.collection(options.countersCollection).doc("publicProfileNumber");
    return withTimeout(
      db.runTransaction(async (transaction) => {
        const memberSnap = await transaction.get(memberRef);
        if (!memberSnap.exists) return "";
        const currentProfileNumber = normalizeProfileNumber(memberSnap.data()?.profileNumber || "");
        if (currentProfileNumber) return currentProfileNumber;
        const counterSnap = await transaction.get(counterRef);
        const nextValue = Math.max(100001, parseInt(counterSnap.data()?.nextValue ?? 100001, 10) || 100001);
        const profileNumber = profileNumberFromCounter(nextValue);
        transaction.set(counterRef, {
          nextValue: nextValue + 1,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        transaction.set(memberRef, {
          profileNumber,
          updatedAt: nowIso(),
        }, { merge: true });
        return profileNumber;
      }),
      FIRESTORE_OP_TIMEOUT_MS,
      "Unable to reserve a profile number right now. Please try again.",
      "firestore/profile-number-timeout"
    );
  }

  function persistMemberSession(member) {
    if (!member) return;
    const session = { ...member };
    if (session.uid && !session.id) session.id = session.uid;
    window.USER_SESSION = session;
    sessionStorage.setItem("parichayam_member_session", JSON.stringify(session));
    sessionStorage.setItem("parichayam_auth_token", "firebase:" + (session.uid || session.id || "session"));
  }

  function clearMemberSession() {
    delete window.USER_SESSION;
    sessionStorage.removeItem("parichayam_member_session");
    sessionStorage.removeItem("parichayam_auth_token");
  }

  function readRegistrationDraft() {
    try {
      return parseMaybeJson(sessionStorage.getItem(REGISTRATION_DRAFT_KEY) || localStorage.getItem(REGISTRATION_DRAFT_KEY) || "null");
    } catch (error) {
      return null;
    }
  }

  function clearRegistrationDraft() {
    try {
      sessionStorage.removeItem(REGISTRATION_DRAFT_KEY);
      localStorage.removeItem(REGISTRATION_DRAFT_KEY);
    } catch (error) {}
  }

  async function ensureMemberDoc(user) {
    if (!user || !db) return null;
    const ref = db.collection(options.membersCollection).doc(user.uid);
    const doc = await withTimeout(
      ref.get(),
      FIRESTORE_OP_TIMEOUT_MS,
      "Unable to load your profile right now. Please try again.",
      "firestore/member-read-timeout"
    );
    if (doc.exists) {
      const data = doc.data() || {};
      const member = { id: user.uid, uid: user.uid, email: user.email || "", ...data };
      if (!normalizeProfileNumber(member.profileNumber)) {
        member.profileNumber = await assignProfileNumberIfMissing(user.uid).catch(() => "");
      }
      await syncPublicProfileDoc(member).catch(() => null);
      persistMemberSession(member);
      clearRegistrationDraft();
      return member;
    }

    const draft = readRegistrationDraft();
    const matchesDraft = draft && (
      String(draft.uid || "") === String(user.uid || "") ||
      (toLowerEmail(draft.email || "") && toLowerEmail(draft.email || "") === toLowerEmail(user.email || ""))
    );
    const member = {
      id: user.uid,
      uid: user.uid,
      name: user.displayName || "",
      phone: normalizePhone(user.phoneNumber || ""),
      email: user.email || "",
      profileFor: "",
      gender: "",
      plan: "trial",
      tier: "trial",
      pendingPlan: "",
      isPaid: false,
      profileNumber: "",
      registeredOn: nowIso(),
      trialDurationDays: DEFAULT_TRIAL_SETTINGS.durationDays,
      trialEndsOn: new Date(Date.now() + DEFAULT_TRIAL_SETTINGS.durationDays * 86400000).toISOString(),
      connects: DEFAULT_TRIAL_SETTINGS.trialConnects,
      connectsMax: DEFAULT_TRIAL_SETTINGS.trialConnects,
      role: "MEMBER",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      agentRefId: "",
      referredByAgentRefId: "",
      referredByAgentName: "",
      referredByAgentCity: "",
      referredByAgentTier: "",
      referredByAgentMobile: "",
      agentReferralStatus: "",
      referredAt: "",
      ...(matchesDraft ? draft : {}),
    };
    member.id = user.uid;
    member.uid = user.uid;
    member.email = user.email || member.email || "";
    member.phone = normalizePhone(member.phone || "");
    member.role = "MEMBER";
    await withTimeout(
      ref.set(member, { merge: true }),
      FIRESTORE_OP_TIMEOUT_MS,
      "Unable to save your profile right now. Please try again.",
      "firestore/member-write-timeout"
    );
    if (member.phone) {
      await withTimeout(
        db.collection(options.phoneIndexCollection).doc(member.phone).set(
          {
            uid: member.uid,
            email: member.email,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        ),
        FIRESTORE_OP_TIMEOUT_MS,
        "Unable to finish saving your profile right now. Please try again.",
        "firestore/phone-index-timeout"
      );
    }
    member.profileNumber = await assignProfileNumberIfMissing(member.uid).catch(() => "");
    await syncPublicProfileDoc(member).catch(() => null);
    persistMemberSession(member);
    clearRegistrationDraft();
    return member;
  }

  async function resolveIdentifierToEmail(identifier) {
    const value = String(identifier || "").trim();
    if (!value) throw buildError(400, "Enter your mobile number or email.");
    if (value.includes("@")) return toLowerEmail(value);

    const phone = normalizePhone(value);
    if (phone.length < 10) throw buildError(400, "Enter a valid 10-digit mobile number.");

    const indexDoc = await withTimeout(
      db.collection(options.phoneIndexCollection).doc(phone).get(),
      FIRESTORE_OP_TIMEOUT_MS,
      "Unable to verify that mobile number right now. Please try again.",
      "firestore/phone-lookup-timeout"
    );
    if (indexDoc.exists && indexDoc.data()?.email) return toLowerEmail(indexDoc.data().email);

    try {
      const memberSnapshot = await withTimeout(
        db.collection(options.membersCollection).where("phone", "==", phone).limit(1).get(),
        FIRESTORE_OP_TIMEOUT_MS,
        "Unable to verify that mobile number right now. Please try again.",
        "firestore/member-lookup-timeout"
      );
      if (!memberSnapshot.empty) {
        return toLowerEmail(memberSnapshot.docs[0].data()?.email);
      }
    } catch (error) {
      if (String(error?.code || "") !== "permission-denied") throw error;
    }

    throw buildError(404, "No account found for this mobile number.");
  }

  async function requireCurrentMember() {
    const user = await ensureAuthReady();
    if (!user) throw buildError(401, "Please sign in to continue.");
    const member = await ensureMemberDoc(user);
    if (!member) throw buildError(401, "Please sign in to continue.");
    return member;
  }

  async function requireAdminMember() {
    const member = await requireCurrentMember();
    if (!isAdminMember(member)) throw buildError(403, "This account does not have admin access.");
    return member;
  }

  async function requireStaffMember() {
    const member = await requireCurrentMember();
    if (!isStaffMember(member)) throw buildError(403, "This account does not have staff access.");
    return member;
  }

  function sanitizeMember(memberDoc, id) {
    const data = memberDoc || {};
    return {
      id: id || data.id || data.uid || "",
      uid: data.uid || id || "",
      name: String(data.name || "").trim(),
      email: String(data.email || "").trim(),
      phone: normalizePhone(data.phone || ""),
      profileNumber: normalizeProfileNumber(data.profileNumber || ""),
      city: String(data.city || data.currentCity || "").trim(),
      role: normalizeRole(data.role || "MEMBER"),
      tier: String(data.tier || data.plan || "").trim(),
      plan: String(data.plan || "").trim(),
      isPaid: data.isPaid === true,
      verificationStatus: data.verificationStatus || {},
      assignedMatchmakerUid: data.assignedMatchmakerUid || "",
      assignedMatchmakerName: data.assignedMatchmakerName || "",
      staffScope: data.staffScope || {},
      updatedAt: data.updatedAt || data.createdAt || "",
      referredByAgentRefId: data.referredByAgentRefId || "",
    };
  }

  async function listMembers(limitValue) {
    await requireStaffMember();
    const snapshot = await db.collection(options.membersCollection).limit(limitValue || 500).get();
    return snapshot.docs.map((doc) => sanitizeMember(doc.data(), doc.id));
  }

  async function updateMemberFields(uid, patch) {
    const actor = await requireStaffMember();
    const cleanUid = String(uid || "").trim();
    if (!cleanUid) throw buildError(400, "Missing member ID.");
    const updates = { ...(patch || {}), updatedAt: nowIso(), updatedByStaffUid: actor.uid };
    if (!isAdminMember(actor)) {
      delete updates.role;
      delete updates.staffScope;
      delete updates.assignedMatchmakerUid;
      delete updates.assignedMatchmakerName;
      delete updates.assignedVerificationStaffUid;
      delete updates.assignedVerificationStaffName;
    }
    await db.collection(options.membersCollection).doc(cleanUid).set(updates, { merge: true });
    const doc = await db.collection(options.membersCollection).doc(cleanUid).get();
    return sanitizeMember(doc.data(), cleanUid);
  }

  async function updateCurrentMemberFields(patch) {
    const member = await requireCurrentMember();
    const updated = await updateMemberFields(member.uid, patch);
    persistMemberSession({ ...member, ...updated });
    return updated;
  }

  async function setMemberRole(body) {
    const admin = await requireAdminMember();
    const uid = String(body?.uid || "").trim();
    const role = normalizeRole(body?.role || "MEMBER");
    if (!uid) throw buildError(400, "Member ID is required.");
    await db.collection(options.membersCollection).doc(uid).set(
      {
        role,
        staffScope: {
          cities: Array.isArray(body?.cities) ? body.cities.filter(Boolean) : [],
          active: body?.active !== false,
        },
        updatedAt: nowIso(),
        updatedByStaffUid: admin.uid,
      },
      { merge: true }
    );
    const doc = await db.collection(options.membersCollection).doc(uid).get();
    return sanitizeMember(doc.data(), uid);
  }

  async function createVerificationRequest(body) {
    const member = await requireCurrentMember();
    const type = String(body?.type || "").trim().toLowerCase();
    if (!["aadhaar", "income"].includes(type)) throw buildError(400, "Invalid verification type.");
    const docData = {
      memberUid: member.uid,
      memberName: member.name || member.email || "Member",
      memberPhone: member.phone || "",
      memberEmail: member.email || "",
      type,
      status: String(body?.status || "awaiting_payment"),
      amount: Math.max(0, parseInt(body?.amount || 0, 10) || 0),
      paymentStatus: String(body?.paymentStatus || "pending"),
      submittedAt: nowIso(),
      updatedAt: nowIso(),
      assignedToUid: String(body?.assignedToUid || ""),
      assignedToName: String(body?.assignedToName || ""),
      documentLabel: String(body?.documentLabel || "").trim(),
      documentType: String(body?.documentType || "").trim(),
      documentName: String(body?.documentName || "").trim(),
      documentUrl: String(body?.documentUrl || "").trim(),
      storagePending: body?.storagePending === true,
      note: String(body?.note || "").trim(),
      requestedFrom: String(body?.requestedFrom || "dashboard"),
      lastReminderAt: body?.lastReminderAt || "",
      reminderCount: Math.max(0, parseInt(body?.reminderCount || 0, 10) || 0),
      assignedRole: type === "income" ? "EMPLOYEE" : "MATCHMAKER",
    };
    const ref = await db.collection("verificationRequests").add(docData);
    trackSqlEvent("verification", {
      firebaseUid: member.uid,
      verificationType: type,
      status: docData.status,
      amount: docData.amount,
      paymentStatus: docData.paymentStatus,
      requestId: ref.id,
    });
    return { id: ref.id, ...docData };
  }

  async function listVerificationRequests(filter) {
    const actor = await requireStaffMember();
    let query = db.collection("verificationRequests");
    if (!isAdminMember(actor)) {
      query = query.where("assignedToUid", "==", actor.uid);
    }
    const snapshot = await query.limit(300).get();
    let items = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    if (filter?.status) items = items.filter((item) => String(item.status || "") === String(filter.status));
    if (filter?.type) items = items.filter((item) => String(item.type || "") === String(filter.type));
    return items.sort((a, b) => Date.parse(b.updatedAt || b.submittedAt || "") - Date.parse(a.updatedAt || a.submittedAt || ""));
  }

  async function saveVerificationRequest(id, patch) {
    const actor = await requireStaffMember();
    const cleanId = String(id || "").trim();
    if (!cleanId) throw buildError(400, "Verification request ID is required.");
    const ref = db.collection("verificationRequests").doc(cleanId);
    const existing = await ref.get();
    if (!existing.exists) throw buildError(404, "Verification request not found.");
    const data = existing.data() || {};
    if (!isAdminMember(actor) && String(data.assignedToUid || "") !== String(actor.uid || "")) {
      throw buildError(403, "This verification task is not assigned to you.");
    }
    const next = { ...(patch || {}), updatedAt: nowIso(), updatedByStaffUid: actor.uid };
    await ref.set(next, { merge: true });
    if (patch?.status === "approved" || patch?.status === "rejected") {
      const memberRef = db.collection(options.membersCollection).doc(String(data.memberUid || ""));
      const memberPatch = data.type === "aadhaar"
        ? { verificationStatus: { ...(patch?.memberVerificationStatus || {}), aadhaar: patch.status === "approved" ? "verified" : "rejected" }, aadhaarVerified: patch.status === "approved" }
        : { verificationStatus: { ...(patch?.memberVerificationStatus || {}), income: patch.status === "approved" ? "verified" : "rejected" }, incomeVerified: patch.status === "approved" };
      await memberRef.set(memberPatch, { merge: true });
    }
    const latest = await ref.get();
    return { id: latest.id, ...(latest.data() || {}) };
  }

  async function createMemberAssignment(body) {
    const admin = await requireAdminMember();
    const assignedRole = normalizeRole(body?.assignedRole || "MATCHMAKER");
    const payload = {
      memberUid: String(body?.memberUid || "").trim(),
      memberName: String(body?.memberName || "").trim(),
      memberPhone: normalizePhone(body?.memberPhone || ""),
      memberEmail: toLowerEmail(body?.memberEmail || ""),
      memberCity: String(body?.memberCity || "").trim(),
      memberTier: String(body?.memberTier || "").trim(),
      assignedToUid: String(body?.assignedToUid || "").trim(),
      assignedToName: String(body?.assignedToName || "").trim(),
      assignedRole,
      status: normalizeAssignmentStatus(body?.status || (assignedRole === "EMPLOYEE" ? "verification_pending" : "new"), assignedRole),
      note: String(body?.note || "").trim(),
      incentiveAmount: Math.max(0, parseFloat(body?.incentiveAmount || 0) || 0),
      nextFollowUpAt: String(body?.nextFollowUpAt || "").trim(),
      lastContactAt: String(body?.lastContactAt || "").trim(),
      outcome: String(body?.outcome || "").trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      createdBy: admin.uid,
    };
    const ref = await db.collection("memberAssignments").add(payload);
    return { id: ref.id, ...payload };
  }

  async function listMemberAssignments(filter) {
    const actor = await requireStaffMember();
    let query = db.collection("memberAssignments");
    if (!isAdminMember(actor)) {
      query = query.where("assignedToUid", "==", actor.uid);
    }
    const snapshot = await query.limit(300).get();
    let items = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    if (filter?.assignedRole) items = items.filter((item) => normalizeRole(item.assignedRole) === normalizeRole(filter.assignedRole));
    return items.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
  }

  async function saveMemberAssignment(id, patch) {
    const actor = await requireStaffMember();
    const ref = db.collection("memberAssignments").doc(String(id || "").trim());
    const existing = await ref.get();
    if (!existing.exists) throw buildError(404, "Assignment not found.");
    const data = existing.data() || {};
    if (!isAdminMember(actor) && String(data.assignedToUid || "") !== String(actor.uid || "")) {
      throw buildError(403, "This client assignment is not assigned to you.");
    }
    const next = { ...(patch || {}), updatedAt: nowIso(), updatedBy: actor.uid };
    if (Object.prototype.hasOwnProperty.call(next, "status")) {
      const actorRole = normalizeRole(actor.role);
      const assignedRole = normalizeRole(data.assignedRole || actorRole);
      const requestedStatus = normalizeAssignmentStatus(next.status, assignedRole);
      if (!isAdminMember(actor)) {
        const allowed = actorRole === "EMPLOYEE" ? EMPLOYEE_ASSIGNMENT_STATUSES : MATCHMAKER_PIPELINE_STATUSES;
        if (!allowed.includes(requestedStatus)) {
          throw buildError(403, "This role cannot move the case into that stage.");
        }
      }
      next.status = requestedStatus;
      next.outcome = String(next.outcome || requestedStatus).trim().toLowerCase();
    }
    await ref.set(next, { merge: true });
    const latest = await ref.get();
    return { id: latest.id, ...(latest.data() || {}) };
  }

  async function logStaffActivity(body) {
    const actor = await requireStaffMember();
    const payload = {
      actorUid: actor.uid,
      actorName: actor.name || actor.email || "Staff",
      actorRole: normalizeRole(actor.role),
      memberUid: String(body?.memberUid || "").trim(),
      memberName: String(body?.memberName || "").trim(),
      type: String(body?.type || "note").trim().toLowerCase(),
      note: String(body?.note || "").trim(),
      createdAt: nowIso(),
    };
    const ref = await db.collection("staffActivityLogs").add(payload);
    return { id: ref.id, ...payload };
  }

  async function listStaffActivity(filter) {
    const actor = await requireStaffMember();
    let query = db.collection("staffActivityLogs");
    if (!isAdminMember(actor)) {
      query = query.where("actorUid", "==", actor.uid);
    }
    const snapshot = await query.limit(300).get();
    let items = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    if (filter?.memberUid) items = items.filter((item) => String(item.memberUid || "") === String(filter.memberUid));
    return items.sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
  }

  async function apiRegister(body) {
    const name = String(body?.name || "").trim();
    const phone = normalizePhone(body?.phone || "");
    const email = toLowerEmail(body?.email || "");
    const password = String(body?.password || "");
    const profileFor = String(body?.profileFor || "");
    const gender = String(body?.gender || "");
    const pendingPlan = String(body?.pendingPlan || "");
    const agentRefId = normalizeAgentRefId(body?.agentRefId || "");
    const phoneVerified = body?.phoneVerified === true;
    const phoneVerificationProvider = String(body?.phoneVerificationProvider || (phoneVerified ? "msg91" : "")).trim().toLowerCase();
    const phoneVerifiedAt = String(body?.phoneVerifiedAt || "").trim();

    if (!name) throw buildError(400, "Enter the full name.");
    if (phone.length < 10) throw buildError(400, "Enter a valid 10-digit mobile number.");
    if (!email.includes("@")) throw buildError(400, "Enter a valid email address.");
    if (password.length < 8) throw buildError(400, "Password must be at least 8 characters.");

    const existingPhone = await withTimeout(
      db.collection(options.phoneIndexCollection).doc(phone).get(),
      FIRESTORE_OP_TIMEOUT_MS,
      "Unable to verify this mobile number right now. Please try again.",
      "firestore/register-phone-timeout"
    );
    if (existingPhone.exists) throw buildError(409, "Mobile already registered. Sign in instead.");

    const credential = await withTimeout(
      auth.createUserWithEmailAndPassword(email, password),
      AUTH_READY_TIMEOUT_MS,
      "Account creation is taking longer than expected. Please try again.",
      "auth/register-timeout"
    );
    await credential.user.getIdToken(true).catch(() => {});
    await waitForCurrentUser(credential.user.uid, AUTH_READY_TIMEOUT_MS).catch(() => credential.user);
    const trialSettings = normalizeTrialSettings(await readStateValue("parichayam_trial_settings", DEFAULT_TRIAL_SETTINGS));
    const agentDirectory = agentRefId ? await getAgentDirectory().catch(() => DEFAULT_AGENT_DIRECTORY) : DEFAULT_AGENT_DIRECTORY;
    const matchedAgent = agentRefId
      ? agentDirectory.find((agent) => agent.refId === agentRefId && agent.active !== false)
      : null;
    const registeredOn = new Date();
    const member = {
      id: credential.user.uid,
      uid: credential.user.uid,
      name,
      phone,
      email,
      profileFor,
      gender,
      plan: "trial",
      tier: "trial",
      pendingPlan,
      isPaid: false,
      profileNumber: "",
      registeredOn: registeredOn.toISOString(),
      trialDurationDays: trialSettings.durationDays,
      trialEndsOn: new Date(registeredOn.getTime() + trialSettings.durationDays * 86400000).toISOString(),
      connects: trialSettings.trialConnects,
      connectsMax: trialSettings.trialConnects,
      role: "MEMBER",
      createdAt: registeredOn.toISOString(),
      updatedAt: registeredOn.toISOString(),
      ...(phoneVerified ? {
        phoneVerified: true,
        phoneVerificationProvider: phoneVerificationProvider || "msg91",
        phoneVerifiedAt: phoneVerifiedAt || registeredOn.toISOString(),
      } : {}),
      ...(agentRefId ? {
        agentRefId,
        referredByAgentRefId: agentRefId,
        referredByAgentName: matchedAgent?.name || "",
        referredByAgentCity: matchedAgent?.city || "",
        referredByAgentTier: matchedAgent?.tier || "",
        referredByAgentMobile: matchedAgent?.mobile || "",
        agentReferralStatus: matchedAgent ? "matched" : (agentDirectory.length ? "unverified" : "pending"),
        referredAt: registeredOn.toISOString(),
      } : {}),
    };

    await withTimeout(
      db.collection(options.membersCollection).doc(member.uid).set(member, { merge: true }),
      FIRESTORE_OP_TIMEOUT_MS,
      "Account created, but saving your profile is taking too long. Please sign in once and try again.",
      "firestore/register-member-timeout"
    );
    await withTimeout(
      db.collection(options.phoneIndexCollection).doc(phone).set(
        {
          uid: member.uid,
          email,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      ),
      FIRESTORE_OP_TIMEOUT_MS,
      "Account created, but linking your mobile number is taking too long. Please sign in once and try again.",
      "firestore/register-phone-index-timeout"
    );
    member.profileNumber = await assignProfileNumberIfMissing(member.uid).catch(() => "");
    await syncPublicProfileDoc(member).catch(() => null);
    persistMemberSession(member);
    trackSqlEvent("member", {
      firebaseUid: member.uid,
      name: member.name || "",
      phone: member.phone || "",
      email: member.email || "",
      profileNumber: member.profileNumber || "",
      plan: member.plan || "",
      tier: member.tier || "",
      isPaid: member.isPaid === true,
      registeredOn: member.registeredOn || "",
      agentRefId: member.agentRefId || "",
    });
    return {
      member,
      token: "firebase:" + member.uid,
      trialSettings,
    };
  }

  async function apiLogin(body) {
    const email = await resolveIdentifierToEmail(body?.identifier || "");
    const password = String(body?.password || "");
    if (!password) throw buildError(400, "Enter your password.");

    const credential = await auth.signInWithEmailAndPassword(email, password);
    const member = await ensureMemberDoc(credential.user);
    return {
      member,
      token: "firebase:" + credential.user.uid,
    };
  }

  async function signInWithCustomToken(customToken) {
    const token = String(customToken || "").trim();
    if (!token) throw buildError(400, "Missing secure login token.");
    const credential = await auth.signInWithCustomToken(token);
    const member = await ensureMemberDoc(credential.user);
    return {
      member,
      token: "firebase:" + credential.user.uid,
    };
  }

  async function apiAuthMe() {
    const member = await requireCurrentMember();
    return { member };
  }

  async function findPublicProfileByNumber(profileNumber) {
    const normalized = normalizeProfileNumber(profileNumber);
    if (!normalized) throw buildError(400, "Enter a valid P number.");
    await ensureAuthReady();
    if (!auth?.currentUser) throw buildError(401, "Please sign in to search by P number.");
    const doc = await withTimeout(
      db.collection(options.publicProfilesCollection).doc(normalized).get(),
      FIRESTORE_OP_TIMEOUT_MS,
      "Unable to search that P number right now. Please try again.",
      "firestore/public-profile-read-timeout"
    );
    if (!doc.exists) throw buildError(404, "No profile was found for that P number.");
    return { profile: { id: doc.id, ...(doc.data() || {}) } };
  }

  async function apiLogout() {
    await auth.signOut();
    clearMemberSession();
    return { success: true };
  }

  async function apiForgotPasswordRequest(body) {
    const email = await resolveIdentifierToEmail(body?.identifier || "");
    await auth.sendPasswordResetEmail(email, {
      url: String(options.appUrl || window.location.origin || "https://parichayam.co.in") + "/auth.html",
      handleCodeInApp: false,
    });
    return {
      maskedEmail: maskEmail(email),
      delivery: "firebase-email-link",
    };
  }

  async function apiForgotPasswordVerify() {
    throw buildError(400, "This build uses Firebase email reset links. Open the reset email and set your new password there.");
  }

  async function apiForgotPasswordReset() {
    throw buildError(400, "This build uses Firebase email reset links. Open the reset email and set your new password there.");
  }

  async function apiUpdateJathakam(body) {
    const member = await requireCurrentMember();
    const allowedKeys = [
      "dob",
      "dateOfBirth",
      "timeOfBirth",
      "placeOfBirth",
      "star",
      "nakshatra",
      "rashi",
      "padam",
      "gotra",
      "swaGotram",
      "maternalGotra",
      "mothersGotra",
      "dosham",
      "manglik",
      "height",
      "complexion",
      "education",
      "profession",
      "salary",
      "community",
      "caste",
      "subCaste",
      "jathakam",
      "kundali",
      "jathakamCompleted",
      "kundaliScore",
      "profilePhoto",
      "photoUrl",
      "address",
    ];
    const patch = {};
    allowedKeys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(body || {}, key)) patch[key] = body[key];
    });
    patch.updatedAt = nowIso();

    await db.collection(options.membersCollection).doc(member.uid).set(patch, { merge: true });
    const updated = { ...member, ...patch };
    persistMemberSession(updated);
    return { member: updated };
  }

  async function getTrialWatchlist() {
    const snapshot = await db.collection(options.membersCollection).limit(500).get();
    const now = Date.now();
    const items = [];
    snapshot.forEach((doc) => {
      const member = doc.data() || {};
      if (String(member.tier || "").toLowerCase() !== "trial") return;
      const end = Date.parse(member.trialEndsOn || "");
      if (!Number.isFinite(end)) return;
      const daysLeft = Math.ceil((end - now) / 86400000);
      if (daysLeft > 3) return;
      items.push({
        id: doc.id,
        name: member.name || member.email || member.phone || "Member",
        phone: member.phone || "",
        email: member.email || "",
        trialEndsOn: member.trialEndsOn || "",
        daysLeft,
      });
    });
    items.sort((a, b) => a.daysLeft - b.daysLeft);
    return items.slice(0, 20);
  }

  async function apiGetAdminSettings() {
    await requireAdminMember();
    const settings = await getPublicSettingsBundle();
    const trialWatchlist = await getTrialWatchlist();
    return { settings, trialWatchlist };
  }

  async function apiSaveAdminTrial(body) {
    const member = await requireAdminMember();
    const settings = normalizeTrialSettings(body || {});
    await setBridgedState("parichayam_trial_settings", settings, { updatedBy: member.uid });
    writeLocalCache("parichayam_trial_settings", settings);
    return { trial: settings };
  }

  async function apiSaveAdminKundali(body) {
    const member = await requireAdminMember();
    const settings = normalizeKundaliSettings(body || {});
    await setBridgedState("parichayam_kundali_settings", settings, { updatedBy: member.uid });
    writeLocalCache("parichayam_kundali_settings", settings);
    return { kundali: settings };
  }

  async function apiSaveAdminNotice(body) {
    const member = await requireAdminMember();
    const notice = normalizeNotice(body || {});
    await setBridgedState("parichayam_dashboard_notice", notice, { updatedBy: member.uid });
    writeLocalCache("parichayam_dashboard_notice", notice);
    return { notice };
  }

  async function setStateValue(key, value) {
    const member = await requireAdminMember();
    let normalized = value;
    if (key === "parichayam_trial_settings") normalized = normalizeTrialSettings(value);
    if (key === "parichayam_kundali_settings") normalized = normalizeKundaliSettings(value);
    if (key === "parichayam_dashboard_notice") normalized = normalizeNotice(value);
    if (key === "parichayam_verification_settings") normalized = normalizeVerificationSettings(value);
    if (key === "parichayam_kundali_pack_settings") normalized = normalizeKundaliPackSettings(value);
    await setBridgedState(key, normalized, { updatedBy: member.uid });
    writeLocalCache(key, normalized);
    return normalized;
  }

  async function apiCompleteMembership(body) {
    const member = await requireCurrentMember();
    const amount = parseInt(String(body?.amount || "").replace(/[^\d]/g, ""), 10) || 0;
    const updated = {
      plan: String(body?.plan || member.plan || "paid"),
      planName: String(body?.planName || member.planName || ""),
      tier: "paid",
      isPaid: true,
      pendingPlan: "",
      lastPaymentId: String(body?.gatewayPaymentId || body?.paymentId || ""),
      lastPaymentAt: nowIso(),
      lastPaymentAmount: amount,
      paymentGateway: String(body?.gateway || ""),
      paymentCurrency: String(body?.currency || "INR"),
      updatedAt: nowIso(),
    };
    await db.collection(options.membersCollection).doc(member.uid).set(updated, { merge: true });
    const merged = { ...member, ...updated };
    persistMemberSession(merged);
    trackSqlEvent("payment", {
      firebaseUid: merged.uid,
      plan: merged.plan || "paid",
      amount: amount,
      currency: String(body?.currency || "INR"),
      gateway: String(body?.gateway || ""),
      paymentId: String(body?.gatewayPaymentId || body?.paymentId || ""),
    });
    return { member: merged };
  }

  function extractApiPath(input) {
    try {
      const url = typeof input === "string" ? new URL(input, window.location.href) : new URL(input.url, window.location.href);
      const marker = url.pathname.indexOf("/api/");
      if (marker === -1) return null;
      return url.pathname.slice(marker + 4);
    } catch (error) {
      return null;
    }
  }

  function parseRequestBody(init) {
    if (!init || !init.body) return {};
    if (typeof init.body === "string") {
      try {
        return JSON.parse(init.body);
      } catch (error) {
        return {};
      }
    }
    return init.body;
  }

  async function handleApiRequest(path, method, body) {
    switch (method + " " + path) {
      case "POST /auth/register":
        return apiRegister(body);
      case "POST /auth/login":
        return apiLogin(body);
      case "GET /auth/me":
        return apiAuthMe();
      case "POST /auth/logout":
        return apiLogout();
      case "POST /auth/forgot-password/request":
        return apiForgotPasswordRequest(body);
      case "POST /auth/forgot-password/verify":
        return apiForgotPasswordVerify(body);
      case "POST /auth/forgot-password/reset":
        return apiForgotPasswordReset(body);
      case "GET /public/settings":
        return { settings: await getPublicSettingsBundle() };
      case "PATCH /profile/jathakam":
        return apiUpdateJathakam(body);
      case "GET /admin/settings":
        return apiGetAdminSettings();
      case "PUT /admin/settings/trial":
        return apiSaveAdminTrial(body);
      case "PUT /admin/settings/kundali":
        return apiSaveAdminKundali(body);
      case "PUT /admin/settings/notice":
        return apiSaveAdminNotice(body);
      case "POST /payment/complete-membership":
        return apiCompleteMembership(body);
      default:
        throw buildError(404, "API route not implemented in Firebase mode.");
    }
  }

  function installFetchInterceptor() {
    if (!originalFetch || !isConfigured) return;
    window.fetch = async function (input, init = {}) {
      const path = extractApiPath(input);
      if (!path) return originalFetch(input, init);

      try {
        if (!SKIP_AUTH_READY_PATHS.has(path)) {
          await ensureAuthReady();
        }
        const payload = await handleApiRequest(path, String(init.method || "GET").toUpperCase(), parseRequestBody(init));
        return makeResponse(200, payload);
      } catch (error) {
        const status = Number(error?.status) || (String(error?.code || "").includes("network") ? 503 : 400);
        return makeResponse(status, {
          message: firebaseMessage(error, "Request failed."),
          code: error?.code || "",
        });
      }
    };
  }

  function patchLocalStorageBridge() {
    if (!window.localStorage || !originalLocalSetItem || !originalLocalRemoveItem) return;

    window.localStorage.setItem = function (key, value) {
      originalLocalSetItem(key, value);
      if (!isConfigured || isApplyingRemoteState || !BRIDGE_KEYS.has(key) || !db) return;
      setBridgedState(key, parseMaybeJson(value), {
        updatedBy: auth?.currentUser?.uid || "",
      }).catch((error) => {
        console.warn("Unable to sync setting to Firebase:", key, error?.message || error);
      });
    };

    window.localStorage.removeItem = function (key) {
      originalLocalRemoveItem(key);
      if (!isConfigured || isApplyingRemoteState || !BRIDGE_KEYS.has(key) || !db) return;
      deleteBridgedState(key).catch((error) => {
        console.warn("Unable to remove Firebase setting:", key, error?.message || error);
      });
    };
  }

  async function bootstrapPage(pageName) {
    if (!isConfigured || !db || !auth) {
      return { configured: false, pageName };
    }
    if (!bootPromise) {
      bootPromise = (async function () {
        await ensureAuthReady();
        const member = auth.currentUser ? await ensureMemberDoc(auth.currentUser) : null;
        await hydrateBridgedState(pageName, member);
        const detail = { configured: true, pageName };
        document.dispatchEvent(new CustomEvent("parichayam:firebase-ready", { detail }));
        return detail;
      })().finally(() => {
        bootPromise = null;
      });
    }
    return bootPromise;
  }

  async function signOutAndRedirect(targetUrl) {
    if (auth) {
      try {
        await auth.signOut();
      } catch (error) {}
    }
    clearMemberSession();
    window.location.href = targetUrl || "auth.html";
    return false;
  }

  function uploadFile(path, file) {
    if (!storage) return Promise.reject(new Error("Firebase Storage is not configured."));
    return storage.ref(path).put(file).then((snapshot) => snapshot.ref.getDownloadURL());
  }

  if (isConfigured && window.firebase) {
    app = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
    try {
      storage = firebase.storage();
    } catch (error) {
      storage = null;
    }

    authReadyPromise = new Promise((resolve) => {
      let settled = false;
      let unsubscribe = function () {};
      const finalize = function (user) {
        if (settled) return;
        settled = true;
        resolve(user || null);
        try {
          unsubscribe();
        } catch (error) {}
      };
      unsubscribe = auth.onAuthStateChanged(async (user) => {
        if (user) {
          try {
            await ensureMemberDoc(user);
          } catch (error) {
            console.warn("Unable to hydrate Firebase member session:", error?.message || error);
          }
        } else {
          clearMemberSession();
        }
        finalize(user);
      }, function () {
        finalize(auth.currentUser || null);
      });
      window.setTimeout(() => {
        finalize(auth.currentUser || null);
      }, AUTH_READY_TIMEOUT_MS);
    });

    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    patchLocalStorageBridge();
    installFetchInterceptor();
  }

  window.ParichayamFirebase = {
    isConfigured: function () {
      return !!(isConfigured && app && auth && db);
    },
    register: apiRegister,
    login: apiLogin,
    requestPasswordReset: apiForgotPasswordRequest,
    signInWithCustomToken,
    completeMembership: apiCompleteMembership,
    bootstrapPage,
    signOutAndRedirect,
    uploadFile,
    getCurrentMember: requireCurrentMember,
    getPublicSettingsBundle,
    getAgentDirectory,
    getStateValue: readStateValue,
    setStateValue,
    listMembers,
    updateMemberFields,
    updateCurrentMemberFields,
    setMemberRole,
    createVerificationRequest,
    listVerificationRequests,
    saveVerificationRequest,
    createMemberAssignment,
    listMemberAssignments,
    saveMemberAssignment,
    logStaffActivity,
    listStaffActivity,
    findPublicProfileByNumber,
    syncStateToLocal: hydrateBridgedState,
    trackSqlEvent,
    options,
  };
})();

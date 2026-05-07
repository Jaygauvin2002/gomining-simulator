// =============================================================
//  auth.js — Google Sign-In + user record-keeping
// =============================================================
//
//  Loaded as an ES module from index.html and admin.html.
//  Exposes: app, auth, db, currentUser, signInWithGoogle(),
//           signOutUser(), isAdmin(user), onUserReady(cb).
//
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";

// ----- init -----
export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
const provider    = new GoogleAuthProvider();
setPersistence(auth, browserLocalPersistence).catch(()=>{});

export let currentUser = null;
export let currentTier = "free";   // "free" | "premium" — kept in sync with Firestore
const readyCallbacks = [];
export function onUserReady(cb) { readyCallbacks.push(cb); }
let unsubTierWatch = null;

// ----- public actions -----
export function signInWithGoogle() {
  return signInWithPopup(auth, provider).catch(err => {
    console.error("Sign-in error:", err);
    alert("Sign-in failed: " + (err.message || err.code));
  });
}
export function signOutUser() { return signOut(auth); }
export function isAdmin(user) {
  return !!user && ADMIN_EMAILS.includes((user.email || "").toLowerCase());
}

// ---- Email magic-link sign-in ----
const EMAIL_LS_KEY = "gms_emailForSignIn";
export async function sendEmailLink(email) {
  const actionCodeSettings = {
    // Firebase will redirect the user back to this exact URL with the sign-in
    // token appended. Stripping the hash keeps the URL clean.
    url: window.location.origin + window.location.pathname,
    handleCodeInApp: true,
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  window.localStorage.setItem(EMAIL_LS_KEY, email);
}

// On page load: if the URL is a sign-in link, finish the sign-in and
// clean the URL so refreshes don't try to reuse the consumed token.
async function tryCompleteEmailLinkSignIn() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return;
  let email = window.localStorage.getItem(EMAIL_LS_KEY);
  if (!email) email = window.prompt("Confirm your email to finish sign-in:");
  if (!email) return;
  try {
    await signInWithEmailLink(auth, email, window.location.href);
    window.localStorage.removeItem(EMAIL_LS_KEY);
    // strip the auth params from the URL bar
    history.replaceState({}, "", window.location.origin + window.location.pathname);
  } catch (err) {
    console.error("Email-link sign-in failed:", err);
    alert("Sign-in link is invalid or expired. Please request a new one.");
  }
}
tryCompleteEmailLinkSignIn();

// ---- Live user count for the landing page (publicly readable) ----
(async function loadPublicUserCount() {
  const el = document.getElementById("gate-user-count");
  if (!el) return;
  try {
    const snap = await getDoc(doc(db, "meta", "userCount"));
    const n = snap.exists() ? (snap.data().count || 0) : 0;
    el.textContent = n > 0 ? n.toLocaleString() : "0";
  } catch (e) {
    // happens if Firestore rules don't allow public read on /meta — see SETUP.md
    console.warn("user count fetch failed (check Firestore rules):", e);
    el.textContent = "—";
  }
})();

// ----- record sign-up / login on every auth change -----
async function recordLogin(user) {
  const ref  = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  const base = {
    uid:         user.uid,
    email:       user.email,
    displayName: user.displayName,
    photoURL:    user.photoURL,
    lastLoginAt: serverTimestamp(),
  };
  if (snap.exists()) {
    await updateDoc(ref, { ...base, loginCount: increment(1) });
  } else {
    await setDoc(ref, {
      ...base,
      createdAt:        serverTimestamp(),
      loginCount:       1,
      sessionCount:     0,
      totalPageViews:   0,
      totalSessionMs:   0,
      tier:             "free",   // admin can flip to "premium" from /admin.html
    });
    // Bump the public landing-page counter (displayed on the auth gate).
    try {
      await setDoc(doc(db, "meta", "userCount"),
                   { count: increment(1) },
                   { merge: true });
    } catch (e) { console.warn("counter bump failed:", e); }
  }
}

// ----- sidebar widget (only renders if #auth-widget exists) -----
function renderAuthUI(user) {
  // Top-nav admin pill — show for admins, hide otherwise. Lives outside
  // the main auth-widget so it can be visible without opening the kebab.
  const topAdminBtn = document.getElementById("top-nav-admin-btn");
  if (topAdminBtn) {
    topAdminBtn.style.display = isAdmin(user) ? "inline-flex" : "none";
  }

  const el = document.getElementById("auth-widget");
  if (!el) return;
  if (user) {
    const adminBtn = isAdmin(user)
      ? `<a href="admin.html" target="_blank"
            style="display:block;text-align:center;margin-top:8px;
                   padding:7px;border:1px solid var(--accent);
                   color:var(--accent);border-radius:8px;
                   font-size:0.72em;font-weight:600;text-decoration:none;">
            Admin Dashboard
         </a>` : "";
    const isPremium = currentTier === "premium";
    const tierStyle = isPremium
      ? "background:linear-gradient(90deg,#f7931a,#ffb84d);color:#000;"
      : "background:rgba(139,148,158,.15);color:#8b949e;";
    const tierLabel = isPremium ? "★ PREMIUM" : "FREE";
    const tierBadge = `
      <button id="tier-badge"
              style="margin-top:8px;width:100%;padding:6px 10px;border:none;border-radius:8px;
                     font-size:.7em;font-weight:700;letter-spacing:.04em;cursor:pointer;
                     ${tierStyle}">
        ${tierLabel}${isPremium ? "" : " — Upgrade soon"}
      </button>`;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;
                  background:rgba(255,255,255,0.04);border-radius:8px;
                  border:1px solid var(--border);">
        <img src="${user.photoURL || ""}" alt=""
             style="width:30px;height:30px;border-radius:50%;background:#333;flex-shrink:0;"
             referrerpolicy="no-referrer">
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.78em;font-weight:600;white-space:nowrap;
                      overflow:hidden;text-overflow:ellipsis;">
            ${user.displayName || "User"}
          </div>
          <div style="font-size:0.65em;color:var(--text-dim);white-space:nowrap;
                      overflow:hidden;text-overflow:ellipsis;">
            ${user.email}
          </div>
        </div>
        <button id="signout-btn"
                style="background:none;border:1px solid var(--border);
                       color:var(--text-dim);padding:5px 8px;border-radius:6px;
                       font-size:0.68em;cursor:pointer;">Sign out</button>
      </div>${tierBadge}${adminBtn}`;
    document.getElementById("signout-btn")?.addEventListener("click", signOutUser);
    document.getElementById("tier-badge")?.addEventListener("click", () => {
      if (isPremium) {
        alert("You're a Premium user. Thank you for supporting us! ❤");
      } else {
        alert("Premium plans are coming soon. Stay tuned!\\n\\n" +
              "In the meantime, if you'd like to support development, " +
              "you can leave a small Bitcoin tip on the Support page.");
      }
    });
  } else {
    el.innerHTML = `
      <button id="signin-btn"
              style="width:100%;background:#fff;color:#1a1a1a;border:none;
                     padding:9px 12px;border-radius:8px;font-size:0.8em;
                     font-weight:600;cursor:pointer;display:flex;
                     align-items:center;justify-content:center;gap:8px;">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Sign in with Google
      </button>
      <div style="font-size:0.65em;color:var(--text-dim);text-align:center;
                  margin-top:6px;line-height:1.4;">
        Optional — sync settings & save scenarios
      </div>`;
    document.getElementById("signin-btn")?.addEventListener("click", signInWithGoogle);
  }
}

// ---- Full-screen gate (locks the app for anonymous visitors) ----
function gateEl() { return document.getElementById("auth-gate"); }
function appEl()  { return document.getElementById("app-root"); }

function showGate() {
  const g = gateEl(), a = appEl();
  if (g) g.style.display = "flex";
  if (a) a.style.display = "none";
}
function hideGate() {
  const g = gateEl(), a = appEl();
  if (g) g.style.display = "none";
  if (a) a.style.display = "";
}

function bindGateHandlers() {
  const g = gateEl();
  if (!g || g.__bound) return;
  g.__bound = true;

  g.querySelector("#gate-google")?.addEventListener("click", signInWithGoogle);

  const form    = g.querySelector("#gate-email-form");
  const input   = g.querySelector("#gate-email-input");
  const sendBtn = g.querySelector("#gate-email-send");
  const sentMsg = g.querySelector("#gate-sent");
  const errMsg  = g.querySelector("#gate-err");

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    errMsg.style.display  = "none";
    sentMsg.style.display = "none";
    const email = (input.value || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errMsg.textContent = "Please enter a valid email address.";
      errMsg.style.display = "block";
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    try {
      await sendEmailLink(email);
      sentMsg.innerHTML = `Magic link sent to <strong>${email}</strong>.<br>` +
                          `Open the email on this device and click the link.`;
      sentMsg.style.display = "block";
      input.value = "";
    } catch (err) {
      errMsg.textContent = "Couldn't send link: " + (err.message || err.code);
      errMsg.style.display = "block";
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send magic link";
    }
  });
}

// ----- live tier watcher: keeps currentTier + sidebar badge in sync -----
function watchTier(uid) {
  if (unsubTierWatch) { unsubTierWatch(); unsubTierWatch = null; }
  if (!uid) { currentTier = "free"; return; }
  unsubTierWatch = onSnapshot(doc(db, "users", uid), (snap) => {
    const tier = snap.data()?.tier || "free";
    if (tier !== currentTier) {
      currentTier = tier;
      renderAuthUI(currentUser);
      window.dispatchEvent(new CustomEvent("tier-changed", { detail: { tier } }));
    }
  }, () => { /* ignore permission errors */ });
}

// ----- preview bypass -----
// Internal-only preview link. Gated on hostname so production (gmsim.ca)
// cannot be bypassed — only *.github.io preview deploys honor the param.
const PREVIEW_BYPASS = /\.github\.io$/i.test(location.hostname)
  && new URLSearchParams(location.search).get("preview") === "darun";
if (PREVIEW_BYPASS) {
  document.addEventListener("DOMContentLoaded", () => hideGate());
  setTimeout(() => hideGate(), 0);
}

// ----- main listener -----
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  bindGateHandlers();
  if (PREVIEW_BYPASS) { hideGate(); return; }
  if (user) {
    hideGate();
    try { await recordLogin(user); }
    catch (e) { console.error("recordLogin failed:", e); }
    watchTier(user.uid);
  } else {
    watchTier(null);
    showGate();
  }
  renderAuthUI(user);
  window.dispatchEvent(new CustomEvent("auth-changed", { detail: { user } }));
  readyCallbacks.forEach(cb => { try { cb(user); } catch {} });
});

// expose for the legacy non-module script in index.html
window.__cwAuth = { signInWithGoogle, signOutUser, isAdmin,
                    get currentUser() { return currentUser; } };

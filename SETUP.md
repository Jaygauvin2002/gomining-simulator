# GoMining Simulator — Auth, Admin & AdSense Setup

This guide walks you through everything you need to do **once** to enable Google sign-in, the admin dashboard, and Google AdSense on your site. Plan ~30 minutes.

---

## 0. What got added

| File | What it does |
|---|---|
| `firebase-config.js` | Where you paste your Firebase keys + admin emails |
| `auth.js` | Loads Firebase, draws the Google sign-in button in the sidebar, records each login |
| `tracking.js` | Logs which sections each signed-in user opens, plus session length & page views |
| `admin.html` | Private dashboard for you & your partner (link appears in the sidebar after admin sign-in) |
| `index.html` | 3 small additions: AdSense tags in `<head>`, an `#auth-widget` slot in the sidebar, and `<script type="module">` imports at the bottom |

The site is **fully locked** behind sign-in. Anonymous visitors see only the login screen. They can sign in either with Google **or** a magic link sent to their email (no password). All signed-in users get tracked.

---

## 1. Create your Firebase project

1. Go to https://console.firebase.google.com → **Add project** → name it (e.g. `gomining-simulator`) → continue. You can skip Google Analytics for now.
2. Inside your new project, click the **`</>`** (Web app) icon → register a Web app → call it `web` → it will show you a `firebaseConfig` object that looks like this:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "gomining-xyz.firebaseapp.com",
     projectId: "gomining-xyz",
     storageBucket: "gomining-xyz.appspot.com",
     messagingSenderId: "123456",
     appId: "1:123456:web:abc..."
   };
   ```
3. Open **`firebase-config.js`** in this folder and paste each value into the matching field. Save.

> **Heads-up:** these keys are *not* secrets — Firebase web keys are designed to be public. Security comes from Firestore rules (step 3) and Firebase's authorized-domains list, not from hiding the keys.

---

## 2. Turn on the sign-in methods

The site is **fully gated** — visitors can't see anything until they sign in via Google **or** an email magic link. You need to enable both.

1. Firebase Console → **Build → Authentication → Get started**.
2. Under **Sign-in method**, click **Google** → toggle **Enable** → set a project support email → **Save**.
3. Back on **Sign-in method**, click **Email/Password** → toggle **Enable** AND toggle **Email link (passwordless sign-in)** → **Save**. This is what powers the magic-link emails.
4. Still in Authentication, open the **Settings → Authorized domains** tab. Add the domain you'll host on (e.g. `your-site.vercel.app` or `gominingsimulator.com`). `localhost` is allowed by default for testing.
5. *(Optional but recommended)* Authentication → **Templates** tab → **Email address sign-in** template → click the pencil → customise the email subject/body and the sender name so it doesn't look like spam.

That's it for auth — both sign-in methods will now work.

> **How magic link works:** user types their email → Firebase emails them a link → they click it → they land back on your site already signed in. No password to remember, no SMS, no extra service. Free tier sends ~10k emails/day, plenty for any normal site.

---

## 3. Turn on Firestore (the user database)

1. Firebase Console → **Build → Firestore Database → Create database**.
2. Pick a location close to your users (e.g. `eur3` or `us-central`). Start in **production mode**.
3. Open the **Rules** tab and replace the contents with this — copy it exactly:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       // Users can read & write only their own profile + sessions.
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;

         match /sessions/{sid} {
           allow read, write: if request.auth != null && request.auth.uid == uid;
         }
       }

       // Admins (listed by email below) can read every user doc — for admin.html.
       // ⚠️  Update this list to match ADMIN_EMAILS in firebase-config.js.
       match /users/{uid} {
         allow read: if request.auth != null && request.auth.token.email in [
           "varunvatnani@gmail.com"
           // , "your-partner@gmail.com"
         ];
       }
       match /users/{uid}/sessions/{sid} {
         allow read: if request.auth != null && request.auth.token.email in [
           "varunvatnani@gmail.com"
           // , "your-partner@gmail.com"
         ];
       }
     }
   }
   ```

4. Hit **Publish**. **Important:** any time you add a new admin, update both `firebase-config.js` *and* this rules block — the rules are what actually enforces access.

---

## 4. Sign up for Google AdSense

AdSense approval requires a *live* site (not localhost), so finish hosting (step 5) first if you haven't.

1. Once the site is live at a real URL, go to https://adsense.google.com → sign up → enter your site URL.
2. AdSense gives you a publisher ID like `ca-pub-1234567890123456`. Open `index.html` and replace **both** occurrences of `ca-pub-XXXXXXXXXXXXXXXX` (one in the meta tag, one in the script src) with your real ID. Also update `ADSENSE_PUBLISHER_ID` in `firebase-config.js`.
3. AdSense will then crawl your site for approval. This typically takes a few days to a few weeks.
4. Once approved, you can create individual ad units in AdSense and either let auto-ads place them, or paste specific `<ins class="adsbygoogle">` blocks into the dashboard wherever you want them.

> If you'd like, I can add explicit ad placement slots (e.g. a banner above the dashboard, a sidebar rail) once you have your publisher ID — just say the word.

---

## 5. Host the site

Since you said it isn't hosted yet, here are the easiest options. **Recommended: Vercel** — free tier, instant HTTPS, deploys straight from a GitHub repo, takes 5 minutes.

**Option A — Vercel (recommended)**
1. Push this folder to a GitHub repository.
2. Go to https://vercel.com → **New project** → import the repo → keep all defaults → **Deploy**.
3. You'll get a URL like `gomining-simulator.vercel.app`. Copy it and add it to Firebase's authorized domains (step 2.3).
4. To use a custom domain (e.g. `gomining.app`), Vercel → Project → Settings → Domains.

**Option B — Netlify**
Same idea: drag-and-drop this folder onto https://app.netlify.com/drop, get a URL, add it to Firebase authorized domains.

**Option C — Firebase Hosting**
Free, integrates naturally with the Firebase project you just made. Install the Firebase CLI (`npm i -g firebase-tools`), run `firebase init hosting` in this folder, then `firebase deploy`.

---

## 6. Test it end-to-end

1. Open the site → you should see **only the login screen** (no app behind it).
2. **Test Google flow:** click *Continue with Google* → popup → pick your account → screen disappears, app loads, sidebar shows your avatar.
3. Sign out (button in the sidebar widget). The login screen comes back.
4. **Test magic link:** type your email → *Send magic link* → green confirmation appears → check inbox → click the link → you land back on the site already signed in.
5. Because your email is in `ADMIN_EMAILS`, the sidebar shows an orange **Admin Dashboard** link. Click around different sections for a minute (Dashboard, Simulator, Portfolio…) so there's tracking data.
6. Click **Admin Dashboard** → opens `admin.html` → you should see your own row with login count, session count, page views, and the sections you used.
7. Sign in from a second account (or ask a friend) → reload admin → that user appears too.

If admin.html says **"Failed to load users"**, the Firestore rules aren't right — re-paste them from step 3.3 carefully.

---

## 7. Adding your partner as an admin

Two places, both required:

1. **`firebase-config.js`** — add their Gmail to `ADMIN_EMAILS`:
   ```js
   export const ADMIN_EMAILS = [
     "varunvatnani@gmail.com",
     "partner@gmail.com",
   ];
   ```
2. **Firestore rules** (Firebase Console → Firestore → Rules) — add the same email to *both* `email in […]` lists. Hit **Publish**.

Re-deploy the site (Vercel does it automatically on `git push`). They'll now see the Admin Dashboard link after they sign in.

---

## Common gotchas

- **Sign-in popup gets blocked** — happens on Safari sometimes. Whitelist popups for your domain or switch to redirect flow (let me know and I'll swap `signInWithPopup` for `signInWithRedirect`).
- **Magic link "invalid or expired"** — links expire after ~1 hour and are single-use. Just request a new one. Also: the link must be opened on the *same device/browser* it was requested from, otherwise the email will be re-prompted (this is a Firebase security feature).
- **Magic-link emails go to spam** — happens with brand-new domains. Customise the email template (step 2.5) and consider setting up SPF/DKIM on your domain once you buy one. Or, longer term, configure Firebase to send via your own domain.
- **"This domain is not authorized"** — you forgot step 2.3. Add the live URL in Firebase Auth → Settings → Authorized domains.
- **AdSense rejects the site** — common reasons: not enough content, no privacy policy, brand-new domain. AdSense usually wants a `/privacy` page; I can add one if you want.
- **Admin page works for you but not partner** — they're in `firebase-config.js` but you forgot to update the Firestore rules.

---

## What it costs

- **Firebase Auth + Firestore**: free up to 50k reads/day and 1 GiB storage. You won't hit those for thousands of users.
- **Vercel/Netlify hosting**: free for personal projects.
- **AdSense**: free; pays you per impression / click.

---

Questions, or want me to add specific ad placements / a privacy policy page / passwordless email sign-in instead of Google? Just ask.

---

## Extension: testing against a local build

The shipped `extension/manifest.json` is the Chrome Web Store build, so its
`sync-bridge.js` content script only matches the public origins:

```
"matches": ["https://gmsim.ca/*", "https://www.gmsim.ca/*", "https://jaygauvin2002.github.io/gomining-preview/*"]
```

`file:///*` and `http://localhost:*/*` are deliberately absent — `file://`
access triggers a manual Chrome Web Store review that is hard to justify for a
public extension, and localhost has no reason to ship to end users.

To sync against a local copy of the simulator while developing, add them back
to that one `matches` array in your **unpacked** copy:

```
"matches": ["https://gmsim.ca/*", "https://www.gmsim.ca/*", "https://jaygauvin2002.github.io/gomining-preview/*", "http://localhost:*/*", "file:///*"]
```

Reload the extension at `chrome://extensions/`, and for `file://` also enable
"Allow access to file URLs" on its details page. **Revert this before building
the zip you upload to the store.**

After any change to `extractor.js` or `inject-early.js`, reload the extension
*and* hard-reload the `app.gomining.com` tab — content scripts do not hot-swap
into already-open pages.

### Rebuilding extension.zip

```
./extension/build-zip.sh
```

Do not zip by hand. The manifest in this repo deliberately carries a
`(DEV)` suffix in its name, so the copy you load unpacked is
distinguishable from the store build in `chrome://extensions` and in the
panel injected on GoMining. The script strips that suffix for the
published package and refuses to write the zip if any trace of `DEV`
survives — which is why there is nothing to remember to undo before an
upload.

`node extension/tests/routing.test.mjs` also fails if the zip carries a
`DEV` name, or if its version has drifted from the manifest.

Keep the zip in sync whenever anything under `extension/` changes —
`gmsim.ca` still serves this file directly as a fallback download.

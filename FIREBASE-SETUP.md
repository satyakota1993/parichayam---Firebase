# Parichayam Firebase Setup

1. Copy `.firebaserc.example` to `.firebaserc` and replace the project id.
2. Open `parichayam-firebase-config.js` and paste your Firebase web app config.
3. In Firestore, create your first admin user by:
   - signing up once from `auth.html`
   - opening the `members` collection in the Firebase console
   - changing that member document's `role` to `ADMIN`
4. Deploy rules first:
   - `firebase deploy --only firestore:rules,storage`
5. Deploy hosting:
   - `firebase deploy --only hosting`

Current Firebase-first data layout:
- `members/{uid}`: member profile, trial dates, plan, role, jathakam fields
- `memberPhoneIndex/{phone}`: phone-to-email lookup for mobile login
- `appState/{key}`: admin-managed public settings and pricing caches
- `agentApplications/{id}`: reserved for agent workflow migration

Firebase details I still need from you:
- `apiKey`
- `authDomain`
- `projectId`
- `storageBucket`
- `messagingSenderId`
- `appId`

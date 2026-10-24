# Team Serious Face

A shared weekly schedule for our WoW group, with Mythic+ info from Raider.io for each character.
It's a static site on GitHub Pages, and the data is stored in Firebase Firestore.

## Features
- Weekly grid from 10:00 to 02:00. Pick your character, then click or drag over the hours you can play.
- Updates live for everyone. Hours where everyone is free turn green, and "Best times" lists the longest windows.
- Roster cards from Raider.io: spec, item level, M+ score, this week's runs and best runs.
- Each player can enter the keystone they hold right now (Raider.io doesn't have that data).
- "Copy my last week" for people with a regular schedule.

## Setup

### 1. Firebase (about 5 minutes)
1. Go to <https://console.firebase.google.com>, then **Add project** (Google Analytics is not needed).
2. **Build → Firestore Database → Create database**, pick a location close to you (e.g. `europe-north1`), and start in **production mode**.
3. **Build → Authentication → Get started → Sign-in method → Google → Enable**.
4. Copy `firestore.rules.example` to `firestore.rules`, which is gitignored so the emails stay private, and put the group's Google addresses in `members()`, written in lowercase.
   Then, on Firestore's **Rules** tab, paste in the whole file and click **Publish**.
5. **Project settings (gear icon) → Your apps → Web (`</>`)**, register an app (Hosting is not needed), and copy the `firebaseConfig` object into `firebase-config.js`.
6. After you deploy: **Authentication → Settings → Authorized domains → Add domain** `<user>.github.io`. (`localhost` is allowed by default.)

The config values are not secret and can be committed. Access is controlled by the rules.

### 2. Run locally
ES modules need a real web server, so opening `index.html` as a file won't work:
```bash
npx serve .
```

### 3. GitHub Pages
1. Create a repo and push these files.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` / `/ (root)`.
3. Share `https://<user>.github.io/<repo>/` with the group.

## Notes
- Access: you sign in with Google, and only the emails in the published rules can read or write. Firestore enforces this on the server, so changing the page's code doesn't get around it.
  Each person can only change their own characters, hours and key. To add someone, edit the list and publish the rules again.
- Times are saved as each viewer's local hours, so everyone should be in the same time zone.
- Data model: `players/{id}` = `{name, realm, region, keyDungeon, keyLevel, ownerUid}`, and `availability/{week}_{playerId}` = `{week, playerId, slots: ["dayIndex-hour"]}`.

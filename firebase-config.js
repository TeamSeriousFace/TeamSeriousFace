// Paste the config from Firebase console → Project settings → Your apps → Web app.
// These values are not secrets; access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyDzK0PvqLDupZbHpWuMxsg_3prPToLwJ5U",
  authDomain: "teamseriousface.github.io", // sign-in helpers are self-hosted in /__/auth
  projectId: "teamseriousface",
  storageBucket: "teamseriousface.firebasestorage.app",
  messagingSenderId: "135554021034",
  appId: "1:135554021034:web:1b728598cee142576c02d3",
};

// Warcraft Logs API client ID (a "public client" using the PKCE login, so there's no secret).
// Create it at https://www.warcraftlogs.com/api/clients/ — the team runs section stays hidden until it's set.
export const warcraftLogsClientId = "01a17343-0d0b-729d-b34a-5897d5def463";

// Default region for new characters: "eu", "us", "kr", "tw".
export const defaultRegion = "eu";

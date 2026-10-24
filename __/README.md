Firebase sign-in helper pages, self-hosted so Google sign-in happens on
teamseriousface.github.io instead of teamseriousface.firebaseapp.com. That avoids the
"missing initial state" error in browsers that block cross-site storage
(Safari, in-app browsers, Firefox/Brave strict mode).

Downloaded from https://teamseriousface.firebaseapp.com/__/auth/{handler,handler.js,experiments.js,iframe,iframe.js}
(handler and iframe saved as .html so GitHub Pages serves them at /__/auth/handler and /__/auth/iframe).
Re-download them if sign-in breaks after a Firebase update.
See https://firebase.google.com/docs/auth/web/redirect-best-practices (option 3).

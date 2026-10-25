import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, query, where,
  addDoc, setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { firebaseConfig, defaultRegion } from "./firebase-config.js";
import * as wcl from "./wcl.js";

// Schedule shows 10:00 to 02:00. Hours 24/25 mean 00:00/01:00 after that day.
const FIRST_HOUR = 10;
const LAST_HOUR = 25;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PLAYER_COLORS = ["#f5b942", "#4fb3ff", "#ff6b9a", "#7ee081", "#b48cff", "#ff8a4c", "#4de0d0", "#e0e04d"];
const CLASS_COLORS = {
  "Death Knight": "#C41E3A", "Demon Hunter": "#A330C9", Druid: "#FF7C0A", Evoker: "#33937F",
  Hunter: "#AAD372", Mage: "#3FC7EB", Monk: "#00FF98", Paladin: "#F48CBA", Priest: "#FFFFFF",
  Rogue: "#FFF468", Shaman: "#0070DD", Warlock: "#8788EE", Warrior: "#C69B6D",
};
// The team, shown on the login page. Public: anyone with the link sees these names
// (they're public on Raider.io and the Armory anyway).
// Shown tank, healer, then DPS; within a role in this order (left to right as in the team picture).
const TEAM = [
  { name: "Magabronkel", realm: "kazzak", region: "eu" },
  { name: "Drottdk", realm: "twisting-nether", region: "eu" },
  { name: "Derrep", realm: "twisting-nether", region: "eu" },
  { name: "Axioow", realm: "kazzak", region: "eu" },
  { name: "Yogurtdip", realm: "tarren-mill", region: "eu" },
];

// Warcraft Logs: only runs with at least this many roster characters are imported.
const MIN_TEAM_IN_RUN = 2;
// A connected member's browser looks for new logs when the last check is older than this.
const LOGS_AUTO_REFRESH_MINUTES = 5;

const RIO_FIELDS = [
  "mythic_plus_scores_by_season:current",
  "mythic_plus_weekly_highest_level_runs",
  "mythic_plus_best_runs",
  "gear",
].join(",");

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  user: null,           // firebase auth user
  players: [],          // [{id, name, realm, region, keyDungeon, keyLevel, keyUpdatedAt, ownerUid}]
  availability: {},     // playerId -> Set("d-h") for the shown week
  busy: {},             // playerId -> Set(dayIndex) the player can't play in the shown week
  lates: [],            // [{id, playerId, minutes, note, at, reportedBy, reportedByName, excuse?}]
  rio: {},              // playerId -> raider.io profile | {error}
  dungeons: [],         // current season dungeons from raider.io
  runs: [],             // imported Warcraft Logs runs, newest first
  discordWebhook: "",   // where new runs are announced (config/discord), "" = off
  // day: selected day tab in the shown week (null = today, or the latest day with runs)
  logs: { meta: null, metaLoaded: false, busy: false, status: "", notice: "", error: "", open: null, day: null, lastAttempt: 0 },
  me: localStorage.getItem("me") || "",
  weekStart: mondayOf(new Date()),
  unsubAvailability: null,
};

if (firebaseConfig.projectId === "PASTE_ME") {
  $("#setup-warning").hidden = false;
  throw new Error("Firebase not configured");
}

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

// ---------- dates ----------

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function weekKey(monday) {
  const p = (n) => String(n).padStart(2, "0");
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

const fmtHour = (h) => `${String(h % 24).padStart(2, "0")}:00`;

// ---------- firestore subscriptions ----------

// ---------- auth ----------

const isMine = (p) => p?.ownerUid === state.user?.uid;
const myPlayers = () => state.players.filter(isMine);

function showSignin(message) {
  $("#signin").hidden = false;
  document.body.classList.add("signed-out");
  $("#app").hidden = true;
  $("#who").hidden = true;
  $("#signin-error").textContent = message ?? "";
  $("#signin-error").hidden = !message;
}

// Only used for the roster: if we can't read players, this account isn't a member.
function onDenied(err) {
  if (err.code !== "permission-denied") return console.error(err);
  if (!$("#signin").hidden) return;
  const email = state.user?.email;
  signOut(auth);
  showSignin(`${email} is not on the group's allowlist. Ask the admin to add you.`);
}

// Login page: the team with portrait, role and class colour, fetched live from Raider.io.
async function renderTeam() {
  const profiles = await Promise.all(TEAM.map((c) =>
    fetch(`https://raider.io/api/v1/characters/profile?region=${c.region}`
      + `&realm=${encodeURIComponent(c.realm)}&name=${encodeURIComponent(c.name)}`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)));
  // Tank first, then healer, then DPS; within a role, TEAM order is kept.
  const roleOrder = { TANK: 0, HEALING: 1, DPS: 2 };
  const found = profiles.filter(Boolean)
    .sort((a, b) => (roleOrder[a.active_spec_role] ?? 3) - (roleOrder[b.active_spec_role] ?? 3));
  if (!found.length) return;
  $("#team").innerHTML = found.map((c) => {
    const role = ROLES[c.active_spec_role];
    return `<a class="member" href="${esc(c.profile_url)}" target="_blank" rel="noopener"
        title="${esc(`${c.active_spec_name} ${c.class}`)}">
      <img src="${esc(c.thumbnail_url)}" alt="">
      <span class="mname" style="color:${CLASS_COLORS[c.class] ?? "var(--text)"}">${esc(c.name)}</span>
      ${role ? `<span class="role ${role.cls ?? ""}">${role.icon}</span>` : ""}
    </a>`;
  }).join("");
  $("#team").hidden = false;
}
renderTeam();

$("#sign-in").addEventListener("click", () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => showSignin(e.message)));
$("#sign-out").addEventListener("click", () => signOut(auth));

let unsubPlayers = null;
let unsubLates = null;
let unsubRuns = null;
let unsubLogsMeta = null;
let unsubDiscord = null;

onAuthStateChanged(auth, (user) => {
  state.user = user;
  unsubPlayers?.();
  unsubLates?.();
  unsubRuns?.();
  unsubLogsMeta?.();
  unsubDiscord?.();
  state.unsubAvailability?.();
  unsubPlayers = unsubLates = unsubRuns = unsubLogsMeta = unsubDiscord = state.unsubAvailability = null;
  if (!user) {
    if ($("#signin-error").hidden) showSignin();
    return;
  }
  $("#signin").hidden = true;
  document.body.classList.remove("signed-out");
  $("#app").hidden = false;
  $("#who").hidden = false;
  unsubPlayers = onSnapshot(collection(db, "players"), onPlayers, onDenied);
  unsubLates = onSnapshot(collection(db, "lates"), (snap) => {
    state.lates = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.at?.seconds ?? Infinity) - (a.at?.seconds ?? Infinity));
    renderRoster();
    renderShame();
  }, (err) => {
    // Not being able to read lates shouldn't lock anyone out (e.g. rules not published yet).
    console.error("Could not load late reports:", err);
    $("#shame").innerHTML = `<h3>Hall of Shame</h3><p class="error">Couldn't load late reports. Are the latest Firestore rules published?</p>`;
  });
  unsubRuns = onSnapshot(collection(db, "runs"), (snap) => {
    state.runs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.startedAt - a.startedAt);
    renderLogs();
  }, (err) => {
    console.error("Could not load runs:", err);
    state.logs.error = "Couldn't load team runs. Are the latest Firestore rules published?";
    renderLogs();
  });
  unsubLogsMeta = onSnapshot(doc(db, "meta", "logs"), (snap) => {
    state.logs.meta = snap.exists() ? snap.data() : null;
    state.logs.metaLoaded = true;
    renderLogs();
    maybeAutoRefreshLogs();
  }, (err) => console.error("Could not load logs status:", err));
  // Discord webhook for run announcements. Members-only data, never in the code or the repo.
  unsubDiscord = onSnapshot(doc(db, "config", "discord"), (snap) => {
    state.discordWebhook = snap.exists() ? snap.data().webhookUrl : "";
    renderLogs();
  }, (err) => console.error("Could not load Discord settings:", err));
  subscribeWeek();
  loadDungeons();
});

function onPlayers(snap) {
  state.players = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  if (!isMine(state.players.find((p) => p.id === state.me))) state.me = myPlayers()[0]?.id ?? "";
  for (const p of state.players) if (!state.rio[p.id]) loadRio(p);
  renderMeSelect();
  renderGrid();
  renderRoster();
  renderShame();
  maybeAutoRefreshLogs();
}

function subscribeWeek() {
  state.unsubAvailability?.();
  state.availability = {};
  state.busy = {};
  const q = query(collection(db, "availability"), where("week", "==", weekKey(state.weekStart)));
  state.unsubAvailability = onSnapshot(q, (snap) => {
    // Don't overwrite my own cells while I'm dragging.
    const mine = drag.active ? [state.availability[state.me], state.busy[state.me]] : null;
    state.availability = {};
    state.busy = {};
    for (const d of snap.docs) {
      const data = d.data();
      state.availability[data.playerId] = new Set(data.slots);
      state.busy[data.playerId] = new Set(data.busyDays ?? []);
    }
    if (mine) [state.availability[state.me], state.busy[state.me]] = mine;
    renderGrid();
    renderRoster();
  }, (err) => console.error("Could not load schedule:", err));
  renderWeekLabel();
  state.logs.day = null; // team runs follow the shown week
  state.logs.open = null;
  renderLogs();
}

function saveMyWeek() {
  if (!state.me) return;
  const week = weekKey(state.weekStart);
  const slots = [...(state.availability[state.me] ?? [])];
  const busyDays = [...(state.busy[state.me] ?? [])].sort();
  return setDoc(doc(db, "availability", `${week}_${state.me}`), { week, playerId: state.me, slots, busyDays });
}

// ---------- raider.io ----------

const slug = (s) => s.trim().toLowerCase().replace(/'/g, "").replace(/\s+/g, "-");

async function fetchRio(p) {
  const url = `https://raider.io/api/v1/characters/profile?region=${encodeURIComponent(p.region)}`
    + `&realm=${encodeURIComponent(slug(p.realm))}&name=${encodeURIComponent(p.name)}&fields=${RIO_FIELDS}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || `Raider.io error ${res.status}`);
  return body;
}

async function loadRio(p) {
  state.rio[p.id] = { loading: true };
  try {
    state.rio[p.id] = await fetchRio(p);
  } catch (e) {
    state.rio[p.id] = { error: e.message };
  }
  renderRoster();
  if (!drag.active) renderGrid(); // portraits and roles in the schedule come from raider.io
}

async function loadDungeons() {
  try {
    const res = await fetch("https://raider.io/api/v1/mythic-plus/static-data?expansion_id=11");
    const { seasons } = await res.json();
    const now = Date.now();
    const current = seasons
      .filter((s) => s.is_main_season && new Date(s.starts?.eu ?? 0).getTime() <= now)
      .sort((a, b) => new Date(b.starts.eu) - new Date(a.starts.eu))[0];
    state.dungeons = (current?.dungeons ?? [])
      .map((d) => ({ name: d.name, short: d.short_name, icon: d.icon_url, timer: d.keystone_timer_seconds }))
      .sort((a, b) => a.name.localeCompare(b.name));
    renderRoster();
    renderLogs();
  } catch {
    // Key dropdown falls back to free text if this fails.
  }
}

// ---------- me ----------

function setMe(id) {
  state.me = id;
  localStorage.setItem("me", id);
  renderMeSelect();
  renderGrid();
  renderRoster();
}

function renderMeSelect() {
  const mine = myPlayers();
  $("#me").innerHTML = mine.length
    ? mine.map((p) => `<option value="${p.id}" ${p.id === state.me ? "selected" : ""}>${esc(p.name)}</option>`).join("")
    : `<option value="">No character yet</option>`;
}

$("#me").addEventListener("change", (e) => setMe(e.target.value));

// ---------- schedule grid ----------

const colorOf = (playerId) => PLAYER_COLORS[Math.max(0, state.players.findIndex((p) => p.id === playerId)) % PLAYER_COLORS.length];

function playersAt(key) {
  return state.players.filter((p) => state.availability[p.id]?.has(key));
}

const ROLES = {
  TANK: { icon: "🛡️", label: "Tank" },
  HEALING: { icon: "✚", label: "Healer", cls: "heal" },
  DPS: { icon: "⚔️", label: "DPS" },
};

function playerChip(p) {
  const r = state.rio[p.id] ?? {};
  const role = ROLES[r.active_spec_role];
  const img = r.thumbnail_url
    ? `<img src="${esc(r.thumbnail_url)}" alt="" draggable="false">`
    : `<span class="noimg"></span>`;
  return `<span class="chip" style="--player:${colorOf(p.id)}">
    ${img}
    ${role ? `<span class="role ${role.cls ?? ""}" title="${role.label}">${role.icon}</span>` : ""}
    <span class="pname" style="color:${CLASS_COLORS[r.class] ?? "var(--text)"}">${esc(p.name)}</span>
  </span>`;
}

function renderWeekLabel() {
  const end = addDays(state.weekStart, 6);
  const f = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  $("#week-label").textContent = `${f(state.weekStart)} – ${f(end)}`;
}

function renderGrid() {
  const todayIdx = weekKey(mondayOf(new Date())) === weekKey(state.weekStart) ? (new Date().getDay() + 6) % 7 : -1;
  let html = `<div></div>`;
  DAYS.forEach((d, i) => {
    const away = state.players.filter((p) => state.busy[p.id]?.has(i));
    const awayList = away.length
      ? `<div class="away" title="Can't play: ${esc(away.map((p) => p.name).join(", "))}">${away.map(awayBadge).join("")}</div>`
      : "";
    html += `<div class="head ${i === todayIdx ? "today" : ""}"><div><span>${d}</span> <span>${addDays(state.weekStart, i).getDate()}</span></div>${awayList}</div>`;
  });
  const total = state.players.length;
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    html += `<div class="hour">${fmtHour(h)}</div>`;
    for (let d = 0; d < 7; d++) {
      const key = `${d}-${h}`;
      const here = playersAt(key);
      const mine = state.me && state.availability[state.me]?.has(key);
      const all = total > 0 && here.length === total;
      const names = here.map((p) => p.name).join(", ") || "Nobody";
      html += `<div class="cell ${mine ? "mine" : ""} ${all ? "all" : ""}" data-key="${key}" title="${DAYS[d]} ${fmtHour(h)}: ${esc(names)}">`
        + here.map(playerChip).join("")
        + `</div>`;
    }
  }
  $("#grid").innerHTML = html;
  renderBusyRow();
  renderBest();
}

function awayBadge(p) {
  const img = state.rio[p.id]?.thumbnail_url;
  return `<span class="away-badge" style="--player:${colorOf(p.id)}">`
    + (img ? `<img src="${esc(img)}" alt="" draggable="false">` : `<span class="noimg"></span>`)
    + `</span>`;
}

// "Can't play" toggles for my character, one per day plus the whole week.
function renderBusyRow() {
  if (!state.me) { $("#busy-row").innerHTML = ""; return; }
  const busy = state.busy[state.me] ?? new Set();
  $("#busy-row").innerHTML = `<span class="label">Can't play:</span>`
    + DAYS.map((d, i) => `<button class="secondary ${busy.has(i) ? "on" : ""}" data-busy-day="${i}">${d}</button>`).join("")
    + `<button class="secondary whole ${busy.size === 7 ? "on" : ""}" data-busy-day="all">Whole week</button>`;
}

$("#busy-row").addEventListener("click", async (e) => {
  const day = e.target.dataset.busyDay;
  if (day === undefined || !state.me) return;
  const busy = (state.busy[state.me] ??= new Set());
  const slots = (state.availability[state.me] ??= new Set());
  const days = day === "all" ? [0, 1, 2, 3, 4, 5, 6] : [Number(day)];
  const turnOn = day === "all" ? busy.size < 7 : !busy.has(Number(day));
  if (turnOn && days.some((d) => [...slots].some((k) => k.startsWith(`${d}-`)))
      && !confirm("This removes the hours you've marked on those days. Continue?")) return;
  for (const d of days) {
    if (turnOn) {
      busy.add(d);
      for (const k of [...slots]) if (k.startsWith(`${d}-`)) slots.delete(k);
    } else {
      busy.delete(d);
    }
  }
  renderGrid();
  renderRoster();
  await saveMyWeek();
});

// Lists time windows where at least (all - 1) players are free, longest first.
function renderBest() {
  const total = state.players.length;
  if (total < 2) { $("#best").innerHTML = ""; return; }
  const windows = [];
  for (const need of [total, total - 1]) {
    for (let d = 0; d < 7; d++) {
      let start = null;
      for (let h = FIRST_HOUR; h <= LAST_HOUR + 1; h++) {
        const ok = h <= LAST_HOUR && playersAt(`${d}-${h}`).length >= need;
        if (ok && start === null) start = h;
        if (!ok && start !== null) {
          if (h - start >= 2) windows.push({ d, start, end: h, need });
          start = null;
        }
      }
    }
    if (need === total && windows.length) break;
  }
  if (!windows.length) {
    $("#best").innerHTML = `<h3>Best times</h3><p class="muted">No 2+ hour window with ${total - 1}+ players yet.</p>`;
    return;
  }
  windows.sort((a, b) => b.need - a.need || (b.end - b.start) - (a.end - a.start) || a.d - b.d);
  $("#best").innerHTML = `<h3>Best times</h3><ul>` + windows.slice(0, 6).map((w) => {
    const missing = w.need < total
      ? ` <span class="muted">(${total - w.need} missing)</span>` : ` <span class="muted">(everyone)</span>`;
    return `<li><b>${DAYS[w.d]}</b> ${fmtHour(w.start)}–${fmtHour(w.end)}${missing}</li>`;
  }).join("") + `</ul>`;
}

// Click or drag to paint. The first cell decides whether we add or remove.
const drag = { active: false, adding: true };

function paint(cell) {
  const key = cell?.dataset?.key;
  if (!key) return;
  const set = (state.availability[state.me] ??= new Set());
  if (drag.adding) {
    set.add(key);
    state.busy[state.me]?.delete(Number(key.split("-")[0])); // marking hours means I can play that day
  } else {
    set.delete(key);
  }
  cell.classList.toggle("mine", drag.adding);
}

// Touch: tap toggles one hour and the browser keeps scrolling and pinch-zoom.
// The click only fires if the finger didn't scroll, so swipes never paint.
let lastPointerType = "mouse";

$("#grid").addEventListener("click", async (e) => {
  if (lastPointerType !== "touch") return;
  const cell = e.target.closest(".cell");
  if (!cell) return;
  if (!state.me) { alert("Add your character in the roster first."); return; }
  drag.adding = !state.availability[state.me]?.has(cell.dataset.key);
  paint(cell);
  renderGrid();
  await saveMyWeek();
});

$("#grid").addEventListener("pointerdown", (e) => {
  lastPointerType = e.pointerType;
  if (e.pointerType === "touch") return;
  const cell = e.target.closest(".cell");
  if (!cell) return;
  if (!state.me) { alert("Add your character in the roster first."); return; }
  drag.active = true;
  drag.adding = !state.availability[state.me]?.has(cell.dataset.key);
  paint(cell);
});

$("#grid").addEventListener("pointermove", (e) => {
  if (!drag.active) return;
  paint(document.elementFromPoint(e.clientX, e.clientY)?.closest(".cell"));
});

window.addEventListener("pointerup", async () => {
  if (!drag.active) return;
  await saveMyWeek();
  drag.active = false;
  renderGrid();
});

$("#prev-week").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, -7); subscribeWeek(); });
$("#next-week").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, 7); subscribeWeek(); });

$("#copy-week").addEventListener("click", async () => {
  if (!state.me) return alert("Add your character in the roster first.");
  const prev = await getDoc(doc(db, "availability", `${weekKey(addDays(state.weekStart, -7))}_${state.me}`));
  if (!prev.exists()) return alert("You have nothing saved last week.");
  state.availability[state.me] = new Set(prev.data().slots);
  state.busy[state.me] = new Set(prev.data().busyDays ?? []);
  await saveMyWeek();
});

$("#clear-week").addEventListener("click", async () => {
  if (!state.me || !confirm("Clear all your hours and \"can't play\" days this week?")) return;
  state.availability[state.me] = new Set();
  state.busy[state.me] = new Set();
  await saveMyWeek();
});

// ---------- roster ----------

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function runChip(r) {
  const timed = r.clear_time_ms <= r.par_time_ms;
  const plus = timed ? "+".repeat(Math.max(1, r.num_keystone_upgrades)) : "";
  return `<span class="run ${timed ? "timed" : ""}" title="${esc(r.dungeon)} – ${fmtTime(r.clear_time_ms)} / ${fmtTime(r.par_time_ms)}${timed ? "" : " (over time)"}">${esc(r.short_name)} ${plus ? `<b class="plus">${plus}</b>` : ""}${r.mythic_level}</span>`;
}

function keyEditor(p) {
  if (p.id !== state.me) {
    return p.keyLevel
      ? `<div class="key ${isStaleKey(p) ? "muted" : ""}">🔑 <b>${esc(p.keyDungeon || "?")} +${esc(p.keyLevel)}</b>${isStaleKey(p) ? " <i>(last week?)</i>" : ""}</div>`
      : `<div class="key muted">🔑 No key set</div>`;
  }
  const options = state.dungeons.length
    ? `<select data-field="keyDungeon"><option value="">Dungeon…</option>${state.dungeons.map((d) =>
        `<option ${d.name === p.keyDungeon ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select>`
    : `<input data-field="keyDungeon" placeholder="Dungeon" value="${esc(p.keyDungeon)}" style="width:120px">`;
  return `<div class="key"><span class="nowrap">🔑 My key:</span> ${options}
    <input data-field="keyLevel" type="number" min="2" max="40" placeholder="+lvl" value="${esc(p.keyLevel)}"></div>`;
}

// Weekly reset: EU Wednesday 04:00 UTC, US Tuesday 15:00 UTC, KR/TW Wednesday 23:00 UTC.
const RESETS = { eu: [3, 4], us: [2, 15], kr: [3, 23], tw: [3, 23] };

function lastReset(region) {
  const [day, hour] = RESETS[region] ?? RESETS.eu;
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - day + 7) % 7));
  if (d > new Date()) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

// A key entered before this week's reset is probably gone or changed.
const isStaleKey = (p) => !!p.keyUpdatedAt && p.keyUpdatedAt.seconds * 1000 < lastReset(p.region).getTime();

function renderKeys() {
  const withKey = state.players.filter((p) => p.keyLevel);
  const without = state.players.filter((p) => !p.keyLevel);
  if (!state.players.length) { $("#keys").innerHTML = ""; return; }
  const sorted = [...withKey].sort((a, b) =>
    isStaleKey(a) - isStaleKey(b) || b.keyLevel - a.keyLevel || (a.keyDungeon ?? "").localeCompare(b.keyDungeon ?? ""));
  const dungeon = (name) => state.dungeons.find((d) => d.name === name);
  $("#keys").innerHTML = `<h3>🔑 Keys <span class="muted">(${withKey.length}/${state.players.length})</span></h3>`
    + (sorted.length ? `<ul>${sorted.map((p) => {
      const d = dungeon(p.keyDungeon);
      const r = state.rio[p.id] ?? {};
      const stale = isStaleKey(p);
      return `<li class="${stale ? "stale" : ""}" title="${stale ? "Entered before this week's reset, may be out of date" : ""}">
        ${d?.icon ? `<img class="dicon" src="${esc(d.icon)}" alt="">` : `<span class="dicon"></span>`}
        <b class="lvl">+${esc(p.keyLevel)}</b>
        <span class="dname">${esc(p.keyDungeon || "Unknown dungeon")}</span>
        ${stale ? `<span class="stale-tag">last week?</span>` : ""}
        <span class="holder">
          ${r.thumbnail_url ? `<img src="${esc(r.thumbnail_url)}" alt="">` : ""}
          <span style="color:${CLASS_COLORS[r.class] ?? "var(--text)"}">${esc(p.name)}</span>
        </span>
      </li>`;
    }).join("")}</ul>` : `<p class="muted">Nobody has entered a key yet.</p>`)
    + (without.length && withKey.length ? `<p class="muted small">No key set: ${without.map((p) => esc(p.name)).join(", ")}</p>` : "");
}

function renderRoster() {
  $(".roster").classList.toggle("needs-char", !myPlayers().length);
  renderKeys();
  if (!state.players.length) {
    $("#cards").innerHTML = `<p class="muted">No characters yet.</p>`;
    return;
  }
  $("#cards").innerHTML = state.players.map((p) => {
    const r = state.rio[p.id] ?? {};
    const color = CLASS_COLORS[r.class] ?? "var(--border)";
    const legend = `<span class="legend" style="background:${colorOf(p.id)}" title="Colour in the schedule"></span>`;
    let body;
    if (r.loading) {
      body = `<div class="card-top">${legend}<span class="name">${esc(p.name)}</span><span class="sub">Loading…</span></div>`;
    } else if (r.error) {
      body = `<div class="card-top">${legend}<span class="name">${esc(p.name)}</span>
        <span class="sub">${esc(p.realm)} · ${esc(r.error)}</span></div>`;
    } else {
      const season = r.mythic_plus_scores_by_season?.[0]?.segments?.all ?? { score: 0, color: "#fff" };
      const weekly = r.mythic_plus_weekly_highest_level_runs ?? [];
      const best = r.mythic_plus_best_runs ?? [];
      body = `
        <div class="card-top">
          <img src="${esc(r.thumbnail_url)}" alt="">
          <div>
            <a class="name" href="${esc(r.profile_url)}" target="_blank" rel="noopener">${esc(r.name)}</a>
            <div class="sub" title="${esc(r.realm)}">${legend}${esc(r.active_spec_name)} ${esc(r.class)}</div>
          </div>
          <div class="score"><b style="color:${season.color}">${Math.round(season.score)}</b><div class="sub">M+ score</div></div>
        </div>
        <div class="stats">
          <span>iLvl <b>${r.gear?.item_level_equipped?.toFixed(1) ?? "?"}</b></span>
          <span>This week <b>${weekly.length}</b> runs${weekly[0] ? `, best <b>+${weekly[0].mythic_level}</b>` : ""}</span>
        </div>
        ${best.length ? `<div class="runs">${best.slice(0, 8).map(runChip).join("")}</div>` : ""}`;
    }
    return `<div class="card ${p.id === state.me ? "me" : ""} ${r.faction === "horde" || r.faction === "alliance" ? `faction-${r.faction}` : ""}" style="--class-color:${color}" data-id="${p.id}">
      ${body}
      ${weekLine(p)}
      ${keyEditor(p)}
      ${lateLine(p)}
      ${isMine(p) ? `<div class="key"><button class="secondary remove" data-remove="${p.id}">Remove</button></div>` : ""}
    </div>`;
  }).join("");
}

$("#cards").addEventListener("change", (e) => {
  const field = e.target.dataset.field;
  if (!field || !state.me) return;
  const value = field === "keyLevel" ? (e.target.value ? Number(e.target.value) : null) : e.target.value;
  updateDoc(doc(db, "players", state.me), { [field]: value, keyUpdatedAt: serverTimestamp() });
});

$("#cards").addEventListener("click", async (e) => {
  if (e.target.dataset.late) return openLateDialog(e.target.dataset.late);
  const id = e.target.dataset.remove;
  if (!id) return;
  const p = state.players.find((x) => x.id === id);
  if (confirm(`Remove ${p?.name} from the roster?`)) await deleteDoc(doc(db, "players", id));
});

// ---------- late tracker ----------

const latesFor = (playerId) => state.lates.filter((l) => l.playerId === playerId);

// Has this player filled in the shown week? Tells "can't play" apart from "forgot".
function weekLine(p) {
  const when = weekKey(state.weekStart) === weekKey(mondayOf(new Date())) ? "this week" : "that week";
  const hours = state.availability[p.id]?.size ?? 0;
  const busy = [...(state.busy[p.id] ?? [])].sort().map((d) => DAYS[d]);
  let text;
  let cls = "";
  if (busy.length === 7) {
    [text, cls] = [`🚫 Not available ${when}`, "away"];
  } else if (hours) {
    text = `📅 ${hours} h marked ${when}` + (busy.length ? ` · can't play ${busy.join(", ")}` : "");
    cls = "ok";
  } else if (busy.length) {
    [text, cls] = [`🚫 Can't play ${busy.join(", ")} · no hours marked`, "away"];
  } else {
    [text, cls] = [`⏳ Hasn't updated ${when} yet`, "pending"];
  }
  return `<div class="week-line ${cls}">${text}</div>`;
}

function lateLine(p) {
  const lates = latesFor(p.id);
  const total = lates.reduce((sum, l) => sum + l.minutes, 0);
  const summary = lates.length
    ? `Late <b>${lates.length}×</b> · ${total} min total`
    : "Never late (so far)";
  return `<div class="late-line">⏰ ${summary}
    <button class="secondary late-btn" data-late="${p.id}">Late!</button></div>`;
}

function renderShame() {
  const known = new Map(state.players.map((p) => [p.id, p]));
  const lates = state.lates.filter((l) => known.has(l.playerId));
  if (!lates.length) {
    $("#shame").innerHTML = `<h3>Hall of Shame</h3><p class="muted">Nobody has been late yet. Suspicious.</p>`;
    return;
  }
  const board = state.players
    .map((p) => {
      const mine = latesFor(p.id);
      return { p, count: mine.length, minutes: mine.reduce((s, l) => s + l.minutes, 0) };
    })
    .filter((r) => r.count)
    .sort((a, b) => b.count - a.count || b.minutes - a.minutes);
  const medals = ["🥇", "🥈", "🥉"];
  // Latest 8, plus any older ones about my characters that still lack an excuse.
  const recent = lates.filter((l, i) => i < 8 || (isMine(known.get(l.playerId)) && !l.excuse));
  const fmtDate = (ts) => ts ? new Date(ts.seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "just now";

  $("#shame").innerHTML = `<h3>Hall of Shame</h3>
    <table>
      <tr><th></th><th>Character</th><th>Times late</th><th>Total minutes</th></tr>
      ${board.map((r, i) => `<tr>
        <td>${medals[i] ?? ""}</td>
        <td><b style="color:${colorOf(r.p.id)}">${esc(r.p.name)}</b></td>
        <td class="num">${r.count}</td>
        <td class="num">${r.minutes}</td></tr>`).join("")}
    </table>
    <ul class="recent">
      ${recent.map((l) => {
        const accused = isMine(known.get(l.playerId));
        return `<li>
          <div class="row">
            <span class="muted">${fmtDate(l.at)}</span>
            <b>${esc(known.get(l.playerId).name)}</b> +${l.minutes} min
            ${l.note ? `<span class="note">“${esc(l.note)}”</span>` : ""}
            <span class="muted">· reported by ${esc(l.reportedByName)}</span>
            <span class="actions">
              ${accused ? `<button class="secondary" data-excuse="${l.id}">${l.excuse ? "Edit excuse" : "Add excuse"}</button>` : ""}
              ${l.reportedBy === state.user?.uid ? `<button class="secondary" data-del-late="${l.id}" title="Delete report">×</button>` : ""}
            </span>
          </div>
          ${l.excuse ? `<p class="excuse"><b>Excuse:</b> ${esc(l.excuse)}</p>` : ""}
        </li>`;
      }).join("")}
    </ul>`;
}

$("#shame").addEventListener("click", (e) => {
  if (e.target.dataset.excuse) return openExcuseDialog(e.target.dataset.excuse);
  const id = e.target.dataset.delLate;
  if (id && confirm("Delete this late report?")) deleteDoc(doc(db, "lates", id));
});

let excuseLateId = null;

function openExcuseDialog(lateId) {
  const l = state.lates.find((x) => x.id === lateId);
  if (!l) return;
  excuseLateId = lateId;
  $("#excuse-context").textContent = `+${l.minutes} min, reported by ${l.reportedByName}${l.note ? `: “${l.note}”` : ""}`;
  $("#excuse-form").excuse.value = l.excuse ?? "";
  $("#excuse-dialog").showModal();
}

$("#excuse-cancel").addEventListener("click", () => $("#excuse-dialog").close());

$("#excuse-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await updateDoc(doc(db, "lates", excuseLateId), { excuse: e.target.excuse.value.trim() });
  $("#excuse-dialog").close();
});

let latePlayerId = null;

function openLateDialog(playerId) {
  latePlayerId = playerId;
  $("#late-name").textContent = state.players.find((p) => p.id === playerId)?.name ?? "";
  $("#late-form").reset();
  $("#late-dialog").showModal();
}

$("#late-cancel").addEventListener("click", () => $("#late-dialog").close());

$("#late-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  // Reporter is shown by their own character name, falling back to their Google first name.
  const reporter = myPlayers()[0]?.name ?? state.user.displayName?.split(" ")[0] ?? "someone";
  await addDoc(collection(db, "lates"), {
    playerId: latePlayerId,
    minutes: Number(form.minutes.value),
    note: form.note.value.trim(),
    at: serverTimestamp(),
    reportedBy: state.user.uid,
    reportedByName: reporter,
  });
  $("#late-dialog").close();
});

$("#refresh").addEventListener("click", () => state.players.forEach(loadRio));

// "Add character" opens a dialog; new users also get a button in the welcome box.
function openAddDialog() {
  const form = $("#add-player");
  form.reset();
  form.region.value = defaultRegion;
  $("#add-error").hidden = true;
  $("#add-dialog").showModal();
  form.name.focus();
}
document.querySelectorAll("[data-open-add]").forEach((b) => b.addEventListener("click", openAddDialog));
$("#add-cancel").addEventListener("click", () => $("#add-dialog").close());

$("#add-player").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const p = { name: form.name.value.trim(), realm: form.realm.value.trim(), region: form.region.value };
  const err = $("#add-error");
  const submit = $("#add-submit");
  err.hidden = true;
  submit.disabled = true;
  submit.textContent = "Checking…";
  try {
    const profile = await fetchRio(p); // validate the character exists before saving
    p.name = profile.name;
    p.realm = profile.realm;
    const ref = await addDoc(collection(db, "players"), {
      ...p, keyDungeon: "", keyLevel: null, ownerUid: state.user.uid, createdAt: serverTimestamp(),
    });
    if (!state.me) setMe(ref.id);
    $("#add-dialog").close();
  } catch (ex) {
    err.textContent = ex.message.includes("character") ? `Raider.io: ${ex.message}` : ex.message;
    err.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "Add";
  }
});

// ---------- Warcraft Logs: team runs ----------

const runId = ({ report, fight }) => `${report.code}_${fight.id}`;
const wclClassName = (subType) => String(subType ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"); // "DeathKnight" -> "Death Knight"
const normName = (s) => String(s ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const kFormat = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n ?? 0));
const myDisplayName = () => myPlayers()[0]?.name ?? state.user?.displayName?.split(" ")[0] ?? "someone";

function timeAgo(date) {
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// Timed / over time, using the dungeon timer from Raider.io when we have it.
function runResult(r) {
  const timer = state.dungeons.find((d) => normName(d.name) === normName(r.dungeon))?.timer;
  const diff = timer ? timer * 1000 - r.timeMs : null;
  if (r.bonus > 0) {
    return { ok: true, text: `✅ Timed${"▲".repeat(r.bonus)}${diff != null ? ` · ${fmtTime(diff)} left` : ""}` };
  }
  if (diff != null && diff < 0) return { ok: false, text: `❌ ${fmtTime(-diff)} over` };
  return { ok: false, text: r.kill ? "❌ Not timed" : "❌ Not finished" };
}

function runDoc({ report, fight, players }, details) {
  const deathsBy = new Map();
  for (const d of details.deaths) deathsBy.set(d.actorId, (deathsBy.get(d.actorId) ?? 0) + 1);
  return {
    code: report.code,
    fightId: fight.id,
    dungeon: fight.name,
    level: fight.keystoneLevel,
    timeMs: Math.round(fight.keystoneTime ?? fight.endTime - fight.startTime),
    bonus: fight.keystoneBonus ?? 0,
    kill: !!fight.kill,
    startedAt: Math.round(report.startTime + fight.startTime),
    avgIlvl: fight.averageItemLevel ? Math.round(fight.averageItemLevel * 10) / 10 : null,
    team: players.filter((p) => p.team).map((p) => p.name),
    players: players.slice(0, 10).map((p) => ({
      name: p.name,
      className: wclClassName(p.className),
      spec: p.spec ?? "",
      team: p.team,
      dps: details.dps.get(p.actorId) ?? 0,
      hps: details.hps.get(p.actorId) ?? 0,
      deaths: deathsBy.get(p.actorId) ?? 0,
    })),
    deaths: details.deaths.slice(0, 40).map((d) => ({
      name: d.name,
      ability: d.ability,
      atMs: Math.max(0, Math.round(d.timestamp - fight.startTime)),
    })),
    importedBy: state.user.uid,
    importedAt: serverTimestamp(),
  };
}

// ---------- Discord announcements ----------

// Only fresh runs are announced, so connecting for the first time doesn't flood the channel.
const ANNOUNCE_RUNS_NEWER_THAN_HOURS = 12;
const DISCORD_WEBHOOK_RE = /^https:\/\/(ptb\.|canary\.)?(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const TANK_SPECS = ["Blood", "Vengeance", "Guardian", "Brewmaster", "Protection"];
const HEALER_SPECS = ["Holy", "Discipline", "Restoration", "Mistweaver", "Preservation"];

function roleIcon(p) {
  if (TANK_SPECS.includes(p.spec)) return "🛡️";
  if (HEALER_SPECS.includes(p.spec)) return "✚";
  return "⚔️";
}

async function postToDiscord(payload, url = state.discordWebhook) {
  const res = await fetch(`${url}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Team Serious Face",
      avatar_url: new URL("images/favicon.png", location.href).href,
      ...payload,
    }),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status}${res.status === 404 ? " (webhook deleted?)" : ""}`);
}

async function announceRun(r) {
  if (!state.discordWebhook || Date.now() - r.startedAt > ANNOUNCE_RUNS_NEWER_THAN_HOURS * 3600e3) return;
  const res = runResult(r);
  const team = (r.players ?? []).filter((p) => p.team || inRoster(p.name));
  const top = [...(r.players ?? [])].sort((a, b) => b.dps - a.dps)[0];
  const deaths = r.deaths?.length ?? 0;
  const icon = state.dungeons.find((d) => normName(d.name) === normName(r.dungeon))?.icon;
  await postToDiscord({
    embeds: [{
      title: `+${r.level} ${r.dungeon}`,
      url: `https://www.warcraftlogs.com/reports/${r.code}#fight=${r.fightId}`,
      description: res.text,
      color: res.ok ? 0x3fbf7f : 0xff6b6b,
      thumbnail: icon ? { url: icon } : undefined,
      fields: [
        { name: "Team", value: team.map((p) => `${roleIcon(p)} ${p.name}`).join("  ·  ") || "—" },
        { name: "Deaths", value: deaths ? `💀 ${deaths}` : "None 🎉", inline: true },
        ...(top ? [{ name: "Top DPS", value: `${top.name} · ${kFormat(top.dps)}`, inline: true }] : []),
      ],
      timestamp: new Date(r.startedAt).toISOString(),
      footer: { text: "Warcraft Logs" },
    }],
  });
}

// Finds runs with at least MIN_TEAM_IN_RUN roster characters and saves new ones for everyone.
// With `code`, only that report is checked (for pasted links, e.g. unlisted logs).
async function refreshLogs({ code } = {}) {
  const logs = state.logs;
  if (logs.busy) return;
  Object.assign(logs, { busy: true, error: "", notice: "", status: code ? "Reading the log…" : "Looking for new team runs…" });
  renderLogs();
  try {
    const chars = state.players.map((p) => ({ name: p.name, realm: p.realm, realmSlug: slug(p.realm), region: p.region }));
    if (chars.length < MIN_TEAM_IN_RUN) throw new Error(`Add at least ${MIN_TEAM_IN_RUN} characters to the roster first.`);
    const codes = code ? [code] : await wcl.recentTeamReportCodes(chars, MIN_TEAM_IN_RUN);
    const reports = await wcl.fetchReports(codes);
    if (code && !reports.length) throw new Error("Couldn't open that log. If it's private, the uploader needs to make it unlisted or public.");
    const found = reports.flatMap((r) => wcl.teamRuns(r, chars, MIN_TEAM_IN_RUN));
    const known = new Set(state.runs.map((r) => r.id));
    const fresh = found.filter((r) => !known.has(runId(r))).slice(0, 20);
    for (const [i, run] of fresh.entries()) {
      logs.status = `Importing run ${i + 1} of ${fresh.length}…`;
      renderLogs();
      const details = await wcl.runDetails(run.report.code, run.fight.id);
      const data = runDoc(run, details);
      await setDoc(doc(db, "runs", runId(run)), data);
      try {
        await announceRun(data);
      } catch (e) {
        console.error("Discord:", e);
        logs.error = `Saved the run, but couldn't post it to Discord: ${e.message}`;
      }
    }
    if (!code) await setDoc(doc(db, "meta", "logs"), { lastRefresh: serverTimestamp(), byName: myDisplayName() });
    logs.notice = code && !found.length
      ? `No Mythic+ runs with ${MIN_TEAM_IN_RUN}+ of the team in that log.`
      : fresh.length ? `Added ${fresh.length} new run${fresh.length === 1 ? "" : "s"}.` : "No new runs.";
  } catch (e) {
    console.error(e);
    logs.error = e.message;
  } finally {
    logs.busy = false;
    logs.status = "";
    renderLogs();
  }
}

// One connected member's browser keeps the shared list fresh; everyone else just reads it.
// Called on load, when data arrives and every minute while the page is open. The last check is
// shared through meta/logs, so a browser skips it when someone else checked recently.
function maybeAutoRefreshLogs() {
  const logs = state.logs;
  if (!state.user || logs.busy || !wcl.isConfigured() || !wcl.isConnected()) return;
  if (!logs.metaLoaded || state.players.length < MIN_TEAM_IN_RUN) return;
  const interval = LOGS_AUTO_REFRESH_MINUTES * 60000;
  if (!logs.justConnected && Date.now() - (logs.lastAttempt ?? 0) < interval) return; // also after errors
  const last = logs.meta?.lastRefresh?.toDate?.();
  if (logs.justConnected || !last || Date.now() - last.getTime() > interval) {
    logs.lastAttempt = Date.now();
    logs.justConnected = false;
    refreshLogs();
  }
}
setInterval(maybeAutoRefreshLogs, 60000);

// Team members in a run, matched against the current roster so characters added later count too.
function inRoster(name) {
  return state.players.some((p) => normName(p.name) === normName(name));
}
function runTeam(r) {
  const players = r.players ?? [];
  const now = players.filter((p) => p.team || inRoster(p.name));
  return now.length ? now : (r.team ?? []).map((name) => ({ name }));
}

function runDetailsHtml(r) {
  const players = [...(r.players ?? [])]
    .map((p) => ({ ...p, team: p.team || inRoster(p.name) }))
    .sort((a, b) => b.team - a.team || b.dps - a.dps);
  return `<div class="run-details">
    <table>
      <tr><th>Player</th><th>Spec</th><th>DPS</th><th>HPS</th><th>Deaths</th></tr>
      ${players.map((p) => `<tr class="${p.team ? "is-team" : ""}">
        <td style="color:${CLASS_COLORS[p.className] ?? "var(--text)"}">${esc(p.name)}</td>
        <td class="muted">${esc(p.spec)}</td>
        <td class="num">${kFormat(p.dps)}</td>
        <td class="num">${kFormat(p.hps)}</td>
        <td class="num ${p.deaths ? "dead" : ""}">${p.deaths}</td>
      </tr>`).join("")}
    </table>
    ${r.deaths?.length ? `<ul class="death-list">${r.deaths.map((d) => `<li>💀 <b>${esc(d.name)}</b>
      <span class="muted">${esc(d.ability)} · ${fmtTime(d.atMs)}</span></li>`).join("")}</ul>` : `<p class="muted small">No deaths. 🎉</p>`}
    <a class="muted small" href="https://www.warcraftlogs.com/reports/${encodeURIComponent(r.code)}#fight=${r.fightId}"
       target="_blank" rel="noopener">Open the full log on Warcraft Logs ↗</a>
  </div>`;
}

function renderLogs() {
  const el = $("#logs");
  if (!el) return;
  if (!wcl.isConfigured()) { el.innerHTML = ""; return; }
  const logs = state.logs;
  const connected = wcl.isConnected();
  const last = logs.meta?.lastRefresh?.toDate?.();
  const statusText = logs.status
    || (last ? `Updated ${timeAgo(last)} by ${esc(logs.meta.byName)}` : "No logs fetched yet");
  // Day tabs for the week shown in the schedule.
  const byDay = Array.from({ length: 7 }, () => []);
  for (const r of state.runs) {
    const i = runDayIndex(r);
    if (i >= 0 && i < 7) byDay[i].push(r);
  }
  byDay.forEach((list) => list.sort((a, b) => a.startedAt - b.startedAt));
  const todayIdx = weekKey(mondayOf(new Date())) === weekKey(state.weekStart) ? (new Date().getDay() + 6) % 7 : -1;
  const lastWithRuns = byDay.findLastIndex((list) => list.length);
  const day = logs.day ?? (todayIdx >= 0 ? todayIdx : Math.max(lastWithRuns, 0));
  const runs = byDay[day];

  el.innerHTML = `
    <div class="logs-head">
      <h3>📜 Logs</h3>
      ${connected
        ? `<button class="secondary" data-logs="refresh" ${logs.busy ? "disabled" : ""}>${logs.busy ? "Fetching…" : "Refresh"}</button>`
        : `<button class="secondary" data-logs="connect">Connect Warcraft Logs</button>`}
    </div>
    <p class="muted small">${statusText}${connected ? ` · <a href="#" data-logs="disconnect">disconnect</a>` : ""}</p>
    <p class="muted small discord-line">${state.discordWebhook
      ? `<span class="ok">● Discord</span>: new runs are posted to your channel · <a href="#" data-logs="discord">settings</a>`
      : `Discord: not set up · <a href="#" data-logs="discord">set up</a>`}</p>
    ${logs.error ? `<p class="error small">${esc(logs.error)}</p>` : ""}
    ${logs.notice ? `<p class="small notice">${esc(logs.notice)}</p>` : ""}
    ${!connected && !state.runs.length ? `<p class="muted small">Runs where at least ${MIN_TEAM_IN_RUN} of the team played show up here.
      Someone with a Warcraft Logs account connects once, then everyone can see them.</p>` : ""}
    ${connected ? `<form class="log-paste" id="log-paste">
      <input name="link" placeholder="Paste a Warcraft Logs link (optional)" autocomplete="off">
      <button class="secondary" ${logs.busy ? "disabled" : ""}>Add</button>
    </form>` : ""}
    <div class="day-tabs" role="tablist">${DAYS.map((name, i) => `
      <button role="tab" class="${i === day ? "on" : ""} ${i === todayIdx ? "today" : ""} ${byDay[i].length ? "" : "empty"}"
        aria-selected="${i === day}" data-day="${i}">${name}${byDay[i].length ? `<span class="count">${byDay[i].length}</span>` : ""}</button>`).join("")}
    </div>
    ${runs.length ? "" : `<p class="muted small day-empty">No team runs on ${addDays(state.weekStart, day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</p>`}
    <ul class="run-list">${runs.map((r) => {
      const d = state.dungeons.find((x) => normName(x.name) === normName(r.dungeon));
      const res = runResult(r);
      const when = new Date(r.startedAt);
      const open = logs.open === r.id;
      return `<li class="${open ? "open" : ""}">
        <button class="run-row" data-run="${esc(r.id)}" aria-expanded="${open}">
          <span class="muted when">${when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
          ${d?.icon ? `<img class="dicon" src="${esc(d.icon)}" alt="">` : ""}
          <b class="lvl">+${r.level}</b>
          <span class="dname">${esc(r.dungeon)}</span>
          <span class="result ${res.ok ? "ok" : "bad"}">${res.text}</span>
          <span class="who">${runTeam(r).map((p) =>
            `<span style="color:${CLASS_COLORS[p.className] ?? "var(--text)"}">${esc(p.name)}</span>`).join(" · ")}</span>
        </button>
        ${open ? runDetailsHtml(r) : ""}
      </li>`;
    }).join("")}</ul>`;
}

// Which day of the shown week a run belongs to. Runs before 06:00 count toward the evening
// before, like the schedule's 00:00–01:00 rows. Returns -1/7+ for runs outside the week.
const DAY_STARTS_AT_HOUR = 6;
function runDayIndex(r) {
  const t = new Date(r.startedAt - DAY_STARTS_AT_HOUR * 3600e3);
  const day = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((day - state.weekStart) / 86400e3); // round: DST days are 23/25 h long
}

$("#logs").addEventListener("click", (e) => {
  const action = e.target.closest("[data-logs]")?.dataset.logs;
  if (action) {
    e.preventDefault();
    if (action === "connect") wcl.connect();
    if (action === "discord") openDiscordDialog();
    if (action === "refresh") refreshLogs();
    if (action === "disconnect" && confirm("Disconnect Warcraft Logs in this browser? The saved runs stay.")) {
      wcl.disconnect();
      renderLogs();
    }
    return;
  }
  const tab = e.target.closest("[data-day]");
  if (tab) {
    state.logs.day = Number(tab.dataset.day);
    state.logs.open = null;
    renderLogs();
    return;
  }
  const row = e.target.closest("[data-run]");
  if (row) {
    state.logs.open = state.logs.open === row.dataset.run ? null : row.dataset.run;
    renderLogs();
  }
});

$("#logs").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = wcl.reportCodeFrom(e.target.link.value);
  if (!code) {
    state.logs.error = "That doesn't look like a Warcraft Logs report link.";
    renderLogs();
    return;
  }
  refreshLogs({ code });
});

// ---------- tabs: schedule / team runs / hall of shame ----------

function showView(view) {
  if (view === "runs" && !wcl.isConfigured()) view = "schedule";
  if (!["schedule", "runs", "shame"].includes(view)) view = "schedule";
  try { localStorage.setItem("view", view); } catch { /* not important */ }
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== view; });
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === view);
    b.setAttribute("aria-selected", b.dataset.view === view);
  });
  $(".week-actions").hidden = view !== "schedule"; // copy/clear only make sense for the schedule
}

$(".view-tabs").addEventListener("click", (e) => {
  const view = e.target.closest("[data-view]")?.dataset.view;
  if (view) showView(view);
});
if (!wcl.isConfigured()) $('[data-view="runs"]').hidden = true;
let savedView = "schedule";
try { savedView = localStorage.getItem("view") || "schedule"; } catch { /* default */ }
showView(new URLSearchParams(location.search).has("code") ? "runs" : savedView); // back from the WCL login

// Coming back from the Warcraft Logs login page.
wcl.handleRedirect().then((done) => {
  if (!done) return;
  state.logs.notice = "Warcraft Logs connected.";

  state.logs.justConnected = true; // fetch right away, however recent the last check was
  renderLogs();
  maybeAutoRefreshLogs();
}).catch((e) => {
  state.logs.error = `Warcraft Logs: ${e.message}`;
  renderLogs();
});

// ---------- Discord settings dialog ----------

function discordMessage(text, ok) {
  const el = $("#discord-msg");
  el.textContent = text;
  el.className = `small ${ok ? "notice" : "error"}`;
  el.hidden = !text;
}

function openDiscordDialog() {
  const form = $("#discord-form");
  form.url.value = state.discordWebhook;
  discordMessage("");
  $("#discord-remove").hidden = !state.discordWebhook;
  $("#discord-dialog").showModal();
  form.url.focus();
}

function webhookFromForm() {
  const url = $("#discord-form").url.value.trim();
  if (!DISCORD_WEBHOOK_RE.test(url)) {
    discordMessage("That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…).", false);
    return null;
  }
  return url;
}

$("#discord-cancel").addEventListener("click", () => $("#discord-dialog").close());

$("#discord-test").addEventListener("click", async () => {
  const url = webhookFromForm();
  if (!url) return;
  try {
    await postToDiscord({ content: `👋 Test from Team Serious Face, sent by ${myDisplayName()}. New team runs will show up here.` }, url);
    discordMessage("Test message sent. Check the channel!", true);
  } catch (e) {
    discordMessage(`Couldn't post: ${e.message}`, false);
  }
});

$("#discord-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = webhookFromForm();
  if (!url) return;
  try {
    await setDoc(doc(db, "config", "discord"), { webhookUrl: url, updatedBy: myDisplayName() });
    $("#discord-dialog").close();
  } catch (err) {
    discordMessage(`Couldn't save: ${err.message}. Are the latest Firestore rules published?`, false);
  }
});

$("#discord-remove").addEventListener("click", async () => {
  if (!confirm("Stop posting new runs to Discord?")) return;
  await deleteDoc(doc(db, "config", "discord"));
  $("#discord-dialog").close();
});

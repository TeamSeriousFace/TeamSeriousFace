import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, query, where,
  addDoc, setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { firebaseConfig, defaultRegion } from "./firebase-config.js";

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
  players: [],          // [{id, name, realm, region, keyDungeon, keyLevel, ownerUid}]
  availability: {},     // playerId -> Set("d-h") for the shown week
  busy: {},             // playerId -> Set(dayIndex) the player can't play in the shown week
  lates: [],            // [{id, playerId, minutes, note, at, reportedBy, reportedByName, excuse?}]
  rio: {},              // playerId -> raider.io profile | {error}
  dungeons: [],         // current season dungeons from raider.io
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

$("#sign-in").addEventListener("click", () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => showSignin(e.message)));
$("#sign-out").addEventListener("click", () => signOut(auth));

let unsubPlayers = null;
let unsubLates = null;

onAuthStateChanged(auth, (user) => {
  state.user = user;
  unsubPlayers?.();
  unsubLates?.();
  state.unsubAvailability?.();
  unsubPlayers = unsubLates = state.unsubAvailability = null;
  if (!user) {
    if ($("#signin-error").hidden) showSignin();
    return;
  }
  $("#signin").hidden = true;
  $("#app").hidden = false;
  $("#who").hidden = false;
  $("#user-email").textContent = user.email;
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
    state.dungeons = (current?.dungeons ?? []).map((d) => d.name).sort();
    renderRoster();
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

$("#grid").addEventListener("pointerdown", (e) => {
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
  return `<span class="run ${timed ? "timed" : ""}" title="${esc(r.dungeon)} – ${fmtTime(r.clear_time_ms)} / ${fmtTime(r.par_time_ms)}">${esc(r.short_name)} ${plus}${r.mythic_level}</span>`;
}

function keyEditor(p) {
  if (p.id !== state.me) {
    return p.keyLevel
      ? `<div class="key">🔑 <b>${esc(p.keyDungeon || "?")} +${esc(p.keyLevel)}</b></div>`
      : `<div class="key muted">🔑 No key set</div>`;
  }
  const options = state.dungeons.length
    ? `<select data-field="keyDungeon"><option value="">Dungeon…</option>${state.dungeons.map((d) =>
        `<option ${d === p.keyDungeon ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>`
    : `<input data-field="keyDungeon" placeholder="Dungeon" value="${esc(p.keyDungeon)}" style="width:120px">`;
  return `<div class="key">🔑 My key: ${options}
    <input data-field="keyLevel" type="number" min="2" max="40" placeholder="+lvl" value="${esc(p.keyLevel)}"></div>`;
}

function renderRoster() {
  $(".roster").classList.toggle("needs-char", !myPlayers().length);
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
            <div class="sub">${legend}${esc(r.active_spec_name)} ${esc(r.class)} · ${esc(r.realm)}</div>
          </div>
          <div class="score"><b style="color:${season.color}">${Math.round(season.score)}</b><div class="sub">M+ score</div></div>
        </div>
        <div class="stats">
          <span>iLvl <b>${r.gear?.item_level_equipped?.toFixed(1) ?? "?"}</b></span>
          <span>This week <b>${weekly.length}</b> runs${weekly[0] ? `, best <b>+${weekly[0].mythic_level}</b>` : ""}</span>
        </div>
        ${best.length ? `<div class="runs">${best.slice(0, 8).map(runChip).join("")}</div>` : ""}`;
    }
    return `<div class="card ${p.id === state.me ? "me" : ""}" style="--class-color:${color}" data-id="${p.id}">
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
  updateDoc(doc(db, "players", state.me), { [field]: value });
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

$("#add-player").region.value = defaultRegion;
$("#add-player").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const p = { name: form.name.value.trim(), realm: form.realm.value.trim(), region: form.region.value };
  const err = $("#add-error");
  err.hidden = true;
  try {
    const profile = await fetchRio(p); // validate the character exists before saving
    p.name = profile.name;
    p.realm = profile.realm;
  } catch (ex) {
    err.textContent = `Raider.io: ${ex.message}`;
    err.hidden = false;
    return;
  }
  const ref = await addDoc(collection(db, "players"), {
    ...p, keyDungeon: "", keyLevel: null, ownerUid: state.user.uid, createdAt: serverTimestamp(),
  });
  form.name.value = "";
  form.realm.value = "";
  if (!state.me) setMe(ref.id);
});

/* =====================================================================
   ZEAL ATC — UI orchestration: menu, ratings/career, strips, comm tabs,
   intercom, header, help, main loop.
   ===================================================================== */
"use strict";

/* ---------------- career / ratings ---------------- */
const CAREER_KEY = "zealAtcCareer";
let career = { pts: 0, sandbox: false };
try { career = { ...career, ...(JSON.parse(localStorage.getItem(CAREER_KEY)) || {}) }; } catch (e) {}
function saveCareer() { try { localStorage.setItem(CAREER_KEY, JSON.stringify(career)); } catch (e) {} }
function ratingFor(pts) {
  let r = RATINGS[0];
  for (const rt of RATINGS) if (pts >= rt.pts) r = rt;
  return r;
}
function posUnlocked(pos) {
  if (career.sandbox) return true;
  const need = RATINGS.findIndex(r => r.id === POS_RATING[pos]);
  const have = RATINGS.indexOf(ratingFor(career.pts));
  return have >= need;
}
let lastSynced = 0;
function syncCareer() {
  if (G.points > lastSynced) {
    const before = ratingFor(career.pts).id;
    career.pts += G.points - lastSynced;
    lastSynced = G.points;
    saveCareer();
    const after = ratingFor(career.pts);
    if (after.id !== before) {
      chime();
      xmit(G.playerPos, "SYS", "sys", `RATING UPGRADE — you are now ${after.id} (${after.name}). New positions unlocked.`, null);
    }
  }
}

/* ---------------- menu ---------------- */
let selFac = 0, selPos = "DEL";
function renderMenu() {
  const r = ratingFor(career.pts);
  const el = document.getElementById("menucard");
  el.innerHTML = `
    <h2>ZEAL ATC NETWORK</h2>
    <p class="dimtxt">A VATSIM-style controller network where every pilot — and every other controller — is an AI.
    Pick an ARTCC and a position. Unstaffed positions are worked by AI controllers you can coordinate with;
    flight strips pass between positions; scenarios (wind, runway config, traffic, events) are randomized every session.</p>

    <h4>1 · CHOOSE YOUR ARTCC</h4>
    <div class="facgrid">${FACILITIES.map((f, i) => `
      <div class="faccard ${i === selFac ? "sel" : ""}" data-f="${i}">
        <div class="artcc">${f.artcc} — ${f.artccName}</div>
        <div class="ap">${f.icao} · ${f.apName}</div>
        <div class="meta">TRACON: ${f.tracon}<br>DEL ${f.freqs.DEL} · GND ${f.freqs.GND} · TWR ${f.freqs.TWR}<br>APP ${f.freqs.APP} · CTR ${f.freqs.CTR}</div>
      </div>`).join("")}</div>

    <h4>2 · CHOOSE YOUR POSITION</h4>
    <div class="posgrid">${POSITIONS.map(p => {
      const ok = posUnlocked(p);
      return `<div class="poscard ${p === selPos ? "sel" : ""} ${ok ? "" : "locked"}" data-p="${p}">
        <div class="pn">${p} ${ok ? "" : "🔒"}</div>
        <div class="pr">${POS_NAME[p]}<br>requires ${POS_RATING[p]}</div>
      </div>`;
    }).join("")}</div>

    <div class="ratebox">
      Your rating: <b>${r.id} — ${r.name}</b> · ${career.pts} pts
      <br><span class="dimtxt">${RATINGS.map(rt => `${rt.id} ${rt.pts}+`).join(" · ")} — earn points by working traffic correctly, VATSIM-style
      (<a href="https://vatsim.net/docs/basics/becoming-a-controller/" target="_blank" style="color:var(--cyan)">how the real ratings work</a>).</span>
      <br><label style="cursor:pointer"><input type="checkbox" id="sandbox" ${career.sandbox ? "checked" : ""}> Sandbox — unlock all positions</label>
    </div>

    <div class="menurow">
      <label>Traffic:
        <select id="mDensity">
          <option value="low">LOW</option>
          <option value="med" selected>MEDIUM</option>
          <option value="high">HIGH</option>
        </select>
      </label>
      <button class="bigbtn" id="mStart">CONNECT</button>
      <span class="dimtxt">Wind, runway config, ATIS, time of day and traffic events are rolled when you connect.</span>
    </div>`;
  el.querySelectorAll(".faccard").forEach(c => c.onclick = () => { selFac = +c.dataset.f; renderMenu(); });
  el.querySelectorAll(".poscard").forEach(c => c.onclick = () => {
    const p = c.dataset.p;
    if (!posUnlocked(p)) return;
    selPos = p; renderMenu();
  });
  el.querySelector("#sandbox").onchange = e => { career.sandbox = e.target.checked; saveCareer(); renderMenu(); };
  el.querySelector("#mStart").onclick = () => {
    document.getElementById("menu").classList.remove("open");
    beginSession(selFac, selPos, el.querySelector("#mDensity").value);
  };
}

/* ---------------- comm tabs ---------------- */
let activeTab = "DEL";
const TABS = [...POSITIONS, "INT"];
function renderTabs() {
  const el = document.getElementById("freqtabs");
  el.innerHTML = TABS.map(p => {
    const freq = p === "INT" ? "LAND" : G.fac.freqs[p];
    return `<div class="ftab ${p === activeTab ? "on" : ""} ${G.monitored[p] ? "monon" : ""}" data-t="${p}">
      ${p}${p === G.playerPos ? "*" : ""}<span class="mon">${freq}${G.monitored[p] ? " ♪" : ""}</span><span class="dot"></span>
    </div>`;
  }).join("");
  el.querySelectorAll(".ftab").forEach(t => {
    t.onclick = () => { activeTab = t.dataset.t; renderTabs(); renderLog(); };
    t.oncontextmenu = e => {                     // right-click = toggle monitor (listen in)
      e.preventDefault();
      const p = t.dataset.t;
      if (p === G.playerPos || p === "INT") return;
      G.monitored[p] = !G.monitored[p];
      renderTabs();
    };
  });
}
function fmtClock(t) {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function renderLog() {
  const logEl = document.getElementById("log");
  const rows = (G.channels[activeTab] || []).slice(-120);
  logEl.innerHTML = rows.map(r =>
    `<div class="row"><span class="t">${fmtClock(r.t)}</span><span class="${r.cls}"><span class="who">${r.who}:</span> ${escapeHtml(r.text)}</span></div>`
  ).join("");
  logEl.scrollTop = logEl.scrollHeight;
  const tab = document.querySelector(`.ftab[data-t="${activeTab}"]`);
  if (tab) tab.classList.remove("unread");
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- strips ---------------- */
function renderStrips() {
  const el = document.getElementById("stripbay");
  if (!G.running) { el.innerHTML = ""; return; }
  let html = "";
  const order = [G.playerPos, ...POSITIONS.filter(p => p !== G.playerPos)];
  for (const pos of order) {
    const list = G.aircraft.filter(a => a.owner === pos && !a.remove && a.state !== "out");
    html += `<h3><span${pos === G.playerPos ? ' class="me"' : ""}>${pos === G.playerPos ? "▶ " : ""}${pos} — ${POS_NAME[pos].toUpperCase()}</span><span>${list.length}</span></h3>`;
    for (const ac of list) {
      const sel = G.selected === ac ? " sel" : "";
      if (pos === G.playerPos) {
        const route = ac.role === "dep"
          ? `${ac.dest.icao} · ${ac.sid.name} · ${ac.exitFix.name}`
          : `${ac.origin.icao} · ${ac.star} · ${ac.entryFix.name}`;
        const alt = ac.alt < 50 ? "GND" : String(Math.round(ac.alt / 100)).padStart(3, "0");
        const asg = ac.assignedAlt ? String(Math.round(ac.assignedAlt / 100)).padStart(3, "0") : "---";
        html += `<div class="strip ${ac.role}${sel}" data-id="${ac.id}">
          <div><span class="cs">${ac.cs}</span> <span class="dimtxt">${ac.type}${ac.heavy ? "/H" : ""} sq${ac.sqk}${ac.medevac ? " MEDEVAC" : ""}</span></div>
          <div class="meta"><span>${route}</span></div>
          <div class="meta"><span>${ac.role === "dep" ? "gate " + ac.gate : "arr " + G.arrRwy.id}</span><span>${alt}→${asg}</span></div>
          <div class="st">${stateLabel(ac)}</div>
        </div>`;
      } else {
        html += `<div class="strip compact ${ac.role}${sel}" data-id="${ac.id}"><span class="cs">${ac.cs}</span><span>${stateLabel(ac)}</span></div>`;
      }
    }
  }
  el.innerHTML = html;
  el.querySelectorAll(".strip").forEach(s => {
    s.onclick = () => {
      G.selected = G.aircraft.find(a => a.id === +s.dataset.id) || null;
      renderStrips();
      document.getElementById("cmd").focus();
    };
  });
}

/* ---------------- intercom buttons ---------------- */
function renderIntercom() {
  const el = document.getElementById("intbtns");
  el.innerHTML = POSITIONS.filter(p => p !== G.playerPos)
    .map(p => `<button data-i="${p}">${p}</button>`).join("") +
    `<select id="intAct">
      <option value="status">status check</option>
      <option value="handoff">req handoff (selected)</option>
      <option value="pointout">point out (selected)</option>
    </select>`;
  el.querySelectorAll("button").forEach(b => {
    b.onclick = () => intercom(b.dataset.i, document.getElementById("intAct").value);
  });
}

/* ---------------- header ---------------- */
function renderHeader() {
  document.getElementById("clock").textContent = fmtClock(G.t);
  document.getElementById("scScore").textContent = G.score;
  const r = ratingFor(career.pts);
  document.getElementById("scRating").textContent = career.sandbox ? r.id + "·SB" : r.id;
  document.getElementById("scPts").textContent = career.pts;
  if (G.running) {
    document.getElementById("facinfo").textContent =
      `${G.fac.icao} ${G.cfg.name} · ${ctrlCallsign(G.playerPos)} ${G.fac.freqs[G.playerPos]} · ARR ${G.arrRwy.id} DEP ${G.depRwy.id}`;
    document.getElementById("btnAtis").textContent = "ATIS " + G.atis.letter[0];
    document.getElementById("txlabel").textContent = `${G.fac.freqs[G.playerPos]} TX>`;
  }
}

/* ---------------- engine hooks ---------------- */
G.hooks.log = (chan, who, cls, text) => {
  if (chan === activeTab) renderLog();
  else {
    const tab = document.querySelector(`.ftab[data-t="${chan}"]`);
    if (tab) tab.classList.add("unread");
  }
};
G.hooks.strips = () => renderStrips();
G.hooks.score = () => { syncCareer(); renderHeader(); };

/* ---------------- session boot ---------------- */
function beginSession(facIdx, pos, density) {
  lastSynced = 0;
  startSession(facIdx, pos, density);
  activeTab = pos;
  setView(pos === "DEL" || pos === "GND" ? "ASDX" : pos === "TWR" ? "CAB" : "STARS");
  V.range = pos === "CTR" ? 60 : 45;
  renderTabs(); renderLog(); renderStrips(); renderIntercom(); renderHeader();
  const ph = {
    DEL: "DAL123 cleared to Boston, DEEZZ5 departure then as filed, climb and maintain 5000, departure 127.4, squawk 2345   ·   then: readback correct",
    GND: "DAL123 pushback approved  ·  taxi  ·  hold position  ·  contact tower",
    TWR: "DAL123 line up and wait  ·  cleared for takeoff  ·  cleared to land  ·  contact departure / ground",
    APP: "DAL123 t l 270 d 40 s 210  ·  cleared ILS  ·  contact tower / center",
    CTR: "DAL123 descend via  ·  d 110  ·  direct LENDY  ·  contact approach",
  }[pos];
  document.getElementById("cmd").placeholder = ph;
  setTimeout(() => { if (G.running) TTS.say(atisText(), ATIS_VOICE); }, 2500);
}

function endSession() {
  G.running = false;
  TTS.stopAll();
  document.getElementById("menu").classList.add("open");
  renderMenu();
}

/* ---------------- controls ---------------- */
const cmdEl = document.getElementById("cmd");
document.getElementById("btnSend").onclick = () => { playerTransmit(cmdEl.value); cmdEl.value = ""; };
cmdEl.addEventListener("keydown", e => {
  if (e.key === "Enter") { playerTransmit(cmdEl.value); cmdEl.value = ""; }
  if (e.key === "Escape") { cmdEl.value = ""; G.selected = null; renderStrips(); }
});
document.addEventListener("keydown", e => {
  if (e.target === cmdEl || !G.running) return;
  if (document.getElementById("menu").classList.contains("open")) return;
  if (e.key === "p" || e.key === "P") togglePause();
  else if (e.key.length === 1 && /[a-z0-9]/i.test(e.key) && !e.ctrlKey && !e.metaKey && V.mode !== "CAB") cmdEl.focus();
});
function togglePause() {
  G.paused = !G.paused;
  const b = document.getElementById("btnPause");
  b.textContent = G.paused ? "RESUME" : "PAUSE";
  b.classList.toggle("active", G.paused);
  if (G.paused) TTS.stopAll();
}
document.getElementById("btnPause").onclick = togglePause;
document.getElementById("btnSpeed").onclick = function () {
  G.speed = G.speed === 1 ? 2 : G.speed === 2 ? 4 : 1;
  this.textContent = G.speed + "×";
  this.classList.toggle("active", G.speed !== 1);
};
document.getElementById("btnVoice").onclick = function () {
  TTS.enabled = !TTS.enabled;
  if (!TTS.enabled) TTS.stopAll();
  this.textContent = TTS.enabled ? "VOICES ON" : "VOICES OFF";
  this.classList.toggle("active", TTS.enabled);
};
document.getElementById("btnAtis").onclick = () => {
  if (!G.running) return;
  xmit(G.playerPos, "ATIS", "sys", atisText(), null);
  TTS.say(atisText(), ATIS_VOICE);
};
document.getElementById("btnMenu").onclick = endSession;
document.querySelectorAll("#viewtabs button").forEach(b => b.onclick = () => setView(b.dataset.v));

/* ---------------- help ---------------- */
document.getElementById("btnHelp").onclick = () => {
  const F = G.fac || FACILITIES[0];
  document.getElementById("helpcard").innerHTML = `
    <button class="close" onclick="document.getElementById('help').classList.remove('open')">CLOSE</button>
    <h2>WORKING THE POSITIONS</h2>
    <p class="dimtxt">Address aircraft by callsign (typed or spoken — hold <code>PTT</code>/<b>Tab</b>). Click a target or strip to
    select it and you can drop the callsign. Chain instructions freely. Right-click a frequency tab to listen in on an AI position.
    Strips flow DEL → GND → TWR → APP → CTR (and back down for arrivals).</p>
    <h4>CLEARANCE DELIVERY (S1)</h4>
    <table>
      <tr><td>full IFR clearance</td><td>"DAL123 cleared to Boston, DEEZZ5 departure then as filed, climb and maintain ${altWords ? "" : ""}${(F.initAlt / 1000)}000, departure ${F.freqs.APP}, squawk 2345" — the strip shows the filed route &amp; squawk</td></tr>
      <tr><td>readback correct / rbc</td><td>Bless the pilot's readback — <b>listen for wrong squawks/altitudes</b>, ~1 in 4 pilots busts one</td></tr>
      <tr><td>readback incorrect</td><td>…or restate the item ("squawk 2345") to correct them</td></tr>
    </table>
    <h4>GROUND (S1)</h4>
    <table>
      <tr><td>pushback approved / pa</td><td>Approve push from the gate</td></tr>
      <tr><td>taxi / tx</td><td>Taxi to the departure runway via the session's route (or the gate, for arrivals)</td></tr>
      <tr><td>hold position / continue</td><td>Stop and restart a taxiing aircraft</td></tr>
      <tr><td>contact tower / ct</td><td>Ship a hold-short departure to tower</td></tr>
    </table>
    <h4>TOWER (S2)</h4>
    <table>
      <tr><td>line up and wait / luaw</td><td>Onto the runway</td></tr>
      <tr><td>cleared for takeoff / cto</td><td>Roll a departure — mind the final!</td></tr>
      <tr><td>cleared to land / ctl</td><td>Arrivals go around at 1 nm if you forget</td></tr>
      <tr><td>contact departure / cd · contact ground / cg</td><td>Ship climbing departures / rollout arrivals</td></tr>
      <tr><td>go around / ga</td><td>Break off an approach</td></tr>
    </table>
    <h4>APPROACH / DEPARTURE (S3)</h4>
    <table>
      <tr><td>turn left heading 270 / t l 270</td><td>Vectors; <code>d 40</code>=descend 4,000 · <code>c 80</code>=climb 8,000 · <code>s 210</code>=speed</td></tr>
      <tr><td>cleared ILS / ils</td><td>≤30° intercept, at/below 3,000 by ~10 nm final or they'll refuse/go around</td></tr>
      <tr><td>contact tower / ct · contact center / cc</td><td>Handoffs (2.5 nm in-trail legal on final, otherwise 3 nm / 1,000 ft)</td></tr>
    </table>
    <h4>CENTER (C1)</h4>
    <table>
      <tr><td>descend via / dvs</td><td>Arrivals descend via their STAR</td></tr>
      <tr><td>d 110 · direct FIX · contact approach / cap</td><td>Feed arrivals to the TRACON by ~38 nm</td></tr>
      <tr><td>c 230 · contact center / cc</td><td>Climb departures and ship them to the next center</td></tr>
    </table>
    <p class="dimtxt">Ratings: S1 → S2 (20 pts) → S3 (50 pts) → C1 (90 pts), earned by working traffic correctly — modeled on
    <a href="https://vatsim.net/docs/basics/becoming-a-controller/" target="_blank" style="color:var(--cyan)">VATSIM's controller ratings</a>.
    <b>P</b> pauses · <b>1×/2×/4×</b> sim rate · Landlines call the AI positions · MEDEVAC flights deserve priority.</p>`;
  document.getElementById("help").classList.add("open");
};

/* ---------------- PTT ---------------- */
initPTT(document.getElementById("btnMic"), txt => { playerTransmit(txt); });

/* ---------------- main loop ---------------- */
let lastReal = performance.now();
function frame(now) {
  const realDt = Math.min(0.25, (now - lastReal) / 1000);
  lastReal = now;
  tickEngine(realDt);
  drawView();
  requestAnimationFrame(frame);
}

TTS.init();
viewResize();
renderMenu();
requestAnimationFrame(frame);

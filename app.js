/* =====================================================================
   AI ATC: UI orchestration. Menu, ratings/career, strips, comm tabs,
   intercom, SOPs, header, help, main loop.
   ===================================================================== */
"use strict";

/* ---------------- career / ratings ---------------- */
const CAREER_KEY = "aiAtcCareer";
let career = { pts: 0, sandbox: false };
try {
  const legacy = JSON.parse(localStorage.getItem("zealAtcCareer"));
  career = { ...career, ...(legacy || {}), ...(JSON.parse(localStorage.getItem(CAREER_KEY)) || {}) };
} catch (e) {}
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
      xmit(G.playerPos, "SYS", "sys", `RATING UPGRADE: you are now ${after.id} (${after.name}). New positions unlocked.`, null);
    }
  }
}

/* ---------------- menu ---------------- */
let selFac = Math.max(0, FACILITIES.findIndex(f => f.artcc === "ZNY"));
let selPos = "DEL";
function renderMenu() {
  const r = ratingFor(career.pts);
  const el = document.getElementById("menucard");
  el.innerHTML = `
    <h2>AI ATC</h2>
    <p class="dimtxt">A VATSIM-style controller network where every pilot, and every other controller, is an AI.
    Pick an ARTCC and a position. Unstaffed positions are worked by AI controllers you coordinate with over
    landlines; flight strips pass between positions; wind, runway configuration, traffic and events are rolled
    fresh every session. Displays are modeled on the ones in CRC (STARS, ASDE-X, Tower Cab).</p>

    <h4>1 · CHOOSE YOUR ARTCC (all ${FACILITIES.length} VATUSA facilities)</h4>
    <div class="facgrid">${FACILITIES.map((f, i) => `
      <div class="faccard ${i === selFac ? "sel" : ""}" data-f="${i}">
        <div class="artcc">${f.artcc} · ${f.artccName}</div>
        <div class="ap">${f.icao} · ${f.apName}</div>
        <div class="meta">${f.tracon}</div>
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
      Your rating: <b>${r.id} · ${r.name}</b> · ${career.pts} pts
      <br><span class="dimtxt">${RATINGS.map(rt => `${rt.id} ${rt.pts}+`).join(" · ")}. Earn points by working traffic
      correctly, modeled on <a href="https://vatsim.net/docs/basics/becoming-a-controller/" target="_blank" style="color:var(--cyan)">VATSIM's controller ratings</a>.</span>
      <br><label style="cursor:pointer"><input type="checkbox" id="sandbox" ${career.sandbox ? "checked" : ""}> Sandbox: unlock all positions</label>
    </div>

    <div class="menurow">
      <label>Traffic:
        <select id="mDensity">
          <option value="low">LOW</option>
          <option value="med" selected>MEDIUM</option>
          <option value="high">HIGH</option>
          <option value="insane">EVENT BANK</option>
        </select>
      </label>
      <button class="bigbtn" id="mStart">CONNECT</button>
      <span class="dimtxt">LOW is a quiet evening. HIGH is a real bank. EVENT BANK is a VATSIM event: you will be behind.
      Check the SOP after connecting for this session's runways, altitudes and frequencies.</span>
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
    t.oncontextmenu = e => {                     // right-click toggles listening in
      e.preventDefault();
      const p = t.dataset.t;
      if (p === G.playerPos || p === "INT") return;
      G.monitored[p] = !G.monitored[p];
      renderTabs();
    };
  });
}
/* real UTC, anchored at connect (see zulu() in engine.js) */
function fmtClock(t) { return zuluHMS(t); }
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

/* ---------------- flight strips (vNAS/VATSIM layout) ---------------- */
function stripHtml(ac, mine) {
  const sel = G.selected === ac ? " sel" : "";
  if (!mine) {
    return `<div class="strip compact ${ac.role}${sel}" data-id="${ac.id}">
      <span class="cs">${ac.cs}</span><span>${stateLabel(ac)}</span></div>`;
  }
  const alt = ac.alt < 50 ? "GND" : String(Math.round(ac.alt / 100)).padStart(3, "0");
  const asg = ac.assignedAlt ? String(Math.round(ac.assignedAlt / 100)).padStart(3, "0") : "---";
  const dep = ac.role === "dep" ? G.fac.icao : ac.origin.icao;
  const dst = ac.role === "dep" ? ac.dest.icao : G.fac.icao;
  const spd = ac.assignedSpd ? String(ac.assignedSpd) : "";
  const ho = ac.hoTo
    ? `<span class="ho ${ac.hoAccepted ? "ok" : "pend"}">H/O ${ac.hoTo}${ac.hoAccepted ? " ✓" : " …"}</span>`
    : "";
  const nxt = nextPosFor(ac);
  
  const ed = typeof edctOf === "function" ? edctOf(ac) : null;
  const edctStr = ed
    ? `<div class="fs-rte" style="color:${G.t < ed ? "var(--orange)" : "var(--accent)"}"><i>EDCT</i>${edctClock(ed)}Z${
        G.t < ed ? ` &nbsp;hold ${Math.max(1, Math.round((ed - G.t) / 60))} min` : " &nbsp;released"}</div>` : "";

  const R = ac.rwy || (ac.role === "dep" ? G.depRwy : G.arrRwy);
  const rwyOverrideStr = ac.rwy ? ` <span style="color:var(--orange); font-weight:bold;">[RWY ${R.id}]</span>` : "";

  return `<div class="fstrip ${ac.role}${sel}" data-id="${ac.id}">
    <div class="fs-hd"><span class="cs">${ac.cs}</span><span class="cid">${ac.cid}</span>${
      ac.emerg ? `<span class="ho pend">${ac.emerg.id === "nordo" ? "NORDO" : "EMERG"}</span>` : ""}${ho}</div>
    <div class="fs-row">
      <div class="fs-f"><i>BCN</i>${ac.sqk}</div>
      <div class="fs-f"><i>TYP</i>${ac.type}${ac.heavy ? "/H" : ""}</div>
      <div class="fs-f"><i>EQ</i>${ac.eq}</div>
    </div>
    <div class="fs-row">
      <div class="fs-f"><i>DEP</i>${dep}</div>
      <div class="fs-f"><i>DEST</i>${dst}</div>
      <div class="fs-f"><i>SPD</i>${spd || "—"}</div>
      <div class="fs-f"><i>ALT</i>${String(Math.round(ac.cruise / 100))}</div>
    </div>
    <div class="fs-rte"><i>RTE</i>${ac.route || ""}</div>
    ${ac.rmk ? `<div class="fs-rte"><i>RMK</i>${ac.rmk}</div>` : ""}
    ${edctStr}
    <div class="fs-ft">
      <span class="st">${stateLabel(ac)} · ${alt}→${asg}${ac.role === "dep" ? " · gate " + ac.gate : ""}${rwyOverrideStr}</span>
      ${nxt ? `<button class="hobtn" data-ho="${ac.id}" title="Flash this strip to ${nxt} (handoff)">H/O ${nxt}</button>` : ""}
    </div>
  </div>`;
}

function renderStrips() {
  const el = document.getElementById("stripbay");
  if (!G.running) { el.innerHTML = ""; return; }
  let html = "";
  const order = [G.playerPos, ...POSITIONS.filter(p => p !== G.playerPos)];
  for (const pos of order) {
    const list = G.aircraft.filter(a => a.owner === pos && !a.remove && a.state !== "out");
    html += `<h3><span${pos === G.playerPos ? ' class="me"' : ""}>${pos === G.playerPos ? "▶ " : ""}${pos} · ${POS_NAME[pos].toUpperCase()}</span><span>${list.length}</span></h3>`;
    for (const ac of list) html += stripHtml(ac, pos === G.playerPos);
  }
  el.innerHTML = html;
  el.querySelectorAll("[data-id]").forEach(s => {
    s.onclick = ev => {
      if (ev.target.classList.contains("hobtn")) return;
      G.selected = G.aircraft.find(a => a.id === +s.dataset.id) || null;
      renderStrips();
      document.getElementById("cmd").focus();
    };
  });
  el.querySelectorAll(".hobtn").forEach(b => {
    b.onclick = ev => {
      ev.stopPropagation();
      const ac = G.aircraft.find(a => a.id === +b.dataset.ho);
      if (ac) initiateHandoff(ac);
    };
  });
}

/* ---------------- what to say at this position ----------------
   A live cheat sheet: the exact instruction the aircraft in front of you
   is waiting for, with this session's runway and route filled in. */
function renderCheat() {
  const el = document.getElementById("cheat");
  if (!el || !G.running) return;
  const F = G.fac, P = G.playerPos;
  const sel = G.selected && !G.selected.remove ? G.selected : null;
  const depId = (sel && sel.rwy) ? sel.rwy.id : G.depRwy.id;
  const arrId = (sel && sel.rwy) ? sel.rwy.id : G.arrRwy.id;
  const depRoute = (F.taxi && F.taxi[depId]) ? F.taxi[depId].names : "";
  const arrRoute = (F.taxi && F.taxi["in_" + arrId]) ? F.taxi["in_" + arrId].names : "";
  const lines = {
    DEL: [
      [`cleared to [dest], [SID] departure then as filed, climb and maintain ${F.initAlt}, expect [ALT on strip], departure frequency ${depFreq(F)}, squawk [BCN]`, "the full clearance"],
      ["readback correct", "after they read it back, if it was right"],
      ["readback incorrect", "if they busted an item"],
      ["contact ground", "when they are ready to push"],
      ["monitor ground", "busy? they listen and wait for ground to call them"],
    ],
    GND: [
      ["pushback approved", "they are at the gate asking to push"],
      [`taxi runway ${depId} via ${depRoute}, hold short`, "departures. Just say \u201ctaxi\u201d and the route is filled in"],
      [`taxi to the gate via ${arrRoute}`, "arrivals off the runway"],
      ["monitor ground, I'll call you for taxi", "STOPS THEM CALLING. You initiate taxi in your order."],
      ["number 2", "sequence them so they stop calling"],
      ["give way to the company 737, then continue", "let one pass"],
      ["hold position / continue", "stop and restart"],
      ["contact tower", "once they are holding short"],
    ],
    TWR: [
      ["line up and wait", `runway ${depId}`],
      ["cleared for takeoff", `runway ${depId}`],
      ["cleared to land", `runway ${arrId}`],
      ["contact departure", "climbing through about 700 ft"],
      ["contact ground", "after they clear the runway"],
      ["go around", "if the runway is not going to be clear"],
    ],
    APP: [
      ["turn left heading 270, descend and maintain 4000", "vectors to the final"],
      ["reduce speed 210", "spacing"],
      [`cleared ILS runway ${arrId}`, "30 degrees or less, at or below 3000 by 10 miles"],
      ["contact tower", "established and inside 6 miles"],
      ["climb and maintain 12000, direct [exit fix]", "departures"],
      ["contact center", "above 4000 and 12 miles out"],
    ],
    CTR: [
      ["descend via", "arrivals on the STAR"],
      ["descend and maintain 11000", "manual descent"],
      ["contact approach", "by about 38 miles"],
      ["climb and maintain 23000, direct [exit fix]", "departures"],
      ["contact center", "leaving the sector"],
    ],
  }[P] || [];
  el.innerHTML =
    `<div class="lbl">WHAT ${P} SAYS &nbsp;<span class="dimtxt">RWY ${arrId} ARR / ${depId} DEP</span></div>` +
    (sel ? `<div class="cheatsel">${sel.cs}: <b>${pilotRequest(sel)}</b></div>` : "") +
    lines.map(([cmd, why]) =>
      `<div class="cheatrow" data-cmd="${escapeHtml(cmd)}"><code>${escapeHtml(cmd)}</code><i>${escapeHtml(why)}</i></div>`).join("");
  el.querySelectorAll(".cheatrow").forEach(r => r.onclick = () => {
    const box = document.getElementById("cmd");
    const cs = G.selected && !G.selected.remove ? G.selected.cs + " " : "";
    box.value = cs + r.dataset.cmd;
    box.focus();
  });
}

/* ---------------- landline coordination panel ----------------
   Pick who you are calling, then what you are calling about. The last
   exchange stays on screen so you can see what they gave you. */
let llTarget = null;
function renderIntercom() {
  const el = document.getElementById("intbtns");
  if (!G.running) { el.innerHTML = ""; return; }
  const others = POSITIONS.filter(p => p !== G.playerPos);
  if (!llTarget || llTarget === G.playerPos) llTarget = others[0];
  const last = (G.channels.INT || []).slice(-2);
  el.innerHTML =
    `<div class="llrow"><span class="lllbl">CALL</span>` +
    others.map(p => `<button class="llpos ${p === llTarget ? "on" : ""}" data-i="${p}">${p}</button>`).join("") +
    `</div>` +
    `<div class="llrow"><span class="lllbl">ABOUT</span></div>` +
    `<div class="llgrid">` +
    Object.entries(LL_REQUESTS).map(([k, v]) =>
      `<button class="llreq" data-r="${k}">${v.label}</button>`).join("") +
    `</div>` +
    (last.length ? `<div class="llog">${last.map(r =>
      `<div class="${r.cls}"><b>${escapeHtml(r.who)}:</b> ${escapeHtml(r.text)}</div>`).join("")}</div>` : "");
  el.querySelectorAll(".llpos").forEach(b => b.onclick = () => { llTarget = b.dataset.i; renderIntercom(); });
  el.querySelectorAll(".llreq").forEach(b => b.onclick = () => {
    intercom(llTarget, b.dataset.r);
    setTimeout(renderIntercom, 2600);
  });
}

/* ---------------- header ---------------- */
function renderHeader() {
  document.getElementById("clock").textContent = fmtClock(G.t) + "Z";
  document.getElementById("scScore").textContent = G.score;
  const r = ratingFor(career.pts);
  document.getElementById("scRating").textContent = career.sandbox ? r.id + "·SB" : r.id;
  document.getElementById("scPts").textContent = career.pts;
  if (G.running) {
    document.getElementById("facinfo").textContent =
      `${G.fac.icao} ${G.cfg.name} · ${ctrlCallsign(G.playerPos)} ${G.fac.freqs[G.playerPos]} · ARR ${G.arrRwy.id} DEP ${G.depRwy.id} · INFO ${G.atis.letter[0]}`;
    document.getElementById("txlabel").textContent = `${G.fac.freqs[G.playerPos]} TX>`;
  }
}

/* ---------------- engine hooks ---------------- */
G.hooks.log = (chan, who, cls, text) => {
  if (chan === "INT") setTimeout(renderIntercom, 30);
  if (chan === activeTab) renderLog();
  else {
    const tab = document.querySelector(`.ftab[data-t="${chan}"]`);
    if (tab) tab.classList.add("unread");
  }
};
G.hooks.strips = () => { renderStrips(); renderCheat(); };
G.hooks.score = () => { syncCareer(); renderHeader(); };
/* A transmission the grammar couldn't fully account for can be waiting on
   the LLM endpoint for up to a couple seconds with nothing on screen
   changing in the meantime -- easy to mistake for the game having hung.
   Counted rather than boolean since more than one transmission can be
   in flight to the endpoint at once. */
let aiPendingCount = 0;
G.hooks.aiPending = on => {
  aiPendingCount = Math.max(0, aiPendingCount + (on ? 1 : -1));
  const btn = document.getElementById("btnSend");
  if (btn) btn.textContent = aiPendingCount > 0 ? "..." : "XMIT";
};

/* ---------------- SOPs ---------------- */
function sopHtml() {
  const F = G.fac, cfg = G.cfg;
  const posRows = {
    DEL: `<tr><td>Clearance format</td><td>"[callsign], cleared to [destination] airport, [SID] departure then as filed,
      climb and maintain <b>${F.initAlt}</b>, expect [cruise from the strip's ALT field] one zero minutes
      after departure, departure frequency <b>${F.freqs.APP}</b>, squawk [BCN from the strip]."</td></tr>
      <tr><td>Strip fields</td><td><b>BCN</b> is the squawk. <b>ALT</b> is the requested cruise, which the crew
      reads back as the "expect" altitude. <b>RTE</b> is the filed route.</td></tr>
      <tr><td>Verify readback</td><td>Pilots misread a squawk or altitude about 1 in 4 times. Catch it with
      <code>readback incorrect</code> or by restating the item; confirm good ones with <code>readback correct</code>.</td></tr>
      <tr><td>Then</td><td>The strip pushes to Ground automatically when the pilot is told the readback is correct.</td></tr>`,
    GND: `<tr><td>Pushback</td><td><code>pushback approved</code> when they call from the gate.</td></tr>
      <tr><td>Taxi</td><td><code>taxi</code> sends departures to runway <b>${G.depRwy.id}</b> via ${F.taxi[G.depRwy.id] ? F.taxi[G.depRwy.id].names : ""},
      hold short. Arrivals: <code>taxi</code> sends them to the gate.</td></tr>
      <tr><td>Handoff</td><td><code>contact tower</code> (or <code>ct</code>) once they report holding short.</td></tr>`,
    TWR: `<tr><td>Departures</td><td><code>line up and wait</code> / <code>cleared for takeoff</code> on runway <b>${G.depRwy.id}</b>.
      Ship to departure (<code>contact departure</code>) passing about 700 ft.</td></tr>
      <tr><td>Arrivals</td><td><code>cleared to land</code> runway <b>${G.arrRwy.id}</b>; they go around at 1 nm without it.
      After rollout: <code>contact ground</code>.</td></tr>
      <tr><td>Runway protection</td><td>${G.arrRwy.id === G.depRwy.id
        ? "Single-runway ops: one aircraft on the runway at a time, no takeoff clearance with an arrival inside about 6 nm."
        : `Independent parallel ops: ${G.arrRwy.id} landings, ${G.depRwy.id} departures.`}</td></tr>`,
    APP: `<tr><td>Arrivals</td><td>Descend to 3,000 to 4,000, vector to intercept the runway <b>${G.arrRwy.id}</b> localizer
      at 30 degrees or less, at or below 3,000 by 10 nm final, then <code>cleared ILS</code>.
      Established and inside 6 nm: <code>contact tower</code>.</td></tr>
      <tr><td>Departures</td><td>Climb them (initial ${F.initAlt}, then higher), <code>direct [exit fix]</code>,
      and <code>contact center</code> above 4,000 and 12 nm out.</td></tr>
      <tr><td>Separation</td><td>3 nm or 1,000 ft; 2.5 nm allowed when both are established on final.</td></tr>`,
    CTR: `<tr><td>Arrivals</td><td><code>descend via</code> the STAR (brings them to 11,000), then
      <code>contact approach</code> by 38 nm from the field.</td></tr>
      <tr><td>Departures</td><td>Climb to FL230 (<code>c 230</code>), <code>direct [exit]</code>, and
      <code>contact center</code> to hand them to ${F.nextCenter} beyond about 50 nm.</td></tr>`,
  };
  return `
    <button class="close" onclick="document.getElementById('sop').classList.remove('open')">CLOSE</button>
    <h2>${F.icao} STANDARD OPERATING PROCEDURES</h2>
    <p><b>${F.apName}</b> · ${F.artcc} ${F.artccName} · TRACON: ${F.tracon}</p>
    <h4>CURRENT CONFIGURATION · ${cfg.name.toUpperCase()} · INFORMATION ${G.atis.letter.toUpperCase()}</h4>
    <table>
      <tr><td>Runways</td><td>Landing <b>${G.arrRwy.id}</b> · Departing <b>${G.depRwy.id}</b></td></tr>
      <tr><td>Weather</td><td>Wind ${String(G.atis.windDir).padStart(3, "0")}/${String(G.atis.windSpd).padStart(2, "0")},
        altimeter ${(+G.atis.qnh / 100).toFixed(2)}, ${G.atis.sky}</td></tr>
      <tr><td>Initial altitude</td><td><b>${F.initAlt} ft</b> for all departures</td></tr>
      <tr><td>Departure frequency</td><td><b>${F.freqs.APP}</b> (${F.tracon})</td></tr>
      <tr><td>Frequencies</td><td>DEL ${F.freqs.DEL} · GND ${F.freqs.GND} · TWR ${F.freqs.TWR} · APP ${F.freqs.APP} · CTR ${F.freqs.CTR}</td></tr>
    </table>
    <h4>DEPARTURE PROCEDURES (SIDs) IN USE</h4>
    <table>${F.sids.map(s => `<tr><td>${s.name}</td><td>exit gates: ${s.exits.join(", ")}</td></tr>`).join("")}</table>
    <h4>ARRIVALS (STARs)</h4>
    <p class="dimtxt">${F.stars.join(" · ")} via entry fixes ${F.entryFixes.join(", ")}. Arrivals check on descending via the STAR.</p>
    <h4>YOUR POSITION · ${ctrlCallsign(G.playerPos)} (${POS_NAME[G.playerPos].toUpperCase()})</h4>
    <table>${posRows[G.playerPos]}</table>
    <p class="dimtxt">Every value above is live for this session. The strip shows each aircraft's filed SID, exit fix,
    destination and assigned squawk; the clearance you issue must match the strip.</p>`;
}

/* ---------------- session boot ---------------- */
function beginSession(facIdx, pos, density) {
  lastSynced = 0;
  startSession(facIdx, pos, density);
  activeTab = pos;
  setView(pos === "DEL" || pos === "GND" ? "ASDX" : pos === "TWR" ? "CAB" : "STARS");
  V.range = pos === "CTR" ? 60 : 45;
  V.pan = { x: 0, y: 0 }; V.asdxPan = { x: 0, y: 0 }; V.cabPan = { x: 0, y: 0 };
  renderTabs(); renderLog(); renderStrips(); renderIntercom(); renderHeader(); renderCheat();
  const ph = {
    DEL: "DAL123 cleared to Boston, DEEZZ5 departure then as filed, climb and maintain 5000, departure 127.4, squawk 2345 · then: readback correct",
    GND: "DAL123 pushback approved · taxi · hold position · contact tower",
    TWR: "DAL123 line up and wait · cleared for takeoff · cleared to land · contact departure / ground",
    APP: "DAL123 t l 270 d 40 s 210 · cleared ILS · contact tower / center",
    CTR: "DAL123 descend via · d 110 · direct LENDY · contact approach",
  }[pos];
  document.getElementById("cmd").placeholder = ph;
  sysLog("Read the SOP (top right) for this session's runways, initial altitude, departure frequency and SIDs.");
  sysLog("Voice: press and HOLD the PTT button (or hold Tab) while you speak, release to transmit. Chrome or Edge, allow the microphone. Typing works too.");
}

function endSession() {
  if (G.running && G.t > 120 && typeof sessionDebrief === "function") {
    const d = sessionDebrief();
    document.getElementById("debriefcard").innerHTML = `
      <h2>POSITION RELIEF BRIEFING</h2>
      <p class="dimtxt">${G.fac.icao} ${ctrlCallsign(G.playerPos)} · ${G.cfg.name} · ${G.arrRwy.id} arrivals, ${G.depRwy.id} departures</p>
      <table>${d.rows.map(([k, v]) => `<tr><td>${k}</td><td><b>${v}</b></td></tr>`).join("")}</table>
      <h4>ASSESSMENT</h4>
      <p><b style="color:${/Unsafe/.test(d.grade) ? "var(--red)" : "var(--accent)"}">${d.grade}</b></p>
      <div class="menurow">
        <button class="bigbtn" onclick="document.getElementById('debrief').classList.remove('open')">CLOSE</button>
      </div>`;
    document.getElementById("debrief").classList.add("open");
  }
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
  else if (e.key.length === 1 && /[a-z0-9]/i.test(e.key) && !e.ctrlKey && !e.metaKey) cmdEl.focus();
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
document.getElementById("btnTdls").onclick = () => {
  if (!G.running) return;
  const el = document.getElementById("tdlscard");
  const list = G.aircraft.filter(x => x.role === "dep" && x.state === "gate" && !x.remove);
  const F = G.fac;
  el.innerHTML = `
    <button class="close" onclick="document.getElementById('tdls').classList.remove('open')">CLOSE</button>
    <h2>vTDLS · PRE-DEPARTURE CLEARANCE</h2>
    <p class="dimtxt">Uplink the filed clearance straight to the flight deck instead of reading it on frequency.
    The crew accepts it, squawks, and calls Ground. This is how most departures at a busy field are actually
    cleared; keep the voice clearance for anything non-standard.</p>
    ${list.length ? list.map(x => `
      <div class="tdlsrow">
        <div>
          <b>${x.cs}</b> <span class="dimtxt">${x.type} · gate ${x.gate} · CID ${x.cid}</span><br>
          <span class="dimtxt">CLRD TO <b>${x.dest.icao}</b> VIA <b>${x.sid.name}</b> · MAINT <b>${F.initAlt}</b>
          · EXP <b>${x.cruise}</b> · DPFRQ <b>${F.freqs.APP}</b> · SQ <b>${x.sqk}</b></span>
        </div>
        <button data-pdc="${x.id}">SEND PDC</button>
      </div>`).join("")
      : `<p class="dimtxt">No departures awaiting clearance at the gate right now.</p>`}`;
  el.querySelectorAll("[data-pdc]").forEach(b => b.onclick = () => {
    const ac = G.aircraft.find(x => x.id === +b.dataset.pdc);
    if (ac && sendPDC(ac)) { b.textContent = "SENT"; b.disabled = true; }
  });
  document.getElementById("tdls").classList.add("open");
};
document.getElementById("btnTmu").onclick = () => {
  if (!G.running) return;
  const el = document.getElementById("tmucard");
  const active = [];
  if (TMU.groundStop) active.push([`GROUND STOP · ${TMU.groundStop.dest}`,
    `Due to ${TMU.groundStop.reason}. Ends ${edctClock(TMU.groundStop.until)}Z. Hold all ${TMU.groundStop.dest} departures at the gate.`]);
  if (TMU.gdp) active.push(["GROUND DELAY PROGRAMME",
    `In effect until ${edctClock(TMU.gdp.until)}Z. Every departure has a wheels-up time; nobody rolls before theirs.`]);
  if (TMU.mit) active.push([`${TMU.mit.miles} MILES IN TRAIL · ${TMU.mit.fix}`,
    `Until ${edctClock(TMU.mit.until)}Z. Space departures over ${TMU.mit.fix} accordingly.`]);
  const deps = G.aircraft.filter(x => x.role === "dep" && !x.remove)
    .map(x => ({ x, e: edctOf(x) }))
    .filter(o => o.e)
    .sort((p, q) => p.e - q.e);
  el.innerHTML = `
    <button class="close" onclick="document.getElementById('tmu').classList.remove('open')">CLOSE</button>
    <h2>TRAFFIC MANAGEMENT</h2>
    <p class="dimtxt">Current time <b>${edctClock(G.t)}Z</b>. These initiatives are enforced: an aircraft under a ground
    stop or before its wheels-up time will refuse pushback and takeoff, and the AI tower will not roll it either.</p>
    <h4>ACTIVE INITIATIVES</h4>
    ${active.length ? `<table>${active.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`
                    : `<p class="dimtxt">None. Normal operations.</p>`}
    ${deps.length ? `<h4>WHEELS-UP TIMES</h4>
      <table><tr><td><b>FLIGHT</b></td><td><b>DEST</b></td><td><b>EDCT</b></td><td><b>STATUS</b></td></tr>
      ${deps.map(({ x, e }) => `<tr><td>${x.cs}</td><td>${x.dest.icao}</td><td>${edctClock(e)}Z</td>
        <td style="color:${G.t < e ? "var(--orange)" : "var(--accent)"}">${G.t < e
          ? "holding, " + Math.max(1, Math.round((e - G.t) / 60)) + " min"
          : "released, may go"}</td></tr>`).join("")}</table>` : ""}
    <p class="dimtxt">Ask any aircraft <code>say your EDCT</code> and they will read their wheels-up time back to you.
    Clearance Delivery issues it with the clearance, and it rides along on a PDC.</p>`;
  document.getElementById("tmu").classList.add("open");
};
document.getElementById("btnSop").onclick = () => {
  if (!G.running) return;
  document.getElementById("sopcard").innerHTML = sopHtml();
  document.getElementById("sop").classList.add("open");
};
document.getElementById("btnMenu").onclick = endSession;
document.querySelectorAll("#viewtabs button").forEach(b => b.onclick = () => setView(b.dataset.v));

/* ---------------- help ---------------- */
document.getElementById("btnHelp").onclick = () => {
  const F = G.fac || FACILITIES[0];
  document.getElementById("helpcard").innerHTML = `
    <button class="close" onclick="document.getElementById('help').classList.remove('open')">CLOSE</button>
    <h2>WORKING THE POSITIONS</h2>
    <p class="dimtxt">Address aircraft by callsign, typed or spoken. For voice: press and HOLD the PTT button
    (or hold Tab) while you talk, release to transmit; use Chrome or Edge and allow the microphone.
    Click a target, its datablock, or a strip to select it and you can drop the callsign.
    Pilots also understand plain talk: <code>standby</code>, <code>say again</code>, <code>roger</code>.
    Chain instructions freely. Right-click a frequency tab to listen in on an AI position's frequency.
    Strips flow DEL to GND to TWR to APP to CTR and back down for arrivals. The SOP button lists this
    session's runways, initial altitude, departure frequency and SIDs: everything you need to issue
    correct clearances.</p>
    <h4>CLEARANCE DELIVERY (S1)</h4>
    <table>
      <tr><td>full IFR clearance</td><td>"DAL123 cleared to Boston, DEEZZ5 departure then as filed, climb and maintain 5000,
        departure ${F.freqs.APP}, squawk 2345". The strip shows the filed SID, destination and squawk.</td></tr>
      <tr><td>readback correct / rbc</td><td>Bless the readback. Listen closely: about 1 in 4 pilots busts a squawk or altitude.</td></tr>
      <tr><td>readback incorrect</td><td>Or restate the item ("squawk 2345") to correct them.</td></tr>
    </table>
    <h4>GROUND (S1)</h4>
    <table>
      <tr><td>pushback approved / pa</td><td>Approve push from the gate</td></tr>
      <tr><td>taxi / tx</td><td>Taxi to the departure runway, or to the gate for arrivals</td></tr>
      <tr><td>hold position / continue</td><td>Stop and restart a taxiing aircraft</td></tr>
      <tr><td>contact tower / ct</td><td>Ship a hold-short departure to tower</td></tr>
    </table>
    <h4>TOWER (S2)</h4>
    <table>
      <tr><td>line up and wait / luaw</td><td>Onto the runway</td></tr>
      <tr><td>cleared for takeoff / cto</td><td>Roll a departure. Mind the final!</td></tr>
      <tr><td>cleared to land / ctl</td><td>Arrivals go around at 1 nm if you forget</td></tr>
      <tr><td>contact departure / cd · contact ground / cg</td><td>Ship climbing departures and rollout arrivals</td></tr>
      <tr><td>go around / ga</td><td>Break off an approach</td></tr>
    </table>
    <h4>APPROACH / DEPARTURE (S3)</h4>
    <table>
      <tr><td>turn left heading 270 / t l 270</td><td>Vectors. <code>d 40</code> descend 4,000 · <code>c 80</code> climb 8,000 · <code>s 210</code> speed</td></tr>
      <tr><td>cleared ILS / ils</td><td>Intercept at 30 degrees or less, at or below 3,000 by 10 nm final, or they refuse or go around</td></tr>
      <tr><td>contact tower / ct · contact center / cc</td><td>Handoffs. 2.5 nm in-trail is legal on final, otherwise 3 nm / 1,000 ft</td></tr>
    </table>
    <h4>CENTER (C1)</h4>
    <table>
      <tr><td>descend via / dvs</td><td>Arrivals descend via their STAR</td></tr>
      <tr><td>d 110 · direct FIX · contact approach / cap</td><td>Feed arrivals to the TRACON by about 38 nm</td></tr>
      <tr><td>c 230 · contact center / cc</td><td>Climb departures and ship them to the next center</td></tr>
    </table>
    <p class="dimtxt">Displays are modeled on CRC's: STARS terminal radar, ASDE-X surface radar, and the top-down
    Tower Cab. Wheel zooms, dragging pans, double-click recenters. Ratings: S1, then S2 at 20 pts, S3 at 50, C1 at 90,
    per <a href="https://vatsim.net/docs/basics/becoming-a-controller/" target="_blank" style="color:var(--cyan)">VATSIM's rating ladder</a>.
    <b>P</b> pauses · 1×/2×/4× sim rate · landlines call the AI positions · MEDEVAC flights deserve priority.</p>`;
  document.getElementById("help").classList.add("open");
};

/* ---------------- flight plan window (ctrl+click a target) ---------------- */
function openFlightPlan(ac) {
  if (!ac) return;
  G.selected = ac;
  renderStrips();
  const dep = ac.role === "dep" ? G.fac.icao : ac.origin.icao;
  const dst = ac.role === "dep" ? ac.dest.icao : G.fac.icao;
  document.getElementById("fpcard").innerHTML = `
    <button class="close" onclick="document.getElementById('fp').classList.remove('open')">CLOSE</button>
    <h2>${ac.cs} · ${ac.cid}</h2>
    <div class="fpgrid">
      <div class="fpf"><i>AID</i><b>${ac.cs}</b></div>
      <div class="fpf"><i>CID</i><b>${ac.cid}</b></div>
      <div class="fpf"><i>BCN</i><b>${ac.sqk}</b></div>
      <div class="fpf"><i>TYP</i><b>${ac.type}${ac.heavy ? "/H" : ""}</b></div>
      <div class="fpf"><i>EQ</i><b>${ac.eq}</b></div>
      <div class="fpf"><i>DEP</i><b>${dep}</b></div>
      <div class="fpf"><i>DEST</i><b>${dst}</b></div>
      <div class="fpf"><i>SPD</i><b>${ac.assignedSpd || "—"}</b></div>
      <div class="fpf"><i>ALT</i><b>${Math.round(ac.cruise / 100)}</b></div>
    </div>
    <div class="fprte"><i>RTE</i>${ac.route || ""}</div>
    <div class="fprte"><i>RMK</i>${ac.rmk || ""}</div>
    <p class="dimtxt">Status: ${stateLabel(ac)} · with ${ac.owner}${ac.hoTo ? ` · H/O ${ac.hoTo}${ac.hoAccepted ? " accepted" : " pending"}` : ""}
    ${ac.alt > 50 ? ` · ${Math.round(ac.alt)} ft · ${Math.round(ac.gs())} kt` : ""}</p>`;
  document.getElementById("fp").classList.add("open");
}

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

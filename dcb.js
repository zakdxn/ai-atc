/* =====================================================================
   AI ATC: the ASDE-X Display Control Bar and its menu tree, modeled on
   CRC's. Every button here does something:

     DEFAULT      recentre and reset the zoom
     PREF         save / recall display preferences
     DAY/NITE     colour scheme
     BRITE        brightness of map, pavement and datablocks
     CHAR SIZE    datablock text size
     SAFETY LOGIC tower config, runway config, closed runways, alert
                  repositioning, alert volume, track alert inhibit
     TOOLS        history-line length, menu bar position
     TEMP DATA    closed (red) and restricted (yellow) areas, free text
     DB AREA      datablock trait areas
     DB EDIT      full / partial datablocks, altitude on/off
     DB ON/OFF    show or hide all datablocks (F6)

   Closed runways and occupied runways raise real safety-logic alerts:
   the offending aircraft is circled, everyone else drops to a partial
   datablock, and the alert is spoken and written into the alert area.
   ===================================================================== */
"use strict";

const DCB = {
  menu: null,               // open submenu id
  mode: null,               // active drawing/picking mode
  pending: [],              // points collected while drawing an area
  textBuf: null,            // free-text entry buffer
  hits: [],                 // clickable rectangles for the current frame
  /* display state */
  night: false,
  brite: 1,
  charSize: 11,
  dbOn: true,
  dbMode: "full",           // full | partial
  dbAlt: true,
  historyLen: 5,
  barTop: true,
  /* operational state */
  closedRwys: new Set(),
  inhibited: new Set(),     // aircraft ids exempt from safety logic
  temp: [],                 // {kind:'closed'|'restricted'|'text', pts|p, text}
  dbAreas: [],              // {pts, trait}
  alertPos: null,           // world point for the alert box
  alerts: [],               // {t, text, acId}
  volume: 0.6,
  prefs: {},
};

/* ---------- alerts ---------- */
function sfAlert(text, acId, spoken) {
  const now = (typeof G !== "undefined" && G.t) || 0;
  if (DCB.alerts.some(a => a.text === text && now - a.t < 25)) return;
  DCB.alerts.push({ t: now, text, acId });
  while (DCB.alerts.length > 4) DCB.alerts.shift();
  if (typeof beep === "function") beep(760, 0.16, 2, 0.1, 0.05 * DCB.volume);
  if (spoken && typeof TTS !== "undefined") TTS.say(spoken, { v: 1, rate: 1.05, pitch: 0.6 });
  if (typeof xmit === "function") xmit(G.playerPos, "SAFETY", "warn", text, null);
}
function isRwyClosed(id) {
  if (DCB.closedRwys.has(id)) return true;
  for (const r of (G.fac.runways || [])) {
    if ((r.id === id && DCB.closedRwys.has(r.recip)) ||
        (r.recip === id && DCB.closedRwys.has(r.id))) return true;
  }
  return false;
}

/* runs each tick from the engine */
function safetyLogicScan() {
  if (!G.running || !G.fac.runways) return;
  const arr = G.arrRwy, dep = G.depRwy;
  /* closed runway with someone on final or rolling */
  for (const ac of G.aircraft) {
    if (DCB.inhibited.has(ac.id) || ac.remove) continue;
    if (ac.role === "arr" && ac.app === "established" && isRwyClosed(arr.id)) {
      const g = finalGeom(ac, arr);
      if (g.along < 5 && g.along > 0.4) {
        sfAlert(`RWY ${arr.id} ${ac.cs} RUNWAY CLOSED GO AROUND`, ac.id,
          `Warning. Runway ${rwyWords(arr.id)}. Go around.`);
        if (g.along < 2.5 && ac.app) doGoAround(ac, "the runway is closed");
      }
    }
    if (ac.role === "dep" && ["lineup", "rolling"].includes(ac.state) && isRwyClosed(dep.id)) {
      sfAlert(`RWY ${dep.id} ${ac.cs} RUNWAY CLOSED`, ac.id, `Warning. Runway ${rwyWords(dep.id)} is closed.`);
    }
  }
  /* runway occupied with an arrival on short final */
  const onRwy = G.aircraft.filter(a => !a.remove && !DCB.inhibited.has(a.id) &&
    ["lineup", "rolling", "landedRoll"].includes(a.state));
  if (onRwy.length) {
    for (const ac of G.aircraft) {
      if (ac.remove || DCB.inhibited.has(ac.id)) continue;
      if (ac.role !== "arr" || ac.app !== "established") continue;
      const g = finalGeom(ac, arr);
      if (g.along < 2.2 && (arr.id === dep.id || onRwy.some(o => o.state === "landedRoll"))) {
        sfAlert(`RWY ${arr.id} ${ac.cs} RUNWAY OCCUPIED GO AROUND`, ac.id,
          `Warning. Runway ${rwyWords(arr.id)}. Go around.`);
      }
    }
  }
  DCB.alerts = DCB.alerts.filter(a => G.t - a.t < 30);
}

/* ---------- menu definitions ---------- */
function dcbTop() {
  return [
    { id: "RANGE", label: `RANGE\n${V.asdxRange.toFixed(1)}` },
    { id: "DEFAULT", label: "DEFAULT" },
    { id: "PREF", label: "PREF" },
    { id: "DAYNITE", label: DCB.night ? "DAY/<b>NITE</b>" : "<b>DAY</b>/NITE" },
    { id: "BRITE", label: "BRITE" },
    { id: "CHAR", label: "CHAR\nSIZE" },
    { id: "SAFETY", label: `SAFETY\nLOGIC` },
    { id: "TOOLS", label: "TOOLS" },
    { id: "TEMP", label: "TEMP\nDATA" },
    { id: "DBAREA", label: "DB\nAREA" },
    { id: "DBEDIT", label: "DB\nEDIT" },
    { id: "DBONOFF", label: `DB\n${DCB.dbOn ? "ON" : "OFF"}` },
  ];
}
function dcbSub(id) {
  switch (id) {
    case "SAFETY": return [
      { id: "S_RWYCFG", label: `RWY CFG\n${G.arrRwy.id}/${G.depRwy.id}` },
      { id: "S_CLOSE", label: "CLOSED\nRUNWAY" },
      { id: "S_ALERTPOS", label: "ALERT\nREPOSITION" },
      { id: "S_INHIBIT", label: "TRACK ALERT\nINHIBIT" },
      { id: "S_VOLTEST", label: "VOLUME\nTEST" },
      { id: "S_VOL", label: `VOLUME\n${Math.round(DCB.volume * 10)}` },
      { id: "DONE", label: "DONE" },
    ];
    case "S_CLOSE": return [
      ...G.fac.runways.flatMap(r => [
        { id: "C_" + r.id, label: `${r.id}\n${isRwyClosed(r.id) ? "CLOSED" : "OPEN"}` },
      ]),
      { id: "DONE", label: "DONE" },
    ];
    case "TEMP": return [
      { id: "T_CLOSED", label: "DEFINE\nCLOSED AREA" },
      { id: "T_RESTR", label: "DEFINE\nRESTRICTED" },
      { id: "T_TEXT", label: "DEFINE\nTEXT" },
      { id: "T_DEL", label: "DELETE" },
      { id: "T_CLEAR", label: "CLEAR\nALL" },
      { id: "DONE", label: "DONE" },
    ];
    case "DBEDIT": return [
      { id: "E_FULL", label: `FULL${DCB.dbMode === "full" ? " *" : ""}` },
      { id: "E_PART", label: `PARTIAL${DCB.dbMode === "partial" ? " *" : ""}` },
      { id: "E_ALT", label: `ALT\n${DCB.dbAlt ? "ON" : "OFF"}` },
      { id: "DONE", label: "DONE" },
    ];
    case "DBAREA": return [
      { id: "A_DEF", label: "DEFINE\nTRAIT AREA" },
      { id: "A_DEL", label: "DELETE\nONE AREA" },
      { id: "DONE", label: "DONE" },
    ];
    case "TOOLS": return [
      { id: "O_HIST", label: `HISTORY\n${DCB.historyLen}` },
      { id: "O_BAR", label: `MENU BAR\n${DCB.barTop ? "TOP" : "BOTTOM"}` },
      { id: "DONE", label: "DONE" },
    ];
    case "BRITE": return [
      { id: "B_DN", label: "BRITE\n−" },
      { id: "B_UP", label: "BRITE\n+" },
      { id: "DONE", label: `BRITE ${Math.round(DCB.brite * 100)}%` },
    ];
    case "CHAR": return [
      { id: "H_DN", label: "CHAR\n−" },
      { id: "H_UP", label: "CHAR\n+" },
      { id: "DONE", label: `SIZE ${DCB.charSize}` },
    ];
    case "PREF": return [
      { id: "P_SAVE", label: "SAVE AS\nPREF" },
      { id: "P_LOAD", label: "RECALL\nPREF" },
      { id: "DONE", label: "DONE" },
    ];
    default: return [];
  }
}

/* ---------- actions ---------- */
function dcbAction(id) {
  const T = id;
  if (T === "DONE") { DCB.menu = null; DCB.mode = null; DCB.pending = []; return; }
  if (dcbSub(T).length) { DCB.menu = T; return; }

  switch (T) {
    case "RANGE": V.asdxRange = V.asdxRange > 3 ? 0.8 : V.asdxRange * 1.35; break;
    case "DEFAULT": V.asdxPan = { x: 0, y: 0 }; V.asdxRange = 1.6; break;
    case "DAYNITE": DCB.night = !DCB.night; break;
    case "DBONOFF": DCB.dbOn = !DCB.dbOn; break;
    case "B_UP": DCB.brite = Math.min(1.6, DCB.brite + 0.15); break;
    case "B_DN": DCB.brite = Math.max(0.4, DCB.brite - 0.15); break;
    case "H_UP": DCB.charSize = Math.min(17, DCB.charSize + 1); break;
    case "H_DN": DCB.charSize = Math.max(8, DCB.charSize - 1); break;
    case "E_FULL": DCB.dbMode = "full"; break;
    case "E_PART": DCB.dbMode = "partial"; break;
    case "E_ALT": DCB.dbAlt = !DCB.dbAlt; break;
    case "O_HIST": DCB.historyLen = DCB.historyLen >= 10 ? 0 : DCB.historyLen + 5; break;
    case "O_BAR": DCB.barTop = !DCB.barTop; break;
    case "S_VOL": DCB.volume = DCB.volume >= 1 ? 0 : DCB.volume + 0.2; break;
    case "S_VOLTEST": sfAlert("TEST MESSAGE", null, "Test message."); break;
    case "S_ALERTPOS": DCB.mode = "alertpos"; break;
    case "S_INHIBIT": DCB.mode = "inhibit"; break;
    case "S_RWYCFG": {
      /* rotate through the facility's configurations */
      const i = G.fac.configs.indexOf(G.cfg);
      const next = G.fac.configs[(i + 1) % G.fac.configs.length];
      G.cfg = next;
      G.arrRwy = resolveRwy(next.arr); G.depRwy = resolveRwy(next.dep);
      if (typeof prepareRoutes === "function") prepareRoutes(G.fac, G.arrRwy.id, G.depRwy.id);
      xmit(G.playerPos, "SYS", "sys", `Runway configuration changed: landing ${G.arrRwy.id}, departing ${G.depRwy.id}.`, null);
      break;
    }
    case "T_CLOSED": DCB.mode = "draw_closed"; DCB.pending = []; break;
    case "T_RESTR": DCB.mode = "draw_restricted"; DCB.pending = []; break;
    case "T_TEXT": {
      const t = prompt("Define text (use | to split two lines):", "");
      if (t) { DCB.textBuf = t; DCB.mode = "place_text"; }
      break;
    }
    case "T_DEL": DCB.mode = "del_temp"; break;
    case "T_CLEAR": DCB.temp = []; break;
    case "A_DEF": DCB.mode = "draw_dbarea"; DCB.pending = []; break;
    case "A_DEL": DCB.mode = "del_dbarea"; break;
    case "P_SAVE":
      DCB.prefs = { night: DCB.night, brite: DCB.brite, charSize: DCB.charSize,
                    range: V.asdxRange, pan: { ...V.asdxPan }, dbMode: DCB.dbMode, dbAlt: DCB.dbAlt };
      try { localStorage.setItem("aiAtcAsdxPref", JSON.stringify(DCB.prefs)); } catch (e) {}
      xmit(G.playerPos, "SYS", "sys", "ASDE-X preference saved.", null);
      break;
    case "P_LOAD": {
      let p = DCB.prefs;
      try { p = JSON.parse(localStorage.getItem("aiAtcAsdxPref")) || p; } catch (e) {}
      if (p && p.brite) {
        DCB.night = p.night; DCB.brite = p.brite; DCB.charSize = p.charSize;
        DCB.dbMode = p.dbMode; DCB.dbAlt = p.dbAlt;
        V.asdxRange = p.range; V.asdxPan = { ...p.pan };
      }
      break;
    }
    default:
      if (T.startsWith("C_")) {                 // close / open a runway
        const id = T.slice(2);
        if (DCB.closedRwys.has(id)) DCB.closedRwys.delete(id);
        else DCB.closedRwys.add(id);
        const closed = DCB.closedRwys.has(id);
        xmit(G.playerPos, "SYS", closed ? "warn" : "sys",
          `Runway ${id} ${closed ? "CLOSED" : "reopened"}.`, null);
      }
  }
}

/* ---------- rendering ---------- */
function drawDCBBar() {
  DCB.hits = [];
  const items = DCB.menu ? dcbSub(DCB.menu) : dcbTop();
  const H = 40, y = DCB.barTop ? 0 : V.h - H;
  ctx.fillStyle = "#20242a";
  ctx.fillRect(0, y, V.w, H);
  ctx.font = mono(9);
  ctx.textBaseline = "alphabetic";
  let x = 4;
  for (const it of items) {
    const lines = it.label.replace(/<\/?b>/g, "").split("\n");
    const wNeed = Math.max(54, ...lines.map(l => ctx.measureText(l).width + 14));
    if (x + wNeed > V.w - 4) break;
    const active = DCB.menu === it.id ||
      (DCB.mode && DCB.mode.includes(it.id.slice(2).toLowerCase()));
    ctx.fillStyle = active ? "#4a5560" : "#3a3f47";
    ctx.fillRect(x, y + 4, wNeed - 3, H - 8);
    ctx.fillStyle = it.id === "DONE" ? "#e0c060" : "#cfd4da";
    lines.forEach((l, i) => ctx.fillText(l, x + 6, y + (lines.length > 1 ? 18 : 24) + i * 10));
    DCB.hits.push({ x, y: y + 4, w: wNeed - 3, h: H - 8, id: it.id });
    x += wNeed;
  }
  ctx.font = mono(11);
}

/* temp data, alert area and the mode prompt */
function drawDCBOverlays(W2S) {
  /* closed / restricted areas and free text */
  for (const t of DCB.temp) {
    if (t.kind === "text") {
      const [x, y] = W2S(t.p);
      ctx.fillStyle = "#e8e8e8";
      ctx.font = mono(DCB.charSize);
      t.text.split("|").forEach((l, i) => ctx.fillText(l, x + 4, y + 4 + i * (DCB.charSize + 2)));
      ctx.font = mono(11);
      continue;
    }
    const col = t.kind === "closed" ? "#ff3030" : "#e8c030";
    ctx.strokeStyle = col;
    ctx.fillStyle = col + "33";
    ctx.beginPath();
    t.pts.forEach((p, i) => { const [x, y] = W2S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  /* datablock trait areas */
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#5a8fb0";
  for (const a of DCB.dbAreas) {
    ctx.beginPath();
    a.pts.forEach((p, i) => { const [x, y] = W2S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.stroke();
  }
  ctx.setLineDash([]);
  /* in-progress drawing */
  if (DCB.pending.length) {
    ctx.strokeStyle = "#ffd75e";
    ctx.beginPath();
    DCB.pending.forEach((p, i) => { const [x, y] = W2S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    for (const p of DCB.pending) {
      const [x, y] = W2S(p);
      ctx.fillStyle = "#ffd75e";
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }
  /* closed-runway X marks */
  for (const r of G.fac.runways) {
    for (const [id, pt] of [[r.id, r.thr], [r.recip, r.end]]) {
      if (!DCB.closedRwys.has(id)) continue;
      const [x, y] = W2S(pt);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 8); ctx.lineTo(x + 8, y + 8);
      ctx.moveTo(x + 8, y - 8); ctx.lineTo(x - 8, y + 8);
      ctx.stroke(); ctx.lineWidth = 1;
    }
  }
  /* alert area */
  if (DCB.alerts.length) {
    const p = DCB.alertPos ? W2S(DCB.alertPos) : [V.w - 300, V.h - 120];
    const w = 290, h = 16 + DCB.alerts.length * 15;
    ctx.fillStyle = "rgba(10,20,40,.85)";
    ctx.strokeStyle = "#4a90d0";
    ctx.fillRect(p[0], p[1], w, h);
    ctx.strokeRect(p[0], p[1], w, h);
    ctx.fillStyle = "#ff6060";
    ctx.font = mono(11);
    DCB.alerts.forEach((a, i) => ctx.fillText(a.text.slice(0, 40), p[0] + 8, p[1] + 16 + i * 15));
  }
  /* mode prompt */
  if (DCB.mode) {
    const msg = {
      draw_closed: "Left-click to outline a CLOSED area, middle-click to finish",
      draw_restricted: "Left-click to outline a RESTRICTED area, middle-click to finish",
      draw_dbarea: "Left-click to outline a datablock trait area, middle-click to finish",
      place_text: "Left-click to place the text",
      del_temp: "Left-click an area or label to delete it",
      del_dbarea: "Left-click a trait area to delete it",
      inhibit: "Left-click an aircraft to inhibit its safety-logic alerts",
      alertpos: "Left-click to reposition the alert area",
    }[DCB.mode] || "";
    ctx.fillStyle = "#ffd75e";
    ctx.font = mono(12);
    ctx.fillText(msg, 12, DCB.barTop ? 58 : V.h - 52);
    ctx.font = mono(11);
  }
}

/* ---------- input ---------- */
function dcbHitBar(mx, my) {
  for (const h of DCB.hits) {
    if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) return h.id;
  }
  return null;
}

/* returns true when the click was consumed by the DCB */
function dcbClick(mx, my, world, button) {
  if (V.mode !== "ASDX") return false;
  const bar = dcbHitBar(mx, my);
  if (bar) { dcbAction(bar); return true; }
  if (!DCB.mode) return false;

  if (button === 1) {                     // middle click completes a shape
    if (DCB.pending.length >= 3) {
      if (DCB.mode === "draw_closed") DCB.temp.push({ kind: "closed", pts: DCB.pending });
      else if (DCB.mode === "draw_restricted") DCB.temp.push({ kind: "restricted", pts: DCB.pending });
      else if (DCB.mode === "draw_dbarea") DCB.dbAreas.push({ pts: DCB.pending, trait: "partial" });
    }
    DCB.pending = [];
    DCB.mode = null;
    return true;
  }
  switch (DCB.mode) {
    case "draw_closed": case "draw_restricted": case "draw_dbarea":
      DCB.pending.push(world); return true;
    case "place_text":
      DCB.temp.push({ kind: "text", p: world, text: DCB.textBuf || "" });
      DCB.mode = null; return true;
    case "alertpos":
      DCB.alertPos = world; DCB.mode = null; return true;
    case "del_temp": {
      let bi = -1, bd = 0.12;
      DCB.temp.forEach((t, i) => {
        const c = t.kind === "text" ? t.p : { x: t.pts.reduce((a, p) => a + p.x, 0) / t.pts.length,
                                              y: t.pts.reduce((a, p) => a + p.y, 0) / t.pts.length };
        const d = Math.hypot(c.x - world.x, c.y - world.y);
        if (d < bd) { bd = d; bi = i; }
      });
      if (bi >= 0) DCB.temp.splice(bi, 1);
      DCB.mode = null; return true;
    }
    case "del_dbarea": {
      let bi = -1, bd = 0.2;
      DCB.dbAreas.forEach((a, i) => {
        const c = { x: a.pts.reduce((s, p) => s + p.x, 0) / a.pts.length,
                    y: a.pts.reduce((s, p) => s + p.y, 0) / a.pts.length };
        const d = Math.hypot(c.x - world.x, c.y - world.y);
        if (d < bd) { bd = d; bi = i; }
      });
      if (bi >= 0) DCB.dbAreas.splice(bi, 1);
      DCB.mode = null; return true;
    }
    case "inhibit": {
      const ac = hitTest(mx, my);
      if (ac) {
        if (DCB.inhibited.has(ac.id)) DCB.inhibited.delete(ac.id);
        else DCB.inhibited.add(ac.id);
        xmit(G.playerPos, "SYS", "sys",
          `${ac.cs} safety-logic alerts ${DCB.inhibited.has(ac.id) ? "inhibited" : "restored"}.`, null);
      }
      DCB.mode = null; return true;
    }
  }
  return false;
}

/* datablock traits from any trait area the aircraft is inside */
function dbTraitFor(ac) {
  for (const a of DCB.dbAreas) {
    if (pointInPolyPts(a.pts, ac)) return a.trait;
  }
  return DCB.dbMode;
}
function pointInPolyPts(pts, p) {
  let inside = false;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
    if ((pts[i].y > p.y) !== (pts[j].y > p.y) &&
        p.x < ((pts[j].x - pts[i].x) * (p.y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside;
  }
  return inside;
}

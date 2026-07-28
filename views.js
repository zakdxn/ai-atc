/* =====================================================================
   ZEAL ATC — display renderers: STARS radar, ASDE-X surface, tower cab
   ===================================================================== */
"use strict";

const canvas = document.getElementById("scope");
const ctx = canvas.getContext("2d");
const V = {
  mode: "STARS",            // STARS | ASDX | CAB
  range: 45,                // STARS range (nm radius)
  asdxRange: 1.7,
  camAz: 270,               // tower cab azimuth
  camFov: 58,
  cx: 0, cy: 0, w: 0, h: 0,
  dragging: false, dragX: 0,
};

function viewResize() {
  const wrap = document.getElementById("scopewrap");
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  V.w = wrap.clientWidth; V.h = wrap.clientHeight;
  V.cx = V.w / 2; V.cy = V.h / 2;
}
window.addEventListener("resize", viewResize);

function setView(mode) {
  V.mode = mode;
  if (G.arrRwy && mode === "CAB") V.camAz = bearingTo(G.fac.towerPos, G.arrRwy.thr);
  document.querySelectorAll("#viewtabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.v === mode));
}

function acColor(ac, blink) {
  const st = pairState(ac);
  if (st === "conf") return blink ? "#ff5252" : "#7a1f1f";
  if (st === "prox") return "#ffa53a";
  if (ac.owner === G.playerPos) return "#f2f7fb";
  if (ac.role === "arr") return "#39c4e8";
  return "#38e07b";
}

/* ================= STARS ================= */
function drawSTARS() {
  const scale = (Math.min(V.w, V.h) / 2 - 16) / V.range;
  const W2S = p => [V.cx + p.x * scale, V.cy - p.y * scale];
  ctx.fillStyle = "#050708";
  ctx.fillRect(0, 0, V.w, V.h);
  ctx.font = "11px " + getComputedStyle(document.body).fontFamily;

  ctx.strokeStyle = "#12262e";
  ctx.fillStyle = "#1d4450";
  for (let r = 10; r <= V.range; r += 10) {
    ctx.beginPath(); ctx.arc(V.cx, V.cy, r * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(r + "", V.cx + 3, V.cy - r * scale - 3);
  }
  for (const f of G.fac.fixes) {
    const [x, y] = W2S(f);
    ctx.strokeStyle = "#1e5a70";
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 3.5); ctx.lineTo(x - 4.5, y + 3.5);
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = "#2a6d85";
    ctx.fillText(f.name, x + 7, y + 4);
  }
  /* runways + arrival final */
  for (const r of G.fac.runways) {
    const [x1, y1] = W2S(r.thr), [x2, y2] = W2S(r.end);
    ctx.strokeStyle = "#c7d3dd"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.lineWidth = 1;
  }
  {
    const R = G.arrRwy;
    const b = { x: Math.sin(d2r(R.hdg + 180)), y: Math.cos(d2r(R.hdg + 180)) };
    ctx.strokeStyle = "#194b5c";
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    const [ax, ay] = W2S({ x: R.thr.x + b.x * 0.4, y: R.thr.y + b.y * 0.4 });
    const [bx, by] = W2S({ x: R.thr.x + b.x * 22, y: R.thr.y + b.y * 22 });
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    for (let d = 4; d <= 20; d += 4) {
      const [tx, ty] = W2S({ x: R.thr.x + b.x * d, y: R.thr.y + b.y * d });
      ctx.beginPath(); ctx.moveTo(tx - 3, ty - 3); ctx.lineTo(tx + 3, ty + 3); ctx.stroke();
    }
    ctx.fillStyle = "#3b5563";
    const [lx, ly] = W2S(R.thr);
    ctx.fillText(G.fac.icao + " " + R.id, lx - 26, ly + 18);
  }

  const blink = Math.floor(performance.now() / 350) % 2 === 0;
  for (const ac of G.aircraft) {
    if (ac.alt < 40 && !["rolling", "landedRoll"].includes(ac.state)) continue;
    const [x, y] = W2S(ac);
    if (x < -30 || y < -30 || x > V.w + 30 || y > V.h + 30) continue;
    const color = acColor(ac, blink);

    ctx.globalAlpha = 0.35; ctx.fillStyle = color;
    for (const p of ac.trail) { const [px, py] = W2S(p); ctx.fillRect(px - 1, py - 1, 2, 2); }
    ctx.globalAlpha = 1;

    if (ac.alt > 50) {
      const dNm = ac.gs() / 60;
      const [vx, vy] = W2S({ x: ac.x + Math.sin(d2r(ac.hdg)) * dNm, y: ac.y + Math.cos(d2r(ac.hdg)) * dNm });
      ctx.strokeStyle = color; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(vx, vy); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color;
    ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    if (G.selected === ac) { ctx.strokeStyle = "#ffd75e"; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
    if (pairState(ac) === "conf" && blink) { ctx.strokeStyle = "#ff5252"; ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke(); }

    const bx2 = x + 14, by2 = y - 22;
    ctx.strokeStyle = color; ctx.globalAlpha = 0.4;
    ctx.beginPath(); ctx.moveTo(x + 4, y - 4); ctx.lineTo(bx2 - 2, by2 + 10); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = G.selected === ac ? "#ffd75e" : color;
    ctx.fillText(ac.cs + (ac.heavy ? " H" : "") + (ac.medevac ? " M" : ""), bx2, by2);
    let l2 = String(Math.round(ac.alt / 100)).padStart(3, "0");
    l2 += ac.targetAlt > ac.alt + 60 ? "↑" : (ac.targetAlt < ac.alt - 60 || ac.app === "established") ? "↓" : " ";
    if (ac.assignedAlt && Math.abs(ac.assignedAlt - ac.alt) > 60 && ac.app !== "established")
      l2 += String(Math.round(ac.assignedAlt / 100)).padStart(3, "0");
    if (ac.app === "established") l2 += "ILS";
    else if (ac.app === "cleared") l2 += "APP";
    ctx.fillText(l2, bx2, by2 + 12);
    ctx.fillText(`${String(Math.round(ac.gs() / 10)).padStart(2, "0")} ${ac.type} ${ac.owner}`, bx2, by2 + 24);
  }
  ctx.fillStyle = "#2a3d4a";
  ctx.fillText(`STARS ${G.fac.icao} — range ${V.range} nm`, 10, V.h - 10);
}

/* ================= ASDE-X ================= */
function drawASDX() {
  const scale = (Math.min(V.w, V.h) / 2 - 14) / V.asdxRange;
  const W2S = p => [V.cx + p.x * scale, V.cy - p.y * scale];
  ctx.fillStyle = "#0b0f08";
  ctx.fillRect(0, 0, V.w, V.h);
  ctx.font = "11px " + getComputedStyle(document.body).fontFamily;

  /* taxiways */
  ctx.strokeStyle = "#2c3a26"; ctx.lineWidth = 7; ctx.lineCap = "round";
  for (const key of Object.keys(G.fac.taxi)) {
    const t = G.fac.taxi[key];
    const path = key.startsWith("in_") ? [t.exit, ...t.path, G.fac.gates.anchor] : [G.fac.gates.anchor, ...t.path];
    ctx.beginPath();
    path.forEach((p, i) => { const [x, y] = W2S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  /* runways */
  for (const r of G.fac.runways) {
    const active = r.id === G.arrRwy.id || r.recip === G.arrRwy.id || r.id === G.depRwy.id || r.recip === G.depRwy.id;
    const occupied = G.aircraft.some(a =>
      ["rolling", "lineup", "landedRoll"].includes(a.state) ||
      (a.app === "established" && finalGeom(a, G.arrRwy).along < 0.7));
    ctx.strokeStyle = active ? (occupied ? "#5c2a1a" : "#3a4750") : "#232c33";
    ctx.lineWidth = 13;
    const [x1, y1] = W2S(r.thr), [x2, y2] = W2S(r.end);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = "#5a6a75"; ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = active ? "#8fa3b0" : "#44525c";
    ctx.fillText(r.id, x1 + 5, y1 - 5);
    ctx.fillText(r.recip, x2 + 5, y2 - 5);
  }
  ctx.lineWidth = 1; ctx.lineCap = "butt";
  /* terminal */
  const [gx, gy] = W2S(G.fac.gates.anchor);
  ctx.fillStyle = "#1b2333";
  ctx.fillRect(gx - 26, gy - 14, 52, 28);
  ctx.fillStyle = "#3d5a80";
  ctx.fillText("RAMP", gx - 14, gy + 4);

  const blink = Math.floor(performance.now() / 350) % 2 === 0;
  for (const ac of G.aircraft) {
    if (ac.alt > 1500 || ac.distField() > V.asdxRange * 1.6) continue;
    const [x, y] = W2S(ac);
    const ground = ac.alt < 40;
    const color = ac.owner === G.playerPos ? "#ffe07a" : ground ? "#d8b84a" : "#39c4e8";
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(d2r(ac.hdg));
    ctx.fillStyle = color;
    ctx.fillRect(-3, -5, 6, 10);
    ctx.restore();
    if (G.selected === ac) { ctx.strokeStyle = "#ffd75e"; ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = color;
    ctx.fillText(ac.cs, x + 9, y - 6);
    ctx.fillStyle = "#6c7a85";
    ctx.fillText(stateLabel(ac), x + 9, y + 6);
  }
  ctx.fillStyle = "#3a4433";
  ctx.fillText(`ASDE-X ${G.fac.icao} — DEP ${G.depRwy.id} / ARR ${G.arrRwy.id}`, 10, V.h - 10);
}

/* ================= TOWER CAB ================= */
function drawCAB() {
  const tp = G.fac.towerPos;
  const camH = 0.041;                          // ~250 ft in nm
  const f = (V.w / 2) / Math.tan(d2r(V.camFov / 2));
  const horizon = V.h * 0.42;
  const az = d2r(V.camAz);
  const proj = (x, y, altFt) => {
    const dx = x - tp.x, dy = y - tp.y;
    const fwd = dx * Math.sin(az) + dy * Math.cos(az);
    const rgt = dx * Math.cos(az) - dy * Math.sin(az);
    if (fwd < 0.02) return null;
    return { sx: V.cx + (rgt / fwd) * f, sy: horizon + ((camH - altFt / 6076) / fwd) * f, fwd };
  };

  /* sky by time of day */
  const tod = G.atis.tod;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  if (tod === "night") { sky.addColorStop(0, "#020208"); sky.addColorStop(1, "#0a1020"); }
  else if (tod === "dusk") { sky.addColorStop(0, "#1a1a3a"); sky.addColorStop(1, "#b4552a"); }
  else { sky.addColorStop(0, "#7ab6e8"); sky.addColorStop(1, "#cfe4f2"); }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, V.w, horizon);
  const gnd = ctx.createLinearGradient(0, horizon, 0, V.h);
  if (tod === "night") { gnd.addColorStop(0, "#0a0d08"); gnd.addColorStop(1, "#131810"); }
  else if (tod === "dusk") { gnd.addColorStop(0, "#2a2418"); gnd.addColorStop(1, "#1c2014"); }
  else { gnd.addColorStop(0, "#5a6b4a"); gnd.addColorStop(1, "#41503a"); }
  ctx.fillStyle = gnd;
  ctx.fillRect(0, horizon, V.w, V.h - horizon);
  if (tod === "night") {
    ctx.fillStyle = "#e8e8ff";
    for (let i = 0; i < 40; i++) {
      ctx.globalAlpha = 0.3 + (i % 5) * 0.12;
      ctx.fillRect((i * 97) % V.w, (i * 53) % (horizon - 20), 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
  }

  /* runways as perspective quads */
  ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
  for (const r of G.fac.runways) {
    const hw = 0.022;
    const px = Math.cos(d2r(r.hdg)) * hw, py = -Math.sin(d2r(r.hdg)) * hw;
    const corners = [
      proj(r.thr.x + px, r.thr.y + py, 0), proj(r.thr.x - px, r.thr.y - py, 0),
      proj(r.end.x - px, r.end.y - py, 0), proj(r.end.x + px, r.end.y + py, 0),
    ];
    if (corners.some(c => !c)) continue;
    ctx.fillStyle = tod === "day" ? "#3c434a" : "#22262b";
    ctx.beginPath();
    corners.forEach((c, i) => i ? ctx.lineTo(c.sx, c.sy) : ctx.moveTo(c.sx, c.sy));
    ctx.closePath(); ctx.fill();
    /* runway edge lights at night */
    if (tod !== "day") {
      ctx.fillStyle = "#e8d87a";
      for (let t = 0; t <= 1; t += 0.1) {
        const ex = r.thr.x + (r.end.x - r.thr.x) * t, ey = r.thr.y + (r.end.y - r.thr.y) * t;
        const p1 = proj(ex + px, ey + py, 0), p2 = proj(ex - px, ey - py, 0);
        if (p1) ctx.fillRect(p1.sx - 1, p1.sy - 1, 2, 2);
        if (p2) ctx.fillRect(p2.sx - 1, p2.sy - 1, 2, 2);
      }
    }
  }

  /* aircraft, far to near */
  const list = G.aircraft
    .filter(a => a.distField() < 14 && !["gate", "clxOk", "gndCall", "gateIn"].includes(a.state))
    .map(a => ({ a, p: proj(a.x, a.y, a.alt) }))
    .filter(o => o.p)
    .sort((m, n) => n.p.fwd - m.p.fwd);
  for (const { a, p } of list) {
    const size = clamp(3.2 / p.fwd, 2.5, 14);
    const night = tod !== "day";
    ctx.fillStyle = a.alt > 40 ? (night ? "#f0f0f8" : "#20242a") : (night ? "#c8c89a" : "#4a5058");
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, size, size * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    if (night) {                                  // beacon
      if (Math.floor(performance.now() / 600 + a.id) % 2 === 0) {
        ctx.fillStyle = "#ff4040";
        ctx.fillRect(p.sx - 1, p.sy - size * 0.5 - 2, 2, 2);
      }
      ctx.fillStyle = "#fffbe0";
      ctx.fillRect(p.sx - size, p.sy, 1.6, 1.6);
      ctx.fillRect(p.sx + size - 1, p.sy, 1.6, 1.6);
    }
    ctx.fillStyle = G.selected === a ? "#ffd75e" : (night ? "#9fd8ef" : "#12303e");
    ctx.fillText(`${a.cs} ${a.alt > 40 ? Math.round(a.alt) + "ft" : stateLabel(a)}`, p.sx + size + 4, p.sy - 4);
  }

  /* compass strip */
  ctx.fillStyle = tod === "day" ? "#12303e" : "#9fb6c2";
  for (let b = 0; b < 360; b += 10) {
    let rel = angDiff(b, V.camAz);
    if (Math.abs(rel) > V.camFov / 2 + 8) continue;
    const x = V.cx + (Math.tan(d2r(rel)) * f);
    ctx.fillRect(x, 8, 1, b % 30 === 0 ? 10 : 5);
    if (b % 30 === 0) ctx.fillText(String(b === 0 ? 360 : b).padStart(3, "0"), x - 10, 30);
  }
  ctx.fillText(`TOWER CAB ${G.fac.icao} — drag or ←/→ to pan`, 10, V.h - 10);
}

function stateLabel(ac) {
  return {
    gate: "GATE", gndCall: "GATE", clxOk: "GATE", push: "PUSH", taxiWait: "RDY TAXI",
    taxi: "TAXI " + G.depRwy.id, holdShortG: "HS " + G.depRwy.id, holdShort: "HS " + G.depRwy.id,
    lineup: "LUAW", rolling: "ROLL", climb: "DEP", depCtl: "DEP", ctrDep: "ENR",
    ctrArr: "ARR", appCtl: ac.app === "established" ? "ILS" : ac.app === "cleared" ? "APP CLR" : "VECT",
    twrArr: "FINAL", landedRoll: "ROLLOUT", rwyExit: "EXIT", gndIn: "TAXI IN", taxiIn: "TAXI IN",
    gateIn: "AT GATE", out: "ENR",
  }[ac.state] || ac.state;
}

/* ---------------- draw dispatcher ---------------- */
function drawView() {
  if (!G.running) return;
  if (V.mode === "STARS") drawSTARS();
  else if (V.mode === "ASDX") drawASDX();
  else drawCAB();
}

/* ---------------- interactions ---------------- */
canvas.addEventListener("mousedown", e => {
  if (V.mode === "CAB") { V.dragging = true; V.dragX = e.clientX; return; }
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const scale = V.mode === "STARS"
    ? (Math.min(V.w, V.h) / 2 - 16) / V.range
    : (Math.min(V.w, V.h) / 2 - 14) / V.asdxRange;
  let best = null, bestD = 18;
  for (const ac of G.aircraft) {
    if (V.mode === "STARS" && ac.alt < 40 && !["rolling", "landedRoll"].includes(ac.state)) continue;
    if (V.mode === "ASDX" && (ac.alt > 1500 || ac.distField() > V.asdxRange * 1.6)) continue;
    const x = V.cx + ac.x * scale, y = V.cy - ac.y * scale;
    const d = Math.hypot(mx - x, my - y);
    if (d < bestD) { bestD = d; best = ac; }
  }
  if (best) { G.selected = best; G.hooks.strips(); }
});
canvas.addEventListener("mousemove", e => {
  if (V.dragging && V.mode === "CAB") {
    V.camAz = norm360(V.camAz + (e.clientX - V.dragX) * 0.25);
    V.dragX = e.clientX;
  }
});
window.addEventListener("mouseup", () => { V.dragging = false; });
document.addEventListener("keydown", e => {
  if (V.mode !== "CAB" || document.activeElement === document.getElementById("cmd")) return;
  if (e.key === "ArrowLeft") V.camAz = norm360(V.camAz - 6);
  if (e.key === "ArrowRight") V.camAz = norm360(V.camAz + 6);
});

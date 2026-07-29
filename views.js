/* =====================================================================
   AI ATC: display renderers styled after the display types in VATSIM's
   CRC client.
   STARS: black scope, yellow video map, compass rose, system data area,
          flight plan list, green tracks and datablocks.
   ASDE-X: teal background, gray pavement, black runways, white aircraft
          icons with green datablocks, DCB button bar.
   Tower Cab: CRC-style top-down airport view (synthesized imagery; a
          static site cannot ship licensed satellite photos) with a
          METAR bar across the top.
   All displays: wheel zooms, drag pans, click selects a target.
   ===================================================================== */
"use strict";

const canvas = document.getElementById("scope");
const ctx = canvas.getContext("2d");
const V = {
  mode: "STARS",
  range: 45,                       // STARS visible radius, nm
  asdxRange: 1.6,
  cabRange: 1.4,
  pan: { x: 0, y: 0 },
  asdxPan: { x: 0, y: 0 },
  cabPan: { x: 0, y: 0 },
  cx: 0, cy: 0, w: 0, h: 0,
  dragging: false, dragX: 0, dragY: 0, dragMoved: 0,
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
  document.querySelectorAll("#viewtabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.v === mode));
}

function curScale() {
  const half = Math.min(V.w, V.h) / 2 - 16;
  if (V.mode === "STARS") return half / V.range;
  if (V.mode === "ASDX") return half / V.asdxRange;
  return half / V.cabRange;
}
function curPan() {
  return V.mode === "STARS" ? V.pan : V.mode === "ASDX" ? V.asdxPan : V.cabPan;
}
function mono(px) { return px + "px " + getComputedStyle(document.body).fontFamily; }

/* deterministic jitter for synthesized maps */
function jit(seed) {
  let x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

function clockHM() {
  const s = Math.floor(G.t);
  return String(Math.floor(s / 3600) % 24).padStart(2, "0") + String(Math.floor(s / 60) % 60).padStart(2, "0");
}
function metarLine() {
  const a = G.atis, F = G.fac;
  const skyCode = { "sky clear": "SKC", "few clouds at two five zero zero": "FEW025",
    "scattered four thousand": "SCT040", "broken eight thousand": "BKN080" }[a.sky] || "SKC";
  const visCode = (a.visSM || 10) + "SM";
  return `${F.icao} ${String(15).padStart(2, "0")}${clockHM()}Z ${String(a.windDir).padStart(3, "0")}${String(a.windSpd).padStart(2, "0")}KT ${visCode} ${skyCode} ${a.temp}/${a.dew} A${a.qnh}`;
}

/* ================= STARS ================= */
const MAP_YEL = "#b9b944", MAP_DIM = "#7a7a2e";
const TRK_GRN = "#28d028", TRK_DIM = "#1a8a1a", LST_GRN = "#28d028";

function drawSTARS() {
  const scale = curScale();
  const W2S = p => [V.cx + (p.x - V.pan.x) * scale, V.cy - (p.y - V.pan.y) * scale];
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, V.w, V.h);
  ctx.font = mono(11);

  /* compass rose fixed to the display edge */
  const rr = Math.min(V.w, V.h) / 2 - 22;
  ctx.strokeStyle = MAP_DIM; ctx.fillStyle = MAP_DIM;
  for (let b = 0; b < 360; b += 5) {
    const a = d2r(b);
    const x1 = V.cx + Math.sin(a) * rr, y1 = V.cy - Math.cos(a) * rr;
    const x2 = V.cx + Math.sin(a) * (rr + (b % 10 === 0 ? 8 : 4)), y2 = V.cy - Math.cos(a) * (rr + (b % 10 === 0 ? 8 : 4));
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (b % 30 === 0) {
      const lx = V.cx + Math.sin(a) * (rr + 16), ly = V.cy - Math.cos(a) * (rr + 16);
      ctx.fillText(String(b === 0 ? 360 : b).padStart(3, "0"), lx - 10, ly + 4);
    }
  }

  /* synthesized video map: sector boundary + approach corridors */
  ctx.strokeStyle = MAP_YEL;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  G.fac.fixes.forEach((f, i) => {
    const r = 1 + (jit(i * 3 + 1) - 0.5) * 0.25;
    const [x, y] = W2S({ x: f.x * r, y: f.y * r });
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath(); ctx.stroke();
  ctx.setLineDash([5, 7]);
  for (const en of G.fac.entryFixes) {
    const f = G.fac.fixes.find(q => q.name === en);
    if (!f) continue;
    const [x1, y1] = W2S(f), [x2, y2] = W2S({ x: 0, y: 0 });
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  /* fixes as 4-point stars */
  for (const f of G.fac.fixes) {
    const [x, y] = W2S(f);
    ctx.strokeStyle = MAP_YEL;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x + 1.4, y - 1.4); ctx.lineTo(x + 5, y);
    ctx.lineTo(x + 1.4, y + 1.4); ctx.lineTo(x, y + 5); ctx.lineTo(x - 1.4, y + 1.4);
    ctx.lineTo(x - 5, y); ctx.lineTo(x - 1.4, y - 1.4);
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = MAP_DIM;
    ctx.fillText(f.name, x + 8, y + 4);
  }

  /* runways + final */
  for (const r of G.fac.runways) {
    const [x1, y1] = W2S(r.thr), [x2, y2] = W2S(r.end);
    ctx.strokeStyle = MAP_YEL; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.lineWidth = 1;
  }
  {
    const R = G.arrRwy;
    const b = { x: Math.sin(d2r(R.hdg + 180)), y: Math.cos(d2r(R.hdg + 180)) };
    ctx.strokeStyle = MAP_DIM;
    ctx.setLineDash([6, 7]);
    const [ax, ay] = W2S({ x: R.thr.x + b.x * 0.4, y: R.thr.y + b.y * 0.4 });
    const [bx, by] = W2S({ x: R.thr.x + b.x * 20, y: R.thr.y + b.y * 20 });
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
  }

  /* targets, STARS style */
  const blink = Math.floor(performance.now() / 350) % 2 === 0;
  for (const ac of G.aircraft) {
    if (ac.alt < 40 && !["rolling", "landedRoll"].includes(ac.state)) continue;
    const [x, y] = W2S(ac);
    if (x < -80 || y < -60 || x > V.w + 80 || y > V.h + 60) continue;
    const st = pairState(ac);
    let color = ac.owner === G.playerPos ? TRK_GRN : TRK_DIM;
    if (st === "prox") color = "#ffa53a";
    if (st === "conf") color = blink ? "#ff5252" : "#7a1f1f";

    ctx.globalAlpha = 0.4; ctx.fillStyle = color;
    for (const p of ac.trail) { const [px, py] = W2S(p); ctx.fillRect(px - 1, py - 1, 2, 2); }
    ctx.globalAlpha = 1;

    if (ac.alt > 50) {                            /* predicted track line */
      const dNm = ac.gs() / 60;
      const [vx, vy] = W2S({ x: ac.x + Math.sin(d2r(ac.hdg)) * dNm, y: ac.y + Math.cos(d2r(ac.hdg)) * dNm });
      ctx.strokeStyle = color; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(vx, vy); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    /* position symbol: owned tracks get a letter, others a slash */
    ctx.fillStyle = color; ctx.strokeStyle = color;
    if (ac.owner === G.playerPos) {
      ctx.font = mono(12);
      ctx.fillText(G.playerPos === "CTR" ? "C" : G.playerPos[0], x - 4, y + 4);
      ctx.font = mono(11);
    } else {
      ctx.beginPath(); ctx.moveTo(x - 3, y + 3); ctx.lineTo(x + 3, y - 3); ctx.stroke();
    }
    if (G.selected === ac) {
      ctx.strokeStyle = "#ffd75e";
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
    }
    if (st === "conf" && blink) { ctx.strokeStyle = "#ff5252"; ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke(); }

    const bx2 = x + 14, by2 = y - 16;
    ctx.strokeStyle = color; ctx.globalAlpha = 0.4;
    ctx.beginPath(); ctx.moveTo(x + 4, y - 4); ctx.lineTo(bx2 - 2, by2 + 6); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = G.selected === ac ? "#ffd75e" : color;
    ctx.fillText(ac.cs + (ac.heavy ? " H" : "") + (ac.medevac ? " M" : ""), bx2, by2);
    let l2 = String(Math.round(ac.alt / 100)).padStart(3, "0");
    l2 += ac.targetAlt > ac.alt + 60 ? "↑" : (ac.targetAlt < ac.alt - 60 || ac.app === "established") ? "↓" : " ";
    l2 += " " + String(Math.round(ac.gs() / 10)).padStart(2, "0");
    if (ac.app === "established") l2 += " ILS";
    else if (ac.app === "cleared") l2 += " APP";
    ctx.fillText(l2, bx2, by2 + 12);
  }

  /* system data area, top left */
  ctx.fillStyle = LST_GRN;
  ctx.fillText(`${clockHM()}/${String(Math.floor(G.t) % 60).padStart(2, "0")} ${(+G.atis.qnh / 100).toFixed(2)}`, 14, 22);
  ctx.fillText(`${V.range}NM PTL: 1.0`, 14, 36);
  ctx.fillText(`${G.fac.icao.replace(/^[KP]/, "")} ${(+G.atis.qnh / 100).toFixed(2)}`, 14, 50);
  /* flight plan list, top right */
  const mine = G.aircraft.filter(a => a.owner === G.playerPos && !a.remove).slice(0, 8);
  ctx.fillText("FLIGHT PLAN", V.w - 170, 22);
  mine.forEach((a, i) => ctx.fillText(`${i} ${a.cs.padEnd(8)} ${a.sqk}`, V.w - 170, 36 + i * 14));
  ctx.fillStyle = TRK_DIM;
  ctx.fillText("COAST/SUSPEND", V.w - 150, V.h * 0.62);
  ctx.fillText("VFR LIST", V.w - 150, V.h * 0.72);
  ctx.fillText("LA/CA/MCI", V.w - 150, V.h * 0.82);
  ctx.fillText(`${G.fac.icao.replace(/^[KP]/, "")} ${POS_NAME[G.playerPos].toUpperCase()}`, 14, V.h * 0.75);
}

/* ================= ASDE-X ================= */
const ASDX_BG = "#0e5866", ASDX_PVMT = "#3c4046", ASDX_BLDG = "#9a9aa0", ASDX_GRN = "#28e05a";

function drawASDX() {
  const scale = curScale();
  const W2S = p => [V.cx + (p.x - V.asdxPan.x) * scale, V.cy - (p.y - V.asdxPan.y) * scale];
  const N = DCB.night;
  ctx.fillStyle = N ? "#06232a" : ASDX_BG;
  ctx.fillRect(0, 0, V.w, V.h);
  ctx.font = mono(11);

  const bt = DCB.brite;
  const sh = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map(x => Math.max(0, Math.min(255, Math.round(x * f))));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  drawPavement(W2S, scale, {
    taxi: sh(N ? "#2b2f34" : ASDX_PVMT, bt), taxiLine: null,
    rwy: "#000", rwyLine: null,
    ramp: sh(N ? "#6a6b70" : "#8f9096", bt), bldg: sh(ASDX_BLDG, bt),
    label: sh("#c8ccd2", bt), twLabel: sh("#e8c95a", bt), holdBar: "#c8a020",
  });

  /* safety logic: paint the runway red when occupied with traffic short final */
  const threat = G.aircraft.some(a => a.app === "established" && finalGeom(a, G.arrRwy).along < 1.5) &&
                 G.aircraft.some(a => ["lineup", "rolling", "landedRoll"].includes(a.state));
  if (threat) {
    const [x1, y1] = W2S(G.arrRwy.thr), [x2, y2] = W2S(G.arrRwy.end);
    ctx.strokeStyle = "#ff2020"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.lineWidth = 1;
  }

  /* aircraft: white icons, green datablocks (parked aircraft are not tracked) */
  for (const ac of G.aircraft) {
    if (ac.alt > 2000 || ac.distField() > V.asdxRange * 3.5) continue;
    const parked = ["gate", "clxOk", "gndCall", "gateIn"].includes(ac.state);
    const [x, y] = W2S(ac);
    const alerted = DCB.alerts.some(a => a.acId === ac.id);
    drawPlaneIcon(x, y, ac.hdg, alerted ? "#ff5050" : parked ? "#9aa4ad" : "#ffffff",
                  G.selected === ac);
    if (alerted) {
      ctx.strokeStyle = "#ff3030"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
    }
    if (DCB.inhibited.has(ac.id)) {
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(x - 9, y - 9, 18, 18);
    }
    if (!DCB.dbOn || ac.dbHidden) continue;
    /* when an alert is up, unaffected traffic drops to a partial block */
    const anyAlert = DCB.alerts.length > 0;
    const trait = anyAlert && !alerted ? "partial" : dbTraitFor(ac);
    ctx.font = mono(DCB.charSize);
    ctx.fillStyle = G.selected === ac ? "#ffd75e" : alerted ? "#ff6060"
                  : parked ? "#1f9a4a" : ASDX_GRN;
    ctx.strokeStyle = ASDX_GRN; ctx.globalAlpha = 0.5;
    { const o = ac.dbOff || { dx: 16, dy: -14 };
      ctx.beginPath(); ctx.moveTo(x + Math.sign(o.dx) * 4, y + Math.sign(o.dy) * 4);
      ctx.lineTo(x + o.dx - 2, y + o.dy + 2); ctx.stroke(); }
    ctx.globalAlpha = 1;
    const off = ac.dbOff || { dx: 16, dy: -14 };
    ctx.fillText(ac.cs, x + off.dx, y + off.dy);
    ac.dbBox = { x: x + off.dx - 3, y: y + off.dy - 11, w: 74, h: trait === "partial" ? 14 : 26 };
    if (trait !== "partial") {
      const l2 = ac.alt > 40
        ? (DCB.dbAlt ? String(Math.round(ac.alt / 100) * 100) : ac.type)
        : parked ? `${ac.type} ${ac.role === "dep" ? "gate " + ac.gate : "gate"}`
        : `${ac.type} ${ac.role === "dep" ? ac.exitFix.name : G.arrRwy.id}`;
      ctx.fillText(l2, x + off.dx, y + off.dy + 12);
    }
    ctx.font = mono(11);
  }

  drawInsetWindows();
  drawDCBOverlays(W2S);
  drawDCBBar();
  ctx.font = mono(12);
  ctx.fillStyle = ASDX_GRN;
  const sy = DCB.barTop ? 62 : 22;
  ctx.fillText(`RWY CFG: ${G.arrRwy.id}/${G.depRwy.id}${DCB.closedRwys.size ? "  CLSD: " + [...DCB.closedRwys].join(",") : ""}`, 14, sy);
  ctx.fillText(`${clockHM()}/${String(Math.floor(G.t) % 60).padStart(2, "0")}  ${String(G.atis.windDir).padStart(3, "0")}${String(G.atis.windSpd).padStart(2, "0")}KT  A${G.atis.qnh}`, 14, sy + 14);
  ctx.font = mono(11);
}

/* shared pavement painter for the top-down displays */
function drawPavement(W2S, scale, TH) {
  /* real pavement polygons where we have them */
  if (G.fac.real && G.fac.pav) {
    const poly = (flat, fill) => {
      ctx.beginPath();
      for (let i = 0; i < flat.length; i += 2) {
        const [x, y] = W2S({ x: flat[i], y: flat[i + 1] });
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    for (const p of G.fac.pav.apr) poly(p, TH.ramp);
    for (const p of G.fac.pav.twy) poly(p, TH.taxi);
    drawTaxiLabels(W2S, scale, TH);
    /* the routes in use, drawn as painted centrelines */
    if (TH.taxiLine) {
      ctx.strokeStyle = TH.taxiLine;
      ctx.lineWidth = 1.4;
      for (const key of Object.keys(G.fac.taxi || {})) {
        const t = G.fac.taxi[key];
        const pts = key.startsWith("in_") ? [t.exit, ...t.path] : [G.fac.gates.anchor, ...t.path];
        ctx.beginPath();
        pts.forEach((p, i) => { const [x, y] = W2S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      }
    }
    drawRunways(W2S, scale, TH);
    return;
  }
  /* synthetic network fallback */
  ctx.lineCap = "round";
  for (const seg of (G.fac.net || [])) {
    const w = seg.kind === "par" ? Math.max(7, 0.05 * scale)
            : seg.kind === "conn" ? Math.max(5, 0.04 * scale)
            : Math.max(6, 0.045 * scale);
    ctx.strokeStyle = TH.taxi;
    ctx.lineWidth = w;
    ctx.beginPath();
    seg.pts.forEach((p, i) => { const [x, y] = W2S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    if (TH.taxiLine) {
      ctx.strokeStyle = TH.taxiLine;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      seg.pts.forEach((p, i) => { const [x, y] = W2S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }
  }
  /* hold-short bars where connectors meet the runway */
  for (const seg of (G.fac.net || [])) {
    if (seg.kind !== "conn") continue;
    const [pp, rp] = seg.pts;
    const hx = pp.x + (rp.x - pp.x) * 0.72, hy = pp.y + (rp.y - pp.y) * 0.72;
    const dx = rp.x - pp.x, dy = rp.y - pp.y;
    const dl = Math.hypot(dx, dy) || 1;
    const px = -dy / dl, py = dx / dl;
    const [x1, y1] = W2S({ x: hx + px * 0.035, y: hy + py * 0.035 });
    const [x2, y2] = W2S({ x: hx - px * 0.035, y: hy - py * 0.035 });
    ctx.strokeStyle = TH.holdBar || "#e0c030";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.lineWidth = 1;
  }
  /* taxiway labels */
  ctx.font = mono(10);
  for (const seg of (G.fac.net || [])) {
    if (!seg.name) continue;
    const mx = (seg.pts[0].x + seg.pts[1].x) / 2, my = (seg.pts[0].y + seg.pts[1].y) / 2;
    const [x, y] = W2S({ x: mx, y: my });
    ctx.fillStyle = TH.twLabel || TH.label;
    if (seg.kind === "par") {
      ctx.font = mono(12);
      ctx.fillText(seg.name, x + 5, y - 5);
      ctx.font = mono(10);
    } else {
      ctx.fillText(seg.name, x + 4, y - 4);
    }
  }
  ctx.font = mono(11);
  /* ramp + terminal buildings */
  const [gx, gy] = W2S(G.fac.gates.anchor);
  const rw = Math.max(40, 0.5 * scale), rh = Math.max(22, 0.28 * scale);
  ctx.fillStyle = TH.ramp;
  ctx.fillRect(gx - rw / 2, gy - rh / 2, rw, rh);
  ctx.fillStyle = TH.bldg;
  ctx.fillRect(gx - rw / 2.6, gy - rh / 6, rw / 1.3, rh / 3);
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(gx - rw / 2.6 + i * rw / 5.2, gy - rh / 2.4, rw / 9, rh / 4);
  }
  drawRunways(W2S, scale, TH);
  ctx.lineWidth = 1; ctx.lineCap = "butt";
}

function drawRunways(W2S, scale, TH) {
  for (const r of G.fac.runways) {
    const [x1, y1] = W2S(r.thr), [x2, y2] = W2S(r.end);
    ctx.strokeStyle = TH.rwy;
    ctx.lineWidth = Math.max(9, (r.w || 0.05) * scale);
    ctx.lineCap = "butt";
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (TH.rwyLine) {
      ctx.strokeStyle = TH.rwyLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 8]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = TH.label;
    ctx.fillText(r.id, x1 + 6, y1 - 6);
    ctx.fillText(r.recip, x2 + 6, y2 - 6);
  }
  ctx.lineWidth = 1;
}

function drawPlaneIcon(x, y, hdg, color, sel) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(d2r(hdg));
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -6);              // nose
  ctx.lineTo(1.4, -1.5);
  ctx.lineTo(6, 0.5); ctx.lineTo(6, 2); ctx.lineTo(1.2, 1.2);   // right wing
  ctx.lineTo(1, 4.4); ctx.lineTo(2.6, 5.6); ctx.lineTo(0, 5.2); // right tail
  ctx.lineTo(-2.6, 5.6); ctx.lineTo(-1, 4.4);                   // left tail
  ctx.lineTo(-1.2, 1.2); ctx.lineTo(-6, 2); ctx.lineTo(-6, 0.5);
  ctx.lineTo(-1.4, -1.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (sel) {
    ctx.strokeStyle = "#ffd75e";
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
  }
}

/* ================= TOWER CAB (CRC-style top-down) ================= */
function drawCAB() {
  const scale = curScale();
  const W2S = p => [V.cx + (p.x - V.cabPan.x) * scale, V.cy - (p.y - V.cabPan.y) * scale];
  const night = G.atis.tod === "night";

  /* terrain */
  ctx.fillStyle = night ? "#232b1e" : "#6a7d4f";
  ctx.fillRect(0, 0, V.w, V.h);
  for (let i = 0; i < 26; i++) {                       // field patchwork
    const px = (jit(i) - 0.5) * 5, py = (jit(i + 50) - 0.5) * 5;
    const [x, y] = W2S({ x: px, y: py });
    const w = (0.4 + jit(i + 100)) * scale, h = (0.3 + jit(i + 150) * 0.7) * scale;
    ctx.fillStyle = night
      ? (i % 2 ? "#1f2619" : "#28301f")
      : (i % 3 === 0 ? "#75885a" : i % 3 === 1 ? "#5f7247" : "#83906b");
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x, y, w, h);
  }
  ctx.globalAlpha = 1;
  ctx.font = mono(11);

  drawPavement(W2S, scale, {
    taxi: night ? "#3f4038" : "#8a8a80",
    taxiLine: "#d9a520",
    rwy: night ? "#33373c" : "#565b60",
    rwyLine: "#e8e8e8",
    ramp: night ? "#4a4c50" : "#a8a8ac",
    bldg: night ? "#5c5e64" : "#c4c4c8",
    label: night ? "#e8e8e8" : "#20242a",
    twLabel: night ? "#f0d060" : "#7a5c10",
    holdBar: "#d9a520",
  });

  /* aircraft */
  for (const ac of G.aircraft) {
    if (ac.distField() > V.cabRange * 3.5 || ac.alt > 6000) continue;
    const parked = ["gate", "clxOk", "gndCall", "gateIn"].includes(ac.state);
    const [x, y] = W2S(ac);
    const col = parked ? (night ? "#8e8e98" : "#c8c8d0") : (night ? "#e8e8f0" : "#f4f4f8");
    drawPlaneIcon(x, y, ac.hdg, col, G.selected === ac);
    ctx.fillStyle = G.selected === ac ? "#ffd75e" : night ? "#9fd8ef" : "#12303e";
    const tag = ac.alt > 40 ? ` ${Math.round(ac.alt)}ft` : parked ? "" : ` ${stateLabel(ac)}`;
    ctx.fillText(ac.cs + tag, x + 12, y - 8);
  }

  /* visibility ring: beyond reported visibility the field fades into haze */
  {
    const visNm = (G.atis.visSM || 10) * 0.869;      // statute miles to nm
    const rPx = visNm * scale;
    const [ox, oy] = W2S(G.fac.towerPos);
    if (rPx < Math.hypot(V.w, V.h)) {
      const haze = night ? "rgba(150,160,175," : "rgba(228,232,238,";
      const grd = ctx.createRadialGradient(ox, oy, rPx * 0.72, ox, oy, rPx * 1.5);
      grd.addColorStop(0, haze + "0)");
      grd.addColorStop(0.45, haze + "0.55)");
      grd.addColorStop(1, haze + "0.96)");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, V.w, V.h);
      ctx.strokeStyle = night ? "rgba(200,210,225,.5)" : "rgba(255,255,255,.75)";
      ctx.setLineDash([5, 6]);
      ctx.beginPath(); ctx.arc(ox, oy, rPx, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = night ? "#9fb6c2" : "#405a68";
      ctx.fillText(`${G.atis.visSM}SM VIS`, ox + rPx * 0.7, oy - rPx * 0.7);
    }
  }

  /* METAR bar, CRC cab style */
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, V.w, 24);
  ctx.fillStyle = "#28d028";
  ctx.font = mono(12);
  ctx.fillText(`${clockHM()}/${String(G.atis.windSpd).padStart(2, "0")}`, 10, 16);
  ctx.fillText(metarLine(), 90, 16);
  ctx.font = mono(11);
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

/* ---------------- interactions: zoom, pan, select ---------------- */
function hitTest(mx, my) {
  const scale = curScale();
  const pan = curPan();
  let best = null, bestD = 18;
  for (const ac of G.aircraft) {
    if (V.mode === "STARS" && ac.alt < 40 && !["rolling", "landedRoll"].includes(ac.state)) continue;
    if (V.mode === "ASDX" && (ac.alt > 2000 || ac.distField() > V.asdxRange * 3.5)) continue;
    if (V.mode === "CAB" && (ac.alt > 6000 || ac.distField() > V.cabRange * 3.5)) continue;
    const x = V.cx + (ac.x - pan.x) * scale, y = V.cy - (ac.y - pan.y) * scale;
    const d = Math.hypot(mx - x, my - y);
    if (d < bestD) { bestD = d; best = ac; }
    if (mx >= x + 10 && mx <= x + 95 && my >= y - 28 && my <= y + 4) { best = ac; bestD = 0; }
  }
  return best;
}

canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("mousedown", e => {
  if (e.button === 1) e.preventDefault();
  if (e.button === 0 && V.mode === "ASDX" && G.running) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const ac = dbHit(mx, my);
    if (ac) {                                   // grab the datablock, not the map
      const [ax, ay] = [V.cx + (ac.x - V.asdxPan.x) * curScale(),
                        V.cy - (ac.y - V.asdxPan.y) * curScale()];
      V.dbDrag = { ac, gx: mx - (ax + (ac.dbOff || { dx: 16 }).dx),
                        gy: my - (ay + (ac.dbOff || { dy: -14 }).dy) };
      V.dragging = false;
      return;
    }
  }
  V.dragging = e.button === 0;
  V.dragX = e.clientX; V.dragY = e.clientY; V.dragMoved = 0;
  if (e.button === 1 && G.running) {           // middle click finishes a shape
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    dcbClick(mx, my, screenToWorld(mx, my), 1);
  }
});
canvas.addEventListener("mousemove", e => {
  if (V.dbDrag) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const ac = V.dbDrag.ac;
    const ax = V.cx + (ac.x - V.asdxPan.x) * curScale();
    const ay = V.cy - (ac.y - V.asdxPan.y) * curScale();
    ac.dbOff = { dx: mx - V.dbDrag.gx - ax, dy: my - V.dbDrag.gy - ay };
    return;
  }
  if (!V.dragging) return;
  const dx = e.clientX - V.dragX, dy = e.clientY - V.dragY;
  V.dragX = e.clientX; V.dragY = e.clientY;
  V.dragMoved += Math.abs(dx) + Math.abs(dy);
  const pan = curPan(), scale = curScale();
  pan.x -= dx / scale; pan.y += dy / scale;
});
function screenToWorld(mx, my) {
  const s = curScale(), p = curPan();
  return { x: (mx - V.cx) / s + p.x, y: -(my - V.cy) / s + p.y };
}
window.addEventListener("mouseup", e => {
  if (V.dbDrag) { V.dbDrag = null; return; }
  if (!V.dragging) return;
  V.dragging = false;
  if (V.dragMoved > 5 || !G.running) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return;
  if (dcbClick(mx, my, screenToWorld(mx, my), 0)) return;   // consumed by the DCB
  const hit = hitTest(mx, my);
  if (hit) {
    if (e.ctrlKey) { openFlightPlan(hit); return; }         // ctrl+click opens the flight plan
    if (e.shiftKey && V.mode !== "STARS") {                 // shift+click hides the datablock
      hit.dbHidden = !hit.dbHidden;
      return;
    }
    G.selected = hit; G.hooks.strips();
  }
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const dir = Math.sign(e.deltaY);
  {
    const rect = canvas.getBoundingClientRect();
    if (typeof dcbWheel === "function" &&
        dcbWheel(e.clientX - rect.left, e.clientY - rect.top, dir)) return;
  }
  if (V.mode === "STARS") V.range = clamp(V.range + dir * 5, 15, 80);
  else if (V.mode === "ASDX") V.asdxRange = clamp(V.asdxRange * (dir > 0 ? 1.2 : 0.84), 0.6, 4.5);
  else V.cabRange = clamp(V.cabRange * (dir > 0 ? 1.2 : 0.84), 0.5, 4);
}, { passive: false });
canvas.addEventListener("dblclick", () => {
  V.pan = { x: 0, y: 0 }; V.asdxPan = { x: 0, y: 0 }; V.cabPan = { x: 0, y: 0 };
});


/* ---------- taxiway labels ----------
   Real taxiway names are not present in the open dataset, so each
   significant strip of pavement is lettered per facility (stable within
   a field) and labelled along its length, the way a chart would. */
function drawTaxiLabels(W2S, scale, TH) {
  const F = G.fac;
  if (!F.pav || !F.pav.twy.length) return;
  if (!F.twyLabels) {
    const L = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", "R", "S", "T", "V", "W"];
    const cand = [];
    F.pav.twy.forEach((flat, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < flat.length; k += 2) {
        x0 = Math.min(x0, flat[k]); x1 = Math.max(x1, flat[k]);
        y0 = Math.min(y0, flat[k + 1]); y1 = Math.max(y1, flat[k + 1]);
      }
      const w = x1 - x0, h = y1 - y0;
      const span = Math.max(w, h);
      if (span < 0.13) return;                       // ignore short stubs
      cand.push({ i, span, c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
                  horiz: w >= h, x0, y0, x1, y1 });
    });
    cand.sort((a, b) => b.span - a.span);
    F.twyLabels = cand.slice(0, L.length).map((o, k) => ({ ...o, name: L[k] }));
  }
  ctx.font = mono(Math.max(9, Math.min(15, scale * 0.055)));
  for (const t of F.twyLabels) {
    if (t.span * scale < 42) continue;               // too small to letter at this zoom
    const pts = t.horiz
      ? [{ x: t.x0 + t.span * 0.25, y: t.c.y }, { x: t.x1 - t.span * 0.25, y: t.c.y }]
      : [{ x: t.c.x, y: t.y0 + t.span * 0.25 }, { x: t.c.x, y: t.y1 - t.span * 0.25 }];
    for (const p of pts) {
      const [x, y] = W2S(p);
      if (x < 0 || y < 0 || x > V.w || y > V.h) continue;
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fillRect(x - 8, y - 8, 16, 15);
      ctx.fillStyle = TH.twLabel || "#e8c95a";
      ctx.fillText(t.name, x - 3.5, y + 3.5);
    }
  }
  ctx.font = mono(11);
}

/* ---------- secondary ASDE-X windows (TOOLS > NEW WINDOW) ----------
   Each is an independent viewport onto the same surface picture, so you
   can keep a zoomed view of a runway end while working the whole field. */
function drawInsetWindows() {
  if (!DCB.windows || !DCB.windows.length) return;
  const N = DCB.night;
  const bt = DCB.brite;
  const sh = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map(x => Math.max(0, Math.min(255, Math.round(x * f))));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const TH = {
    taxi: sh(N ? "#2b2f34" : ASDX_PVMT, bt), taxiLine: null,
    rwy: "#000", rwyLine: null,
    ramp: sh(N ? "#6a6b70" : "#8f9096", bt), bldg: sh(ASDX_BLDG, bt),
    label: sh("#c8ccd2", bt), twLabel: sh("#e8c95a", bt), holdBar: "#c8a020",
  };
  for (const win of DCB.windows) {
    const cx = win.x + win.w / 2, cy = win.y + win.h / 2;
    const scale = (Math.min(win.w, win.h) / 2 - 6) / win.range;
    const W2S = p => [cx + (p.x - win.pan.x) * scale, cy - (p.y - win.pan.y) * scale];
    ctx.save();
    ctx.beginPath();
    ctx.rect(win.x, win.y, win.w, win.h);
    ctx.clip();
    ctx.fillStyle = N ? "#06232a" : ASDX_BG;
    ctx.fillRect(win.x, win.y, win.w, win.h);
    drawPavement(W2S, scale, TH);
    for (const ac of G.aircraft) {
      if (ac.alt > 2000) continue;
      const [x, y] = W2S(ac);
      if (x < win.x - 30 || x > win.x + win.w + 30 || y < win.y - 30 || y > win.y + win.h + 30) continue;
      const parked = ["gate", "clxOk", "gndCall", "gateIn"].includes(ac.state);
      drawPlaneIcon(x, y, ac.hdg, parked ? "#9aa4ad" : "#ffffff", G.selected === ac);
      if (DCB.dbOn && !ac.dbHidden) {
        ctx.font = mono(Math.max(9, DCB.charSize - 1));
        ctx.fillStyle = G.selected === ac ? "#ffd75e" : ASDX_GRN;
        ctx.fillText(ac.cs, x + 10, y - 8);
        ctx.font = mono(11);
      }
    }
    ctx.restore();
    ctx.strokeStyle = "#7fa8c0";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(win.x, win.y, win.w, win.h);
    ctx.lineWidth = 1;
    ctx.fillStyle = "#7fa8c0";
    ctx.font = mono(9);
    ctx.fillText(`WIN ${win.range.toFixed(1)}nm`, win.x + 5, win.y + 11);
    ctx.font = mono(11);
  }
}

/* ---------- datablock dragging ---------- */
function dbHit(mx, my) {
  if (!DCB.dbOn) return null;
  for (const ac of G.aircraft) {
    const b = ac.dbBox;
    if (!b || ac.dbHidden) continue;
    if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return ac;
  }
  return null;
}

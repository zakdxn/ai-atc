/* =====================================================================
   AI ATC: real airport geometry.
   Replaces the synthetic layouts with real runway coordinates and real
   taxiway/apron pavement extracted from X-Plane's apt.dat, then routes
   aircraft over that pavement with A* on a rasterized grid, so taxi
   routes follow the taxiways that actually exist at the field.
   Local frame: x = east nm, y = north nm about the airport reference.
   ===================================================================== */
"use strict";

const GEO = {
  CELL: 0.012,          // grid cell, nm (about 22 m)
  COST_TWY: 1,
  COST_RWY: 9,          // crossable, but strongly discouraged
};

/* ---------- polygon helpers ---------- */
function polyBounds(flat) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] < x0) x0 = flat[i];
    if (flat[i] > x1) x1 = flat[i];
    if (flat[i + 1] < y0) y0 = flat[i + 1];
    if (flat[i + 1] > y1) y1 = flat[i + 1];
  }
  return [x0, y0, x1, y1];
}
function polyArea(flat) {
  let a = 0;
  for (let i = 0, n = flat.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}
function polyCentroid(flat) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = flat.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    const cr = flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
    a += cr;
    cx += (flat[i * 2] + flat[j * 2]) * cr;
    cy += (flat[i * 2 + 1] + flat[j * 2 + 1]) * cr;
  }
  if (Math.abs(a) < 1e-9) return { x: flat[0], y: flat[1] };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/* ---------- realize a facility from the real data ---------- */
function realizeFacility(fac) {
  const A = (typeof APT !== "undefined") && APT[fac.icao];
  if (!A || !A.rwy || !A.rwy.length) { fac.real = false; return; }
  fac.real = true;
  fac.apName = A.name || fac.apName;

  fac.runways = A.rwy.map(r => ({
    id: r.a, recip: r.b,
    thr: { x: r.ax, y: r.ay }, end: { x: r.bx, y: r.by },
    hdg: r.hdg, len: r.len, w: r.w || 0.025,
  }));
  fac.pav = { twy: A.twy || [], apr: A.apr || [] };

  /* runway configurations derived from the real layout */
  const byLen = [...fac.runways].sort((a, b) => b.len - a.len);
  const primary = byLen[0];
  const parallel = byLen.filter(r =>
    r !== primary && Math.abs(angDiff(r.hdg, primary.hdg)) < 20);
  const depRw = parallel[0] || primary;
  const dirName = h => {
    const d = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];
    return d[Math.round(norm360(h) / 45) % 8];
  };
  fac.configs = [
    { name: dirName(primary.hdg) + " Flow", arr: primary.id, dep: depRw.id,
      windLo: norm360(primary.hdg - 80), windHi: norm360(primary.hdg + 80) },
    { name: dirName(primary.hdg + 180) + " Flow", arr: primary.recip, dep: depRw.recip,
      windLo: norm360(primary.hdg + 100), windHi: norm360(primary.hdg + 260) },
  ];

  /* ramp: the biggest apron, else the pavement lobe farthest from the runways */
  let anchor = null;
  const aprons = fac.pav.apr.length ? fac.pav.apr : [];
  if (aprons.length) {
    let best = null, bestA = 0;
    for (const p of aprons) {
      const ar = polyArea(p);
      if (ar > bestA) { bestA = ar; best = p; }
    }
    anchor = polyCentroid(best);
  }
  if (!anchor) {
    /* pick the taxiway polygon centroid with the greatest clearance from runways */
    let best = null, bestD = -1;
    for (const p of fac.pav.twy) {
      if (polyArea(p) < 0.0008) continue;
      const c = polyCentroid(p);
      let dmin = Infinity;
      for (const r of fac.runways) dmin = Math.min(dmin, distToSeg(c, r.thr, r.end));
      if (dmin > bestD) { bestD = dmin; best = c; }
    }
    anchor = best;
  }
  if (!anchor) {
    const perp = { x: Math.cos(d2r(primary.hdg)), y: -Math.sin(d2r(primary.hdg)) };
    const mid = { x: (primary.thr.x + primary.end.x) / 2, y: (primary.thr.y + primary.end.y) / 2 };
    anchor = { x: mid.x + perp.x * 0.4, y: mid.y + perp.y * 0.4 };
  }
  fac.gates.anchor = anchor;
  fac.towerPos = A.twr ? { x: A.twr[0], y: A.twr[1] } : anchor;
  fac.net = null;                 // real pavement replaces the synthetic network
  fac.grid = null;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  if (L < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ---------- rasterize pavement into a routing grid ---------- */
function buildGrid(fac) {
  if (fac.grid) return fac.grid;
  const C = GEO.CELL;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const eat = b => { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); };
  for (const p of fac.pav.twy) eat(polyBounds(p));
  for (const p of fac.pav.apr) eat(polyBounds(p));
  for (const r of fac.runways) {
    eat([Math.min(r.thr.x, r.end.x), Math.min(r.thr.y, r.end.y),
         Math.max(r.thr.x, r.end.x), Math.max(r.thr.y, r.end.y)]);
  }
  x0 -= 0.1; y0 -= 0.1; x1 += 0.1; y1 += 0.1;
  const w = Math.ceil((x1 - x0) / C), h = Math.ceil((y1 - y0) / C);
  const cost = new Uint8Array(w * h);          // 0 = blocked

  const fill = (flat, val) => {
    const n = flat.length / 2;
    const [bx0, by0, bx1, by1] = polyBounds(flat);
    const r0 = Math.max(0, Math.floor((by0 - y0) / C));
    const r1 = Math.min(h - 1, Math.ceil((by1 - y0) / C));
    for (let row = r0; row <= r1; row++) {
      const yc = y0 + (row + 0.5) * C;
      const xs = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ay = flat[i * 2 + 1], by = flat[j * 2 + 1];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          const t = (yc - ay) / (by - ay);
          xs.push(flat[i * 2] + t * (flat[j * 2] - flat[i * 2]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.floor((xs[k] - x0) / C));
        const c1 = Math.min(w - 1, Math.ceil((xs[k + 1] - x0) / C));
        for (let c = c0; c <= c1; c++) {
          const idx = row * w + c;
          if (cost[idx] === 0 || val < cost[idx]) cost[idx] = val;
        }
      }
    }
  };

  /* runways first (expensive), then taxiways/aprons overwrite as cheap */
  for (const r of fac.runways) {
    const hw = Math.max(r.w, 0.02) / 2 + 0.004;
    const px = Math.cos(d2r(r.hdg)) * hw, py = -Math.sin(d2r(r.hdg)) * hw;
    fill([r.thr.x + px, r.thr.y + py, r.end.x + px, r.end.y + py,
          r.end.x - px, r.end.y - py, r.thr.x - px, r.thr.y - py], GEO.COST_RWY);
  }
  for (const p of fac.pav.twy) fill(p, GEO.COST_TWY);
  for (const p of fac.pav.apr) fill(p, GEO.COST_TWY);

  fac.grid = { x0, y0, w, h, C, cost };
  return fac.grid;
}

const gIdx = (g, cx, cy) => cy * g.w + cx;
const toCell = (g, p) => [Math.floor((p.x - g.x0) / g.C), Math.floor((p.y - g.y0) / g.C)];
const toWorld = (g, cx, cy) => ({ x: g.x0 + (cx + 0.5) * g.C, y: g.y0 + (cy + 0.5) * g.C });

/* nearest walkable cell to a world point */
function snapCell(g, p, maxR = 40) {
  let [cx, cy] = toCell(g, p);
  cx = Math.max(0, Math.min(g.w - 1, cx));
  cy = Math.max(0, Math.min(g.h - 1, cy));
  if (g.cost[gIdx(g, cx, cy)]) return [cx, cy];
  for (let r = 1; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (const dy of [-r, r]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < g.w && ny < g.h && g.cost[gIdx(g, nx, ny)]) return [nx, ny];
      }
    }
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      for (const dx of [-r, r]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < g.w && ny < g.h && g.cost[gIdx(g, nx, ny)]) return [nx, ny];
      }
    }
  }
  return null;
}

/* A* over the pavement grid */
function gridPath(g, start, goal) {
  const N = g.w * g.h;
  const open = [gIdx(g, start[0], start[1])];
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const si = gIdx(g, start[0], start[1]), gi = gIdx(g, goal[0], goal[1]);
  gScore[si] = 0;
  const hx = i => {
    const cx = i % g.w, cy = (i / g.w) | 0;
    return Math.hypot(cx - goal[0], cy - goal[1]);
  };
  const fOf = new Float32Array(N).fill(Infinity);
  fOf[si] = hx(si);
  let guard = 0;
  while (open.length && guard++ < 400000) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (fOf[open[k]] < fOf[open[bi]]) bi = k;
    const cur = open.splice(bi, 1)[0];
    if (cur === gi) break;
    closed[cur] = 1;
    const cx = cur % g.w, cy = (cur / g.w) | 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const ni = gIdx(g, nx, ny);
        const c = g.cost[ni];
        if (!c || closed[ni]) continue;
        if (dx && dy) {                       // no corner cutting
          if (!g.cost[gIdx(g, cx + dx, cy)] || !g.cost[gIdx(g, cx, cy + dy)]) continue;
        }
        const step = (dx && dy ? 1.414 : 1) * c;
        const tent = gScore[cur] + step;
        if (tent < gScore[ni]) {
          gScore[ni] = tent;
          came[ni] = cur;
          fOf[ni] = tent + hx(ni);
          if (!open.includes(ni)) open.push(ni);
        }
      }
    }
  }
  if (came[gi] === -1 && gi !== si) return null;
  const path = [];
  let cur = gi;
  while (cur !== -1 && cur !== si) { path.push(cur); cur = came[cur]; }
  path.push(si);
  path.reverse();
  return path.map(i => toWorld(g, i % g.w, (i / g.w) | 0));
}

/* straight-line walkability, used to smooth the raw grid path */
function clearLine(g, a, b) {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.C * 0.6));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const [cx, cy] = toCell(g, p);
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h || !g.cost[gIdx(g, cx, cy)]) return false;
  }
  return true;
}
/* De-stair-step the raw grid path without letting it collapse into a
   straight line across the pavement: only ever skip a short distance
   ahead, so the route keeps following the taxiway it was routed along. */
function smooth(g, pts) {
  if (!pts || pts.length < 3) return pts;
  const MAX_SKIP = Math.max(4, Math.round(0.09 / g.C));   // about 0.09 nm
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = Math.min(pts.length - 1, i + MAX_SKIP);
    for (; j > i + 1; j--) if (clearLine(g, pts[i], pts[j])) break;
    out.push(pts[j]);
    i = j;
  }
  /* drop points that barely change direction */
  const keep = [out[0]];
  for (let k = 1; k < out.length - 1; k++) {
    const a = keep[keep.length - 1], b = out[k], c = out[k + 1];
    const t1 = Math.atan2(b.x - a.x, b.y - a.y), t2 = Math.atan2(c.x - b.x, c.y - b.y);
    let dd = Math.abs((t1 - t2) * 180 / Math.PI);
    if (dd > 180) dd = 360 - dd;
    if (dd > 7 || Math.hypot(b.x - a.x, b.y - a.y) > 0.35) keep.push(b);
  }
  keep.push(out[out.length - 1]);
  return keep;
}

/* ---------- taxi routes for the session's active runways ---------- */
function rwyRec(fac, id) {
  for (const r of fac.runways) {
    if (r.id === id) return { thr: r.thr, end: r.end, hdg: r.hdg, len: r.len, w: r.w };
    if (r.recip === id) return { thr: r.end, end: r.thr, hdg: norm360(r.hdg + 180), len: r.len, w: r.w };
  }
  return null;
}
/* a point beside the runway at fraction f along it, offset toward the ramp */
function besideRunway(fac, R, f, off) {
  const p = { x: R.thr.x + (R.end.x - R.thr.x) * f, y: R.thr.y + (R.end.y - R.thr.y) * f };
  const perp = { x: Math.cos(d2r(R.hdg)), y: -Math.sin(d2r(R.hdg)) };
  const a = fac.gates.anchor;
  const s = Math.sign((a.x - p.x) * perp.x + (a.y - p.y) * perp.y) || 1;
  return { x: p.x + perp.x * off * s, y: p.y + perp.y * off * s };
}

function prepareRoutes(fac, arrId, depId) {
  if (!fac.real) return;                       // synthetic fields keep their network
  const g = buildGrid(fac);
  const anchor = fac.gates.anchor;
  fac.taxi = fac.taxi || {};

  /* departure: ramp to the hold short of the departure runway threshold */
  const D = rwyRec(fac, depId);
  if (D) {
    const hs = besideRunway(fac, D, 0.03, Math.max(D.w, 0.02) / 2 + 0.055);
    const s = snapCell(g, anchor), e = snapCell(g, hs);
    let path = (s && e) ? smooth(g, gridPath(g, s, e)) : null;
    if (!path || path.length < 2) path = [anchor, hs];
    fac.taxi[depId] = { names: routeName(fac, path, depId), path: path.slice(1) };
    fac.taxi[depId].holdShort = path[path.length - 1];
  }
  /* arrival: a midfield exit back to the ramp */
  const A = rwyRec(fac, arrId);
  if (A) {
    const exit = besideRunway(fac, A, 0.62, Math.max(A.w, 0.02) / 2 + 0.05);
    const s = snapCell(g, exit), e = snapCell(g, anchor);
    let path = (s && e) ? smooth(g, gridPath(g, s, e)) : null;
    if (!path || path.length < 2) path = [exit, anchor];
    fac.taxi["in_" + arrId] = {
      names: routeName(fac, path, arrId),
      exit: path[0],
      path: path.slice(1),
    };
  }
}

/* Taxiway naming: the real names are not in this dataset, so routes are
   described by the letters of the pavement they run along, assigned
   per facility by geographic order so they stay stable within a field. */
function routeName(fac, path, rwyId) {
  const L = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
  if (!fac.twyLetters) {
    fac.twyLetters = new Map();
    const big = fac.pav.twy
      .map((p, i) => ({ i, a: polyArea(p), c: polyCentroid(p) }))
      .filter(o => o.a > 0.0015)
      .sort((a, b) => (a.c.x + a.c.y) - (b.c.x + b.c.y));
    big.forEach((o, k) => fac.twyLetters.set(o.i, L[k % L.length]));
  }
  const seen = [];
  for (const p of path) {
    for (const [i, name] of fac.twyLetters) {
      if (seen.includes(name)) continue;
      if (pointInPoly(fac.pav.twy[i], p)) { seen.push(name); break; }
    }
    if (seen.length >= 3) break;
  }
  return seen.length ? seen.join(", ") : "the ramp";
}
function pointInPoly(flat, p) {
  let inside = false;
  for (let i = 0, n = flat.length / 2, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 2], yi = flat[i * 2 + 1], xj = flat[j * 2], yj = flat[j * 2 + 1];
    if ((yi > p.y) !== (yj > p.y) &&
        p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------- gate stands spread across the real ramp ---------- */
function gateSpots(fac, want) {
  if (fac.gateSpots && fac.gateSpots.length >= want) return fac.gateSpots;
  const spots = [];
  const src = (fac.pav && fac.pav.apr && fac.pav.apr.length) ? fac.pav.apr
            : (fac.pav && fac.pav.twy ? fac.pav.twy.filter(p => polyArea(p) > 0.004) : []);
  /* sample points inside the ramp polygons, biggest first */
  const ranked = src.map(p => ({ p, a: polyArea(p) })).sort((x, y) => y.a - x.a).slice(0, 6);
  for (const { p } of ranked) {
    const [x0, y0, x1, y1] = polyBounds(p);
    for (let tries = 0; tries < 400 && spots.length < want * 3; tries++) {
      const q = { x: x0 + Math.random() * (x1 - x0), y: y0 + Math.random() * (y1 - y0) };
      if (!pointInPoly(p, q)) continue;
      if (spots.some(s => Math.hypot(s.x - q.x, s.y - q.y) < 0.02)) continue;
      spots.push(q);
    }
    if (spots.length >= want * 3) break;
  }
  if (!spots.length) {
    const a = fac.gates.anchor;
    for (let i = 0; i < want; i++) {
      spots.push({ x: a.x + (Math.random() - 0.5) * 0.3, y: a.y + (Math.random() - 0.5) * 0.2 });
    }
  }
  fac.gateSpots = spots;
  return spots;
}
/* a free stand, so aircraft do not stack on one point */
function pickGateSpot(fac, taken) {
  const spots = gateSpots(fac, 24);
  const free = spots.filter(s => !taken.some(t => Math.hypot(t.x - s.x, t.y - s.y) < 0.018));
  const pool = free.length ? free : spots;
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

/* apply real geometry to every facility that has it */
if (typeof FACILITIES !== "undefined") FACILITIES.forEach(realizeFacility);
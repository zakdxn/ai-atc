/* =====================================================================
   AI ATC: facility database
   All 22 VATUSA facilities: the 20 CONUS ARTCCs plus ZAN (Anchorage)
   and HCF (Honolulu Control Facility). Three flagship airports (KJFK,
   KLAX, KATL) are hand-built with crossing-runway layouts; the rest are
   produced by makeFacility() from compact specs.
   Coordinates: nautical miles, airport reference point at origin,
   x = east, y = north. Geometry is a simplified approximation for
   gameplay, not navigational data.
   ===================================================================== */
"use strict";

const RATINGS = [
  { id: "S1", name: "Tower Trainee",     unlocks: ["DEL", "GND"], pts: 0,
    req: "Entry rating: Clearance Delivery & Ground." },
  { id: "S2", name: "Tower Controller",  unlocks: ["TWR"], pts: 20,
    req: "20 points working DEL/GND. Adds Tower (all airport positions)." },
  { id: "S3", name: "TMA Controller",    unlocks: ["APP"], pts: 50,
    req: "50 points. Adds Approach/Departure radar services." },
  { id: "C1", name: "Enroute Controller", unlocks: ["CTR"], pts: 90,
    req: "90 points. Adds Center, the enroute radar sectors." },
];

const POSITIONS = ["DEL", "GND", "TWR", "APP", "CTR"];
const POS_NAME = { DEL: "Clearance Delivery", GND: "Ground", TWR: "Tower", APP: "Approach/Departure", CTR: "Center" };
const POS_RATING = { DEL: "S1", GND: "S1", TWR: "S2", APP: "S3", CTR: "C1" };

const AIRLINES = [
  { code: "DAL", tel: "Delta" },      { code: "UAL", tel: "United" },
  { code: "AAL", tel: "American" },   { code: "SWA", tel: "Southwest" },
  { code: "JBU", tel: "JetBlue" },    { code: "ASA", tel: "Alaska" },
  { code: "FDX", tel: "FedEx" },      { code: "UPS", tel: "UPS" },
  { code: "BAW", tel: "Speedbird" },  { code: "DLH", tel: "Lufthansa" },
  { code: "ACA", tel: "Air Canada" }, { code: "AFR", tel: "Air France" },
  { code: "NKS", tel: "Spirit Wings" }, { code: "FFT", tel: "Frontier Flight" },
];

const TYPES = [
  { icao: "B738", heavy: false }, { icao: "A320", heavy: false },
  { icao: "A321", heavy: false }, { icao: "B739", heavy: false },
  { icao: "E175", heavy: false }, { icao: "CRJ9", heavy: false },
  { icao: "A20N", heavy: false }, { icao: "B39M", heavy: false },
  { icao: "B77W", heavy: true  }, { icao: "A359", heavy: true  },
  { icao: "B763", heavy: true  }, { icao: "A333", heavy: true  },
];

const DESTS = [
  { icao: "KBOS", city: "Boston" },        { icao: "KORD", city: "Chicago O'Hare" },
  { icao: "KMIA", city: "Miami" },         { icao: "KDFW", city: "Dallas Fort Worth" },
  { icao: "KDEN", city: "Denver" },        { icao: "KSEA", city: "Seattle" },
  { icao: "KSFO", city: "San Francisco" }, { icao: "KLAS", city: "Las Vegas" },
  { icao: "KMCO", city: "Orlando" },       { icao: "KPHX", city: "Phoenix" },
  { icao: "EGLL", city: "London Heathrow" }, { icao: "KJFK", city: "New York Kennedy" },
  { icao: "KLAX", city: "Los Angeles" },   { icao: "KATL", city: "Atlanta" },
  { icao: "KIAD", city: "Washington Dulles" }, { icao: "KIAH", city: "Houston" },
  { icao: "KMSP", city: "Minneapolis" },   { icao: "KDTW", city: "Detroit" },
  { icao: "KSLC", city: "Salt Lake City" }, { icao: "KMEM", city: "Memphis" },
  { icao: "KMCI", city: "Kansas City" },   { icao: "PANC", city: "Anchorage" },
  { icao: "PHNL", city: "Honolulu" },      { icao: "KJAX", city: "Jacksonville" },
];

/* ------------------------------------------------------------------ */
/* Runway from threshold coords, landing heading, length               */
function rwy(id, recip, tx, ty, hdg, len) {
  const r = Math.PI / 180;
  return { id, recip, thr: { x: tx, y: ty }, hdg,
           end: { x: tx + Math.sin(hdg * r) * len, y: ty + Math.cos(hdg * r) * len },
           len };
}

/* ------------------------------------------------------------------ */
/* Facility generator: builds runways, taxi routes, gates, configs and
   the fix ring from a compact spec. Convention: in a pair, runway "a"
   is the far (arrival) runway and "b" sits nearest the terminal, so
   generated taxi routes never cross the arrival runway.               */
const TW_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "Juliet", "Kilo", "Mike", "November", "Papa", "Romeo", "Sierra", "Tango", "Victor", "Whiskey"];

function makeFacility(s) {
  const rad = d => d * Math.PI / 180;
  const dir = { x: Math.sin(rad(s.hdg)), y: Math.cos(rad(s.hdg)) };
  const perp = { x: Math.cos(rad(s.hdg)), y: -Math.sin(rad(s.hdg)) };
  const len = s.len || 1.9;
  const sep = s.sep || 0.28;

  const mk = (id, recip, off) =>
    rwy(id, recip, perp.x * off - dir.x * len / 2, perp.y * off - dir.y * len / 2, s.hdg, len);
  const runways = s.pair
    ? [mk(s.pair.a, s.pair.ar, sep / 2), mk(s.pair.b, s.pair.br, -sep / 2)]
    : [mk(s.single.a, s.single.ar, 0)];

  const gOff = (s.pair ? sep / 2 : 0) + 0.34;
  const anchor = { x: -perp.x * gOff - dir.x * 0.1, y: -perp.y * gOff - dir.y * 0.1 };
  const towerPos = { x: anchor.x + dir.x * 0.18 + perp.x * 0.1, y: anchor.y + dir.y * 0.18 + perp.y * 0.1 };

  /* stable taxiway names derived from the icao */
  let hsh = 0;
  for (const c of s.icao) hsh = (hsh * 31 + c.charCodeAt(0)) % 997;
  const tw1 = TW_NAMES[hsh % TW_NAMES.length];
  const tw2 = TW_NAMES[(hsh + 7) % TW_NAMES.length];
  const names = tw1 === tw2 ? tw1 : `${tw1}, ${tw2}`;

  const resolve = id => {
    for (const r of runways) {
      if (r.id === id) return { thr: r.thr, hdg: r.hdg, len: r.len };
      if (r.recip === id) return { thr: r.end, hdg: (r.hdg + 180) % 360, len: r.len };
    }
    console.warn(`${s.icao}: unknown runway ${id}`);
    return null;
  };

  const taxi = {};
  for (const f of s.flows) {
    const D = resolve(f.dep);
    if (D && !taxi[f.dep]) {
      taxi[f.dep] = {
        names,
        path: [0.35, 0.65, 0.88, 1].map(t => ({
          x: anchor.x + (D.thr.x - anchor.x) * t,
          y: anchor.y + (D.thr.y - anchor.y) * t,
        })),
      };
    }
    const A = resolve(f.arr);
    if (A && !taxi["in_" + f.arr]) {
      const ad = { x: Math.sin(rad(A.hdg)), y: Math.cos(rad(A.hdg)) };
      const ap = { x: Math.cos(rad(A.hdg)), y: -Math.sin(rad(A.hdg)) };
      const base = { x: A.thr.x + ad.x * A.len * 0.58, y: A.thr.y + ad.y * A.len * 0.58 };
      const sgn = Math.sign((anchor.x - base.x) * ap.x + (anchor.y - base.y) * ap.y) || 1;
      const exit = { x: base.x + ap.x * 0.1 * sgn, y: base.y + ap.y * 0.1 * sgn };
      taxi["in_" + f.arr] = {
        names: tw1,
        exit,
        path: [0.45, 0.75].map(t => ({
          x: exit.x + (anchor.x - exit.x) * t,
          y: exit.y + (anchor.y - exit.y) * t,
        })),
      };
    }
  }

  const RADII = [42, 38, 44, 40];
  const fixes = s.fixes.map(([n, b], i) => ({
    name: n,
    x: Math.sin(rad(b)) * RADII[i % 4],
    y: Math.cos(rad(b)) * RADII[i % 4],
  }));
  const fixNames = fixes.map(f => f.name);
  for (const sd of s.sids) for (const e of sd.exits)
    if (!fixNames.includes(e)) console.warn(`${s.icao}: SID ${sd.name} exit ${e} not a fix`);
  for (const e of s.entry)
    if (!fixNames.includes(e)) console.warn(`${s.icao}: entry fix ${e} not a fix`);

  return {
    artcc: s.artcc, artccName: s.artccName,
    icao: s.icao, apName: s.apName,
    tracon: s.tracon, centerName: s.centerName, nextCenter: s.nextCenter,
    freqs: s.freqs,
    runways,
    configs: s.flows.map(f => ({
      name: f.name, arr: f.arr, dep: f.dep,
      windLo: ((f.wc - 80) % 360 + 360) % 360,
      windHi: ((f.wc + 80) % 360 + 360) % 360,
    })),
    gates: { anchor, prefix: s.gates || ["A", "B", "C"] },
    taxi, towerPos, fixes,
    entryFixes: s.entry,
    sids: s.sids, stars: s.stars,
    initAlt: s.initAlt || 5000,
  };
}

/* =====================================================================
   Hand-built flagships
   ===================================================================== */
const HAND_FACILITIES = [
{
  artcc: "ZNY", artccName: "New York ARTCC",
  icao: "KJFK", apName: "John F. Kennedy Intl",
  tracon: "New York Approach", centerName: "New York Center",
  nextCenter: "Boston Center",
  freqs: { DEL: "135.05", GND: "121.90", TWR: "119.10", APP: "127.40", CTR: "134.32" },
  runways: [
    rwy("31L", "13R", 0.70, -0.90, 310, 2.4),
    rwy("31R", "13L", 1.45, -0.30, 310, 2.0),
    rwy("22R", "04L", 0.95, 1.15, 220, 2.0),
    rwy("22L", "04R", 1.70, 0.55, 220, 1.4),
  ],
  configs: [
    { name: "31s", arr: "31R", dep: "31L", windLo: 255, windHi: 5 },
    { name: "22s", arr: "22L", dep: "22R", windLo: 165, windHi: 255 },
  ],
  gates: { anchor: { x: 0.28, y: 0.18 }, prefix: ["A", "B", "C"] },
  taxi: {
    "31L": { names: "Alpha, Bravo", path: [{ x: 0.30, y: 0.02 }, { x: 0.50, y: -0.35 }, { x: 0.63, y: -0.72 }, { x: 0.70, y: -0.90 }] },
    "22R": { names: "Alpha, Papa", path: [{ x: 0.38, y: 0.32 }, { x: 0.62, y: 0.70 }, { x: 0.88, y: 1.05 }, { x: 0.95, y: 1.15 }] },
    in_31R: { names: "Alpha", exit: { x: 0.20, y: 0.75 }, path: [{ x: 0.20, y: 0.55 }, { x: 0.25, y: 0.35 }] },
    in_22L: { names: "Bravo", exit: { x: 0.85, y: -0.30 }, path: [{ x: 0.60, y: -0.12 }, { x: 0.40, y: 0.05 }] },
  },
  towerPos: { x: 0.10, y: 0.05 },
  fixes: [
    { name: "LENDY", x: -30, y: 30 },  { name: "GREKI", x: 25, y: 34 },
    { name: "MERIT", x: 38, y: 16 },   { name: "ROBER", x: 42, y: -6 },
    { name: "WAVEY", x: 26, y: -32 },  { name: "CAMRN", x: -4, y: -42 },
    { name: "DIXIE", x: -32, y: -26 }, { name: "COATE", x: -42, y: 6 },
  ],
  entryFixes: ["LENDY", "CAMRN", "ROBER", "MERIT"],
  sids: [
    { name: "DEEZZ5", exits: ["COATE", "GREKI"] },
    { name: "SKORR4", exits: ["WAVEY", "DIXIE"] },
    { name: "JFK5",   exits: ["MERIT", "ROBER", "CAMRN"] },
  ],
  stars: ["LENDY6", "CAMRN4", "PARCH3"],
  initAlt: 5000,
},
{
  artcc: "ZLA", artccName: "Los Angeles ARTCC",
  icao: "KLAX", apName: "Los Angeles Intl",
  tracon: "SoCal Approach", centerName: "Los Angeles Center",
  nextCenter: "Oakland Center",
  freqs: { DEL: "121.40", GND: "121.75", TWR: "133.90", APP: "124.50", CTR: "124.15" },
  runways: [
    rwy("24R", "06L", 1.40, 0.62, 250, 1.5),
    rwy("24L", "06R", 1.45, 0.45, 250, 1.7),
    rwy("25R", "07L", 1.30, -0.42, 250, 2.0),
    rwy("25L", "07R", 1.35, -0.60, 250, 1.8),
  ],
  configs: [
    { name: "West Ops", arr: "24R", dep: "25R", windLo: 160, windHi: 340 },
    { name: "East Ops", arr: "06L", dep: "07L", windLo: 340, windHi: 160 },
  ],
  gates: { anchor: { x: 0.35, y: 0.02 }, prefix: ["1", "2", "4", "6"] },
  taxi: {
    "25R": { names: "Echo, Alfa-Alfa", path: [{ x: 0.45, y: -0.15 }, { x: 0.75, y: -0.30 }, { x: 1.15, y: -0.40 }, { x: 1.30, y: -0.42 }] },
    "07L": { names: "Charlie, Echo", path: [{ x: 0.30, y: -0.18 }, { x: 0.05, y: -0.35 }, { x: -0.45, y: -0.95 }, { x: -0.58, y: -1.10 }] },
    in_24R: { names: "Hotel", exit: { x: 0.35, y: 0.53 }, path: [{ x: 0.35, y: 0.30 }, { x: 0.35, y: 0.10 }] },
    in_06L: { names: "Golf", exit: { x: 1.15, y: 0.52 }, path: [{ x: 0.80, y: 0.30 }, { x: 0.45, y: 0.06 }] },
  },
  towerPos: { x: 0.15, y: 0.05 },
  fixes: [
    { name: "SADDE", x: -32, y: 26 },  { name: "VTU",   x: -42, y: 10 },
    { name: "HLYWD", x: 4, y: 42 },    { name: "DAG",   x: 30, y: 30 },
    { name: "TRM",   x: 42, y: -4 },   { name: "ANJLL", x: 28, y: -30 },
    { name: "SXC",   x: -8, y: -42 },  { name: "MOORR", x: -34, y: -24 },
  ],
  entryFixes: ["SADDE", "ANJLL", "DAG", "TRM"],
  sids: [
    { name: "SUMMR2", exits: ["VTU", "SADDE"] },
    { name: "ORCKA4", exits: ["TRM", "DAG"] },
    { name: "DOTSS2", exits: ["ANJLL", "SXC"] },
  ],
  stars: ["ANJLL4", "IRNMN2", "SADDE7"],
  initAlt: 5000,
},
{
  artcc: "ZTL", artccName: "Atlanta ARTCC",
  icao: "KATL", apName: "Hartsfield-Jackson Atlanta Intl",
  tracon: "Atlanta Approach", centerName: "Atlanta Center",
  nextCenter: "Jacksonville Center",
  freqs: { DEL: "118.10", GND: "121.90", TWR: "119.50", APP: "127.90", CTR: "134.50" },
  runways: [
    rwy("26R", "08L", 1.00, 0.55, 270, 1.9),
    rwy("26L", "08R", 1.00, 0.40, 270, 1.8),
    rwy("27R", "09L", 1.05, -0.40, 270, 1.8),
    rwy("27L", "09R", 1.05, -0.55, 270, 2.0),
  ],
  configs: [
    { name: "West Flow", arr: "27L", dep: "26R", windLo: 180, windHi: 360 },
    { name: "East Flow", arr: "09R", dep: "08L", windLo: 0, windHi: 180 },
  ],
  gates: { anchor: { x: 0.05, y: 0.0 }, prefix: ["A", "B", "D", "T"] },
  taxi: {
    "26R": { names: "Victor, November", path: [{ x: 0.15, y: 0.20 }, { x: 0.45, y: 0.40 }, { x: 0.85, y: 0.52 }, { x: 1.00, y: 0.55 }] },
    "08L": { names: "Echo, November", path: [{ x: -0.15, y: 0.20 }, { x: -0.50, y: 0.40 }, { x: -0.80, y: 0.52 }, { x: -0.90, y: 0.55 }] },
    in_27L: { names: "Victor", exit: { x: -0.55, y: -0.47 }, path: [{ x: -0.35, y: -0.25 }, { x: -0.10, y: -0.08 }] },
    in_09R: { names: "Echo", exit: { x: 0.65, y: -0.47 }, path: [{ x: 0.40, y: -0.25 }, { x: 0.12, y: -0.08 }] },
  },
  towerPos: { x: 0.0, y: 0.1 },
  fixes: [
    { name: "ERLIN", x: -30, y: 30 },  { name: "DIRTY", x: 28, y: 32 },
    { name: "POUNC", x: 42, y: 4 },    { name: "CUTTN", x: 30, y: -28 },
    { name: "JACCC", x: -2, y: -42 },  { name: "PADGT", x: -32, y: -26 },
    { name: "VARNM", x: -42, y: 2 },   { name: "HOBTT", x: 6, y: 42 },
  ],
  entryFixes: ["ERLIN", "DIRTY", "CUTTN", "PADGT"],
  sids: [
    { name: "POUNC2", exits: ["POUNC", "DIRTY"] },
    { name: "CUTTN2", exits: ["CUTTN", "JACCC"] },
    { name: "VARNM2", exits: ["VARNM", "ERLIN"] },
  ],
  stars: ["CHPPR1", "HOBTT2", "OZZZI1"],
  initAlt: 10000,
},
];

/* =====================================================================
   Generated facilities: the rest of the US
   ===================================================================== */
const FACILITY_SPECS = [
{
  artcc: "ZAB", artccName: "Albuquerque ARTCC",
  icao: "KPHX", apName: "Phoenix Sky Harbor Intl",
  tracon: "Phoenix Approach", centerName: "Albuquerque Center", nextCenter: "Los Angeles Center",
  freqs: { DEL: "118.10", GND: "132.55", TWR: "118.70", APP: "124.10", CTR: "127.85" },
  hdg: 250, len: 1.9, pair: { a: "25L", ar: "07R", b: "25R", br: "07L" },
  flows: [
    { name: "West Flow", arr: "25L", dep: "25R", wc: 250 },
    { name: "East Flow", arr: "07R", dep: "07L", wc: 70 },
  ],
  fixes: [["ZONNA", 15], ["HYDRR", 65], ["BUNTR", 110], ["EAGUL", 150],
          ["GEELA", 195], ["BLYTH", 255], ["ARLIN", 300], ["SNOBL", 340]],
  entry: ["EAGUL", "ARLIN", "SNOBL", "BUNTR"],
  sids: [
    { name: "ZEPER2", exits: ["BLYTH", "ARLIN"] },
    { name: "KEENS2", exits: ["HYDRR", "ZONNA"] },
    { name: "FTHLS2", exits: ["GEELA", "EAGUL"] },
  ],
  stars: ["EAGUL6", "BRUSR1", "GEELA6"], initAlt: 7000,
},
{
  artcc: "ZAN", artccName: "Anchorage ARTCC",
  icao: "PANC", apName: "Ted Stevens Anchorage Intl",
  tracon: "Anchorage Approach", centerName: "Anchorage Center", nextCenter: "Oakland Oceanic",
  freqs: { DEL: "119.40", GND: "121.90", TWR: "118.30", APP: "118.60", CTR: "119.10" },
  hdg: 70, len: 1.9, pair: { a: "07R", ar: "25L", b: "07L", br: "25R" },
  flows: [
    { name: "East Flow", arr: "07R", dep: "07L", wc: 70 },
    { name: "West Flow", arr: "25L", dep: "25R", wc: 250 },
  ],
  fixes: [["TAGER", 25], ["PALMR", 65], ["WHITT", 110], ["KENAY", 160],
          ["HOMRR", 210], ["SUSIT", 260], ["DENAL", 315], ["YUKLA", 355]],
  entry: ["KENAY", "SUSIT", "DENAL", "PALMR"],
  sids: [
    { name: "ANCH3",  exits: ["YUKLA", "TAGER"] },
    { name: "KNIKK2", exits: ["DENAL", "SUSIT"] },
    { name: "TURNA2", exits: ["HOMRR", "WHITT"] },
  ],
  stars: ["YESKA2", "HOMRR3", "DENAL1"], initAlt: 4000,
},
{
  artcc: "ZAU", artccName: "Chicago ARTCC",
  icao: "KORD", apName: "Chicago O'Hare Intl",
  tracon: "Chicago Approach", centerName: "Chicago Center", nextCenter: "Minneapolis Center",
  freqs: { DEL: "121.60", GND: "121.90", TWR: "126.90", APP: "119.00", CTR: "120.35" },
  hdg: 270, len: 2.0, pair: { a: "27L", ar: "09R", b: "27R", br: "09L" },
  flows: [
    { name: "West Flow", arr: "27L", dep: "27R", wc: 270 },
    { name: "East Flow", arr: "09R", dep: "09L", wc: 90 },
  ],
  fixes: [["PETTY", 20], ["WYNDE", 70], ["BENKY", 110], ["FYTTE", 160],
          ["PAITN", 200], ["MYKIE", 250], ["PLANO", 290], ["WATSN", 335]],
  entry: ["WYNDE", "BENKY", "PAITN", "WATSN"],
  sids: [
    { name: "ORD8",   exits: ["PETTY", "PLANO"] },
    { name: "PEKUE2", exits: ["MYKIE", "FYTTE"] },
    { name: "DENNT2", exits: ["WYNDE", "WATSN"] },
  ],
  stars: ["WATSN2", "BENKY3", "TRTLL4"], initAlt: 5000,
},
{
  artcc: "ZBW", artccName: "Boston ARTCC",
  icao: "KBOS", apName: "Boston Logan Intl",
  tracon: "Boston Approach", centerName: "Boston Center", nextCenter: "New York Center",
  freqs: { DEL: "121.65", GND: "121.90", TWR: "128.80", APP: "118.25", CTR: "128.20" },
  hdg: 35, len: 1.8, pair: { a: "04R", ar: "22L", b: "04L", br: "22R" },
  flows: [
    { name: "Northeast Flow", arr: "04R", dep: "04L", wc: 35 },
    { name: "Southwest Flow", arr: "22L", dep: "22R", wc: 215 },
  ],
  fixes: [["BRONC", 10], ["OOSHN", 80], ["ROBUC", 160], ["JFUND", 210],
          ["PVD", 235], ["WOONS", 280], ["GDM", 305], ["CAMBR", 340]],
  entry: ["ROBUC", "OOSHN", "JFUND", "WOONS"],
  sids: [
    { name: "SSOXS5", exits: ["PVD", "JFUND"] },
    { name: "HYLND5", exits: ["GDM", "BRONC"] },
    { name: "PATSS3", exits: ["OOSHN", "CAMBR"] },
  ],
  stars: ["ROBUC3", "JFUND2", "OOSHN5"], initAlt: 5000,
},
{
  artcc: "ZDC", artccName: "Washington ARTCC",
  icao: "KIAD", apName: "Washington Dulles Intl",
  tracon: "Potomac Approach", centerName: "Washington Center", nextCenter: "New York Center",
  freqs: { DEL: "127.35", GND: "121.90", TWR: "120.10", APP: "126.10", CTR: "134.15" },
  hdg: 10, len: 2.0, pair: { a: "01R", ar: "19L", b: "01L", br: "19R" },
  flows: [
    { name: "North Flow", arr: "01R", dep: "01L", wc: 10 },
    { name: "South Flow", arr: "19L", dep: "19R", wc: 190 },
  ],
  fixes: [["GIBBZ", 20], ["SWANN", 60], ["DOCCS", 110], ["BARIN", 150],
          ["CAVLR", 200], ["JCOBY", 245], ["WOOLY", 290], ["FRDMM", 330]],
  entry: ["GIBBZ", "DOCCS", "CAVLR", "WOOLY"],
  sids: [
    { name: "RNLDI2", exits: ["JCOBY", "FRDMM"] },
    { name: "SCRAM2", exits: ["SWANN", "BARIN"] },
    { name: "CLTCH2", exits: ["WOOLY", "CAVLR"] },
  ],
  stars: ["GIBBZ4", "DOCCS3", "CAVLR4"], initAlt: 5000,
},
{
  artcc: "ZDV", artccName: "Denver ARTCC",
  icao: "KDEN", apName: "Denver Intl",
  tracon: "Denver Approach", centerName: "Denver Center", nextCenter: "Kansas City Center",
  freqs: { DEL: "118.75", GND: "121.85", TWR: "133.30", APP: "120.35", CTR: "128.65" },
  hdg: 350, len: 2.1, pair: { a: "34R", ar: "16L", b: "34L", br: "16R" },
  flows: [
    { name: "North Flow", arr: "34R", dep: "34L", wc: 350 },
    { name: "South Flow", arr: "16L", dep: "16R", wc: 170 },
  ],
  fixes: [["POWDR", 25], ["LANDR", 75], ["SMTTY", 115], ["LARKS", 160],
          ["RAMMS", 205], ["TSHNR", 255], ["ELORA", 300], ["DANDD", 345]],
  entry: ["LANDR", "LARKS", "RAMMS", "ELORA"],
  sids: [
    { name: "PIKES2", exits: ["TSHNR", "RAMMS"] },
    { name: "ROCKI2", exits: ["POWDR", "DANDD"] },
    { name: "YOTES2", exits: ["SMTTY", "ELORA"] },
  ],
  stars: ["POWDR1", "LANDR8", "SMTTY2"], initAlt: 10000,
},
{
  artcc: "ZFW", artccName: "Fort Worth ARTCC",
  icao: "KDFW", apName: "Dallas Fort Worth Intl",
  tracon: "Regional Approach", centerName: "Fort Worth Center", nextCenter: "Houston Center",
  freqs: { DEL: "128.25", GND: "121.65", TWR: "126.55", APP: "125.80", CTR: "132.42" },
  hdg: 175, len: 2.1, sep: 0.3, pair: { a: "17C", ar: "35C", b: "17R", br: "35L" },
  gates: ["A", "B", "C", "D", "E"],
  flows: [
    { name: "South Flow", arr: "17C", dep: "17R", wc: 175 },
    { name: "North Flow", arr: "35C", dep: "35L", wc: 355 },
  ],
  fixes: [["GRABE", 15], ["BONHM", 60], ["YEAGR", 105], ["FERRA", 150],
          ["JOVEM", 195], ["BOOVE", 240], ["GLEND", 285], ["MUENS", 330]],
  entry: ["BONHM", "FERRA", "BOOVE", "GLEND"],
  sids: [
    { name: "DARTZ2", exits: ["GRABE", "YEAGR"] },
    { name: "LOWGN2", exits: ["JOVEM", "MUENS"] },
    { name: "TRYTN2", exits: ["GLEND", "BONHM"] },
  ],
  stars: ["BONHM3", "SEEVR4", "JOVEM1"], initAlt: 5000,
},
{
  artcc: "ZHU", artccName: "Houston ARTCC",
  icao: "KIAH", apName: "George Bush Intercontinental",
  tracon: "Houston Approach", centerName: "Houston Center", nextCenter: "Fort Worth Center",
  freqs: { DEL: "121.25", GND: "121.70", TWR: "125.35", APP: "120.05", CTR: "132.80" },
  hdg: 265, len: 2.0, pair: { a: "26L", ar: "08R", b: "26R", br: "08L" },
  flows: [
    { name: "West Flow", arr: "26L", dep: "26R", wc: 265 },
    { name: "East Flow", arr: "08R", dep: "08L", wc: 85 },
  ],
  fixes: [["MSCOT", 25], ["TORNN", 70], ["BAYYY", 115], ["GLAND", 160],
          ["RICEE", 205], ["KAGLE", 250], ["BLUBL", 295], ["DRLLR", 340]],
  entry: ["TORNN", "GLAND", "KAGLE", "BLUBL"],
  sids: [
    { name: "TXANA2", exits: ["MSCOT", "DRLLR"] },
    { name: "WLBRN2", exits: ["BAYYY", "RICEE"] },
    { name: "GSHER2", exits: ["TORNN", "GLAND"] },
  ],
  stars: ["DRLLR2", "GUSHR3", "BAYYY1"], initAlt: 4000,
},
{
  artcc: "ZID", artccName: "Indianapolis ARTCC",
  icao: "KIND", apName: "Indianapolis Intl",
  tracon: "Indy Approach", centerName: "Indianapolis Center", nextCenter: "Chicago Center",
  freqs: { DEL: "128.75", GND: "121.80", TWR: "120.90", APP: "124.95", CTR: "134.00" },
  hdg: 230, len: 1.9, pair: { a: "23L", ar: "05R", b: "23R", br: "05L" },
  flows: [
    { name: "Southwest Flow", arr: "23L", dep: "23R", wc: 230 },
    { name: "Northeast Flow", arr: "05R", dep: "05L", wc: 50 },
  ],
  fixes: [["SPEED", 20], ["BRCKY", 65], ["PACER", 110], ["MILEY", 155],
          ["GASGN", 200], ["TRURN", 245], ["WABSH", 290], ["HOOSR", 335]],
  entry: ["BRCKY", "MILEY", "TRURN", "HOOSR"],
  sids: [
    { name: "INDYY2", exits: ["SPEED", "PACER"] },
    { name: "BRKYD2", exits: ["GASGN", "WABSH"] },
    { name: "OVALL2", exits: ["SPEED", "GASGN"] },
  ],
  stars: ["SNKPT2", "RODEX3", "COLTS2"], initAlt: 5000,
},
{
  artcc: "ZJX", artccName: "Jacksonville ARTCC",
  icao: "KJAX", apName: "Jacksonville Intl",
  tracon: "Jacksonville Approach", centerName: "Jacksonville Center", nextCenter: "Miami Center",
  freqs: { DEL: "118.30", GND: "121.90", TWR: "118.70", APP: "124.90", CTR: "127.87" },
  hdg: 80, len: 1.7, single: { a: "08", ar: "26" },
  flows: [
    { name: "East Flow", arr: "08", dep: "08", wc: 80 },
    { name: "West Flow", arr: "26", dep: "26", wc: 260 },
  ],
  fixes: [["SAWGR", 25], ["MAYPO", 70], ["ATLIC", 115], ["STAUG", 160],
          ["GATRZ", 205], ["OSPRY", 250], ["SWAMP", 295], ["DIXON", 340]],
  entry: ["MAYPO", "STAUG", "OSPRY", "DIXON"],
  sids: [
    { name: "JAXX2",  exits: ["SAWGR", "ATLIC"] },
    { name: "TEBOW2", exits: ["GATRZ", "SWAMP"] },
    { name: "RIVRR2", exits: ["SAWGR", "GATRZ"] },
  ],
  stars: ["MAYPO2", "STAUG3", "OSPRY1"], initAlt: 4000,
},
{
  artcc: "ZKC", artccName: "Kansas City ARTCC",
  icao: "KMCI", apName: "Kansas City Intl",
  tracon: "Kansas City Approach", centerName: "Kansas City Center", nextCenter: "Chicago Center",
  freqs: { DEL: "135.70", GND: "121.80", TWR: "128.20", APP: "118.90", CTR: "134.90" },
  hdg: 10, len: 1.9, pair: { a: "01R", ar: "19L", b: "01L", br: "19R" },
  flows: [
    { name: "North Flow", arr: "01R", dep: "01L", wc: 10 },
    { name: "South Flow", arr: "19L", dep: "19R", wc: 190 },
  ],
  fixes: [["ROYAL", 25], ["CHIEF", 70], ["TRUMN", 115], ["OZARK", 160],
          ["JAYHK", 205], ["PLAIN", 250], ["WHEAT", 295], ["BARBQ", 340]],
  entry: ["CHIEF", "OZARK", "PLAIN", "BARBQ"],
  sids: [
    { name: "ROYLS2", exits: ["ROYAL", "WHEAT"] },
    { name: "TRMAN2", exits: ["TRUMN", "JAYHK"] },
    { name: "PRAIR2", exits: ["WHEAT", "ROYAL"] },
  ],
  stars: ["CHIEF2", "OZARK4", "JAYHK1"], initAlt: 5000,
},
{
  artcc: "ZLC", artccName: "Salt Lake ARTCC",
  icao: "KSLC", apName: "Salt Lake City Intl",
  tracon: "Salt Lake Approach", centerName: "Salt Lake Center", nextCenter: "Denver Center",
  freqs: { DEL: "127.30", GND: "121.90", TWR: "118.30", APP: "126.25", CTR: "133.60" },
  hdg: 165, len: 2.0, pair: { a: "16L", ar: "34R", b: "16R", br: "34L" },
  flows: [
    { name: "South Flow", arr: "16L", dep: "16R", wc: 165 },
    { name: "North Flow", arr: "34R", dep: "34L", wc: 345 },
  ],
  fixes: [["OGDEN", 5], ["WASCH", 55], ["PARKK", 100], ["PROVO", 150],
          ["DSERT", 200], ["BONVL", 250], ["LAKEY", 300], ["ANTLP", 340]],
  entry: ["WASCH", "PROVO", "BONVL", "LAKEY"],
  sids: [
    { name: "ZIONS2", exits: ["DSERT", "ANTLP"] },
    { name: "GOLDN2", exits: ["OGDEN", "PARKK"] },
    { name: "POWDN2", exits: ["PARKK", "OGDEN"] },
  ],
  stars: ["WASCH3", "PROVO2", "BONVL1"], initAlt: 9000,
},
{
  artcc: "ZMA", artccName: "Miami ARTCC",
  icao: "KMIA", apName: "Miami Intl",
  tracon: "Miami Approach", centerName: "Miami Center", nextCenter: "Jacksonville Center",
  freqs: { DEL: "135.35", GND: "121.80", TWR: "123.90", APP: "124.85", CTR: "132.45" },
  hdg: 85, len: 2.0, pair: { a: "08R", ar: "26L", b: "08L", br: "26R" },
  flows: [
    { name: "East Flow", arr: "08R", dep: "08L", wc: 85 },
    { name: "West Flow", arr: "26L", dep: "26R", wc: 265 },
  ],
  fixes: [["HILEY", 20], ["DEEEP", 70], ["BSTER", 115], ["LARGO", 160],
          ["CURSO", 205], ["SSCOT", 250], ["GLADZ", 295], ["FLIPR", 340]],
  entry: ["HILEY", "CURSO", "SSCOT", "FLIPR"],
  sids: [
    { name: "VALLY2", exits: ["GLADZ", "BSTER"] },
    { name: "WINCO2", exits: ["DEEEP", "LARGO"] },
    { name: "MNATE2", exits: ["LARGO", "GLADZ"] },
  ],
  stars: ["FLIPR4", "HILEY6", "CURSO1"], initAlt: 5000,
},
{
  artcc: "ZME", artccName: "Memphis ARTCC",
  icao: "KMEM", apName: "Memphis Intl",
  tracon: "Memphis Approach", centerName: "Memphis Center", nextCenter: "Atlanta Center",
  freqs: { DEL: "125.20", GND: "121.90", TWR: "118.30", APP: "124.15", CTR: "120.80" },
  hdg: 180, len: 2.0, pair: { a: "18R", ar: "36L", b: "18L", br: "36R" },
  flows: [
    { name: "South Flow", arr: "18R", dep: "18L", wc: 180 },
    { name: "North Flow", arr: "36L", dep: "36R", wc: 0 },
  ],
  fixes: [["ELVIS", 25], ["TUPLO", 70], ["BLUSS", 115], ["TUNIC", 160],
          ["RIVRB", 205], ["OZRKA", 250], ["GRACE", 295], ["BEALE", 340]],
  entry: ["TUPLO", "TUNIC", "OZRKA", "BEALE"],
  sids: [
    { name: "SOULL2", exits: ["ELVIS", "GRACE"] },
    { name: "BLUES2", exits: ["BLUSS", "RIVRB"] },
    { name: "KINGG2", exits: ["GRACE", "ELVIS"] },
  ],
  stars: ["ELVSS2", "BEALE3", "TUNIC1"], initAlt: 4000,
},
{
  artcc: "ZMP", artccName: "Minneapolis ARTCC",
  icao: "KMSP", apName: "Minneapolis-St. Paul Intl",
  tracon: "Minneapolis Approach", centerName: "Minneapolis Center", nextCenter: "Chicago Center",
  freqs: { DEL: "133.20", GND: "121.90", TWR: "126.70", APP: "119.30", CTR: "134.85" },
  hdg: 300, len: 2.0, pair: { a: "30L", ar: "12R", b: "30R", br: "12L" },
  flows: [
    { name: "Northwest Flow", arr: "30L", dep: "30R", wc: 300 },
    { name: "Southeast Flow", arr: "12R", dep: "12L", wc: 120 },
  ],
  fixes: [["NORDY", 10], ["SKETR", 55], ["EAUCL", 100], ["ROCHH", 145],
          ["ALBRT", 190], ["MNKTO", 235], ["WLMAR", 280], ["BRNRD", 325]],
  entry: ["SKETR", "ROCHH", "MNKTO", "BRNRD"],
  sids: [
    { name: "LOONN2", exits: ["NORDY", "WLMAR"] },
    { name: "VIKNG2", exits: ["EAUCL", "ALBRT"] },
    { name: "PAULB2", exits: ["WLMAR", "NORDY"] },
  ],
  stars: ["SKETR2", "ROCHH3", "MNKTO1"], initAlt: 5000,
},
{
  artcc: "ZOA", artccName: "Oakland ARTCC",
  icao: "KSFO", apName: "San Francisco Intl",
  tracon: "NorCal Approach", centerName: "Oakland Center", nextCenter: "Seattle Center",
  freqs: { DEL: "118.20", GND: "121.80", TWR: "120.50", APP: "135.65", CTR: "127.80" },
  hdg: 280, len: 2.1, pair: { a: "28R", ar: "10L", b: "28L", br: "10R" },
  flows: [
    { name: "West Flow", arr: "28R", dep: "28L", wc: 280 },
    { name: "East Flow", arr: "10L", dep: "10R", wc: 100 },
  ],
  fixes: [["BDEGA", 315], ["STINS", 350], ["SACRA", 30], ["DYAMD", 75],
          ["MODDS", 120], ["SERFR", 165], ["STLER", 210], ["PIRAT", 265]],
  entry: ["BDEGA", "DYAMD", "SERFR", "STLER"],
  sids: [
    { name: "TRUKN2", exits: ["SACRA", "STINS"] },
    { name: "SSTIK2", exits: ["DYAMD", "MODDS"] },
    { name: "OFFSH2", exits: ["PIRAT", "STLER"] },
  ],
  stars: ["SERFR4", "DYAMD4", "BDEGA3"], initAlt: 5000,
},
{
  artcc: "ZOB", artccName: "Cleveland ARTCC",
  icao: "KDTW", apName: "Detroit Metropolitan Wayne County",
  tracon: "Detroit Approach", centerName: "Cleveland Center", nextCenter: "Chicago Center",
  freqs: { DEL: "120.65", GND: "119.45", TWR: "135.00", APP: "118.95", CTR: "126.42" },
  hdg: 220, len: 2.0, pair: { a: "22L", ar: "04R", b: "22R", br: "04L" },
  flows: [
    { name: "Southwest Flow", arr: "22L", dep: "22R", wc: 220 },
    { name: "Northeast Flow", arr: "04R", dep: "04L", wc: 40 },
  ],
  fixes: [["MOTWN", 15], ["HURON", 60], ["ERIEE", 105], ["TOLDO", 150],
          ["WOLVN", 195], ["KALMZ", 240], ["LNSNG", 285], ["SGNAW", 330]],
  entry: ["HURON", "TOLDO", "KALMZ", "SGNAW"],
  sids: [
    { name: "PISTN2", exits: ["MOTWN", "LNSNG"] },
    { name: "REDWG2", exits: ["ERIEE", "WOLVN"] },
    { name: "TIGRR2", exits: ["LNSNG", "MOTWN"] },
  ],
  stars: ["HURON3", "KALMZ2", "TOLDO1"], initAlt: 5000,
},
{
  artcc: "ZSE", artccName: "Seattle ARTCC",
  icao: "KSEA", apName: "Seattle-Tacoma Intl",
  tracon: "Seattle Approach", centerName: "Seattle Center", nextCenter: "Oakland Center",
  freqs: { DEL: "128.00", GND: "121.70", TWR: "119.90", APP: "119.20", CTR: "120.10" },
  hdg: 160, len: 2.0, pair: { a: "16R", ar: "34L", b: "16L", br: "34R" },
  flows: [
    { name: "South Flow", arr: "16R", dep: "16L", wc: 160 },
    { name: "North Flow", arr: "34L", dep: "34R", wc: 340 },
  ],
  fixes: [["PAINE", 355], ["CHINS", 45], ["RADDY", 90], ["SUMMA", 135],
          ["RAINI", 180], ["OLYMP", 225], ["MARNR", 270], ["HAROB", 315]],
  entry: ["CHINS", "RAINI", "MARNR", "HAROB"],
  sids: [
    { name: "SUMMA2", exits: ["SUMMA", "RADDY"] },
    { name: "BANGR2", exits: ["PAINE", "HAROB"] },
    { name: "MONTN2", exits: ["RADDY", "OLYMP"] },
  ],
  stars: ["CHINS2", "HAWKZ8", "MARNR2"], initAlt: 5000,
},
{
  artcc: "HCF", artccName: "Honolulu Control Facility",
  icao: "PHNL", apName: "Daniel K. Inouye Intl",
  tracon: "Honolulu Approach", centerName: "Honolulu Control", nextCenter: "Oakland Oceanic",
  freqs: { DEL: "121.40", GND: "121.90", TWR: "118.10", APP: "118.30", CTR: "124.80" },
  hdg: 80, len: 2.0, pair: { a: "08L", ar: "26R", b: "08R", br: "26L" },
  flows: [
    { name: "Trade Winds", arr: "08L", dep: "08R", wc: 80 },
    { name: "Kona Winds", arr: "26R", dep: "26L", wc: 260 },
  ],
  fixes: [["OPANA", 5], ["KOKOH", 50], ["MOLOK", 95], ["MAUII", 130],
          ["LANAI", 170], ["BARBR", 225], ["KAENA", 285], ["KAULA", 330]],
  entry: ["MOLOK", "LANAI", "KAENA", "OPANA"],
  sids: [
    { name: "KEOLA2", exits: ["BARBR", "KAULA"] },
    { name: "PALEH2", exits: ["KOKOH", "OPANA"] },
    { name: "MKUEA2", exits: ["MAUII", "MOLOK"] },
  ],
  stars: ["BOOKE2", "CLUTS2", "LNDHI1"], initAlt: 5000,
},
];

const FACILITIES = [...HAND_FACILITIES, ...FACILITY_SPECS.map(makeFacility)]
  .sort((a, b) => a.artcc.localeCompare(b.artcc));

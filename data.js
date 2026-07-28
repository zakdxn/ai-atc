/* =====================================================================
   ZEAL ATC — facility database
   ARTCCs, airports, runways, taxi routes, fixes, SIDs, frequencies.
   Coordinates: nautical miles, airport reference point at origin,
   x = east, y = north. Runways given as thr (threshold of the named
   end) plus landing heading and length.
   ===================================================================== */
"use strict";

const RATINGS = [
  { id: "S1", name: "Tower Trainee",     unlocks: ["DEL", "GND"], pts: 0,
    req: "Entry rating — Clearance Delivery & Ground." },
  { id: "S2", name: "Tower Controller",  unlocks: ["TWR"], pts: 20,
    req: "20 points working DEL/GND. Adds Tower (all airport positions)." },
  { id: "S3", name: "TMA Controller",    unlocks: ["APP"], pts: 50,
    req: "50 points. Adds Approach/Departure radar services." },
  { id: "C1", name: "Enroute Controller", unlocks: ["CTR"], pts: 90,
    req: "90 points. Adds Center — enroute radar sectors." },
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
];

/* ------------------------------------------------------------------ */
/* Airport geometry helper: runway from threshold, landing hdg, length */
function rwy(id, recip, tx, ty, hdg, len) {
  const r = Math.PI / 180;
  return { id, recip, thr: { x: tx, y: ty }, hdg,
           end: { x: tx + Math.sin(hdg * r) * len, y: ty + Math.cos(hdg * r) * len },
           len };
}

const FACILITIES = [
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

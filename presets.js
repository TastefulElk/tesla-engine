// Engine definitions. `fires` lists when each cylinder fires as a fraction of one
// engine cycle (720° for a piston engine, one eccentric-shaft turn for the rotary)
// and which exhaust bank it feeds. `res` are exhaust resonances: [Hz, Q, gain].

const crossPlaneV8 = [0, 1, 1, 0, 1, 0, 0, 1].map((b, i) => ({ f: i / 8, b }));
const flatPlaneV8 = [0, 1, 0, 1, 0, 1, 0, 1].map((b, i) => ({ f: i / 8, b }));
const inlineSix = [0, 1, 2, 3, 4, 5].map((i) => ({ f: i / 6, b: 0 }));
const twinRotor = [
  { f: 0, b: 0 },
  { f: 0.5, b: 1 },
];

const PRESETS = [
  {
    id: "v8tt",
    name: "V8 Twin Turbo",
    sub: "Cross-plane, 4.0 L",
    fires: crossPlaneV8,
    cycleDiv: 120,
    bankGain: [1, 0.74],
    bankDetune: [1, 1.14],
    idle: 720,
    redline: 7000,
    turbo: 0.85,
    res: [
      [105, 1.2, 1],
      [410, 2.4, 0.45],
      [1150, 3, 0.15],
    ],
    muffle: [650, 3400],
    tau: 0.0036,
    rough: 0.22,
    drive: [1.2, 3],
    pops: 1,
    gain: 2.2,
    gears: [3.5, 2.2, 1.55, 1.2, 1, 0.82, 0.68],
    final: 4.5,
  },
  {
    id: "v8fp",
    name: "Flat-plane V8",
    sub: "Naturally aspirated, 8,500 rpm",
    fires: flatPlaneV8,
    cycleDiv: 120,
    bankGain: [1, 0.95],
    bankDetune: [1, 1.03],
    idle: 950,
    redline: 8500,
    turbo: 0,
    res: [
      [160, 1.4, 1],
      [650, 3, 0.6],
      [1700, 4, 0.3],
    ],
    muffle: [1100, 5600],
    tau: 0.0022,
    rough: 0.1,
    drive: [1.5, 4],
    pops: 0.6,
    gain: 2.2,
    gears: [3.3, 2.15, 1.6, 1.28, 1.06, 0.9, 0.76],
    final: 5,
  },
  {
    id: "i6t",
    name: "Turbo Inline-Six",
    sub: "Big single turbo, 3.0 L",
    fires: inlineSix,
    cycleDiv: 120,
    idle: 780,
    redline: 7200,
    turbo: 1,
    res: [
      [130, 1.3, 1],
      [520, 2.8, 0.55],
      [1400, 3.5, 0.25],
    ],
    muffle: [850, 4200],
    tau: 0.0028,
    rough: 0.14,
    drive: [1.3, 3.5],
    pops: 1,
    gain: 2.2,
    gears: [4.1, 2.6, 1.75, 1.3, 1, 0.84],
    final: 4.4,
  },
  {
    id: "rot",
    name: "Rotary Turbo",
    sub: "Twin-rotor, 9,000 rpm",
    fires: twinRotor,
    cycleDiv: 60,
    bankGain: [1, 0.9],
    bankDetune: [1, 1.06],
    idle: 1000,
    redline: 9000,
    turbo: 0.9,
    res: [
      [180, 1.1, 1],
      [800, 2.2, 0.7],
      [2200, 3, 0.35],
    ],
    muffle: [1400, 6500],
    tau: 0.0019,
    rough: 0.45,
    drive: [2, 5],
    pops: 1.4,
    gain: 1.5,
    gears: [3.48, 2.02, 1.39, 1, 0.72],
    final: 5.4,
  },
];

if (typeof module === "object") module.exports = { PRESETS };

// Drives the engine synth from GPS speed and shows raw sensor diagnostics.

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

const WHEEL_RADIUS = 0.33;
const MOVING = 0.8; // m/s

const store = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  preset: PRESETS.find((p) => p.id === store.get("preset", "v8tt")) || PRESETS[0],
  vol: store.get("vol", 0.8),
  drama: store.get("drama", 1),
  running: false,
  source: "gps",
  fix: null,
  accel: 0,
  v: 0,
  gear: 0,
  rpm: 0,
  load: 0,
  boost: 0,
  overrun: 0,
  liftArm: 0,
  shiftT: 0,
  blipT: 0,
  limiterT: 0,
  startT: 0,
  revHeld: false,
};

// ---------- audio ----------

let ctx = null;
let post = () => {};
let audioMode = "off";

const initAudio = async () => {
  ctx = new AudioContext({ latencyHint: "interactive" });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 8;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  comp.connect(ctx.destination);
  try {
    await ctx.audioWorklet.addModule("dsp.js");
    const node = new AudioWorkletNode(ctx, "engine", { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(comp);
    post = (m) => node.port.postMessage(m);
    audioMode = "AudioWorklet";
  } catch (err) {
    const dsp = new EngineDSP(ctx.sampleRate);
    const sp = ctx.createScriptProcessor(1024, 1, 2);
    sp.onaudioprocess = (e) => {
      const L = e.outputBuffer.getChannelData(0);
      dsp.render(L, L.length);
      e.outputBuffer.getChannelData(1).set(L);
    };
    sp.connect(comp);
    post = (m) => dsp.msg(m);
    audioMode = `ScriptProcessor (${err.name})`;
  }
  post({ type: "preset", preset: state.preset });
};

let wakeLock = null;

const startEngine = async () => {
  if (!ctx) await initAudio();
  await ctx.resume();
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    DeviceMotionEvent.requestPermission().catch(() => {});
  }
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
  state.running = true;
  state.startT = performance.now();
  state.rpm = 0;
  $("power").textContent = "Stop engine";
  $("power").classList.add("on");
};

const stopEngine = () => {
  state.running = false;
  $("power").textContent = "Start engine";
  $("power").classList.remove("on");
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  setTimeout(() => {
    if (!state.running) ctx?.suspend();
  }, 400);
};

// ---------- speed input ----------

const gps = { count: 0, last: null, interval: 0, prevT: 0, err: "", rawSpeed: null, computed: null };

const haversine = (a, b) => {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const onFix = (v, t) => {
  const fix = { t, v: v < 0.6 ? 0 : v };
  if (state.fix) {
    const dt = (t - state.fix.t) / 1000;
    if (dt > 0.25 && dt < 4) {
      const raw = (fix.v - state.fix.v) / dt;
      state.accel = Math.abs(raw) < 0.2 ? state.accel * 0.3 : lerp(state.accel, raw, 0.85);
    } else if (dt >= 4) state.accel = 0;
  }
  state.fix = fix;
};

const onPosition = (pos) => {
  const now = performance.now();
  const c = pos.coords;
  if (gps.prevT) gps.interval = gps.interval ? lerp(gps.interval, now - gps.prevT, 0.3) : now - gps.prevT;
  let computed = null;
  if (gps.last) {
    const dt = (pos.timestamp - gps.last.timestamp) / 1000;
    if (dt > 0.2) computed = haversine(gps.last.coords, c) / dt;
  }
  gps.count++;
  gps.prevT = now;
  gps.last = pos;
  gps.err = "";
  gps.rawSpeed = c.speed;
  gps.computed = computed;
  const v = Number.isFinite(c.speed) && c.speed !== null ? c.speed : computed;
  if (state.source === "gps" && v !== null) onFix(v, now);
};

const onPositionError = (err) => {
  gps.err = `${err.code === 1 ? "Permission denied" : err.code === 2 ? "Position unavailable" : "Timeout"}: ${err.message}`;
};

let gpsWatch = null;
const startGps = () => {
  if (gpsWatch !== null || !("geolocation" in navigator)) return;
  gpsWatch = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000,
  });
};

// Scripted drive fed through the same 1 Hz path as real GPS, for testing while parked.
const DEMO = [
  [2, 0],
  [7, 4.2],
  [2.5, -0.5],
  [4, 0],
  [3, 2.2],
  [2, -0.4],
  [10.5, -3.5],
  [3, 0],
];
let demoTimer = null;

const runDemo = () => {
  if (demoTimer) return endDemo();
  state.source = "demo";
  state.fix = null;
  state.accel = 0;
  let v = 0;
  let seg = 0;
  let segT = 0;
  let sinceFix = 1;
  $("demo").textContent = "Stop demo";
  demoTimer = setInterval(() => {
    const [dur, a] = DEMO[seg];
    v = Math.max(0, v + a * 0.05);
    segT += 0.05;
    sinceFix += 0.05;
    if (sinceFix >= 1) {
      sinceFix = 0;
      onFix(v, performance.now());
    }
    if (segT >= dur) {
      seg++;
      segT = 0;
      if (seg >= DEMO.length) endDemo();
    }
  }, 50);
};

const endDemo = () => {
  clearInterval(demoTimer);
  demoTimer = null;
  state.source = "gps";
  state.fix = null;
  state.accel = 0;
  $("demo").textContent = "Demo drive";
};

// ---------- engine model ----------

const gearRpm = (p, v, g) => ((v / (2 * Math.PI * WHEEL_RADIUS)) * 60 * p.gears[g] * p.final);

let lastTick = performance.now();

const tick = () => {
  const now = performance.now();
  const dt = clamp((now - lastTick) / 1000, 0, 0.1);
  lastTick = now;
  const p = state.preset;

  // Speed: extrapolate the last fix with the measured acceleration to hide GPS lag.
  let vTarget = 0;
  let a = 0;
  if (state.fix) {
    const age = (now - state.fix.t) / 1000;
    a = age > 4 ? 0 : state.accel;
    vTarget = Math.max(0, state.fix.v + a * Math.min(age, 1.2));
  }
  state.v += (vTarget - state.v) * ease(dt, 0.25);
  const moving = state.v > MOVING;
  if (moving) state.revHeld = false;

  // Throttle is inferred from acceleration.
  let tLoad;
  if (!moving) tLoad = state.revHeld ? 1 : 0;
  else if (a > 0.25) tLoad = clamp(0.3 + ((a - 0.25) / 2.2) * state.drama, 0, 1);
  else if (a < -0.4) tLoad = 0;
  else tLoad = 0.22;
  state.load += (tLoad - state.load) * ease(dt, tLoad > state.load ? 0.12 : 0.08);

  // Lift-off after real throttle: crackle, and dump boost through the valve.
  if (state.load > 0.5) state.liftArm = now;
  if (tLoad < 0.25 && state.liftArm && now - state.liftArm < 700 && state.rpm > 2200) {
    state.liftArm = 0;
    state.overrun = Math.max(state.overrun, clamp(0.6 + 0.4 * state.drama * (state.rpm / p.redline), 0, 1.4));
    if (p.turbo && state.boost > 0.3) post({ type: "bov", amt: state.boost });
  }
  if (moving && a < -1.2 && state.rpm > 1800) {
    state.overrun = Math.max(state.overrun, clamp((-a - 1.2) / 3, 0.15, 0.6) * state.drama);
  }
  state.overrun *= Math.exp(-dt / (tLoad > 0.3 ? 0.05 : 0.9));

  // Virtual gearbox.
  if (!moving) state.gear = 0;
  else if (now - state.shiftT > 600) {
    const r = gearRpm(p, state.v, state.gear);
    const up = lerp(p.redline * 0.36, p.redline * 0.9, state.load ** 1.2);
    // Braking keeps the revs up with blipped downshifts, like a driver would.
    const down = a < -0.8 ? p.redline * 0.3 : lerp(p.idle * 1.6, p.redline * 0.42, state.load);
    if (state.gear < p.gears.length - 1 && r > up && a > -0.2) {
      state.gear++;
      state.shiftT = now;
      if (state.load > 0.45) {
        post({ type: "cut", ms: 90 });
        if (p.turbo && state.boost > 0.5) post({ type: "pop", amt: 0.8 });
      }
    } else if (state.gear > 0 && r < down) {
      state.gear--;
      state.shiftT = now;
      if (a < -0.5) state.blipT = now;
    }
  }

  // Target rpm: starter, catch, idle, free rev, or locked to the wheels.
  const sinceStart = now - state.startT;
  const blip = state.blipT && now - state.blipT < 160;
  let tRpm;
  if (sinceStart < 900) tRpm = 230;
  else if (sinceStart < 2600) tRpm = lerp(p.idle * 1.9, p.idle, (sinceStart - 900) / 1700);
  else if (!moving) tRpm = state.revHeld ? p.redline * 1.02 : p.idle;
  else {
    const slip = state.gear === 0 && state.v < 5 ? p.idle + state.load * 2600 : 0;
    tRpm = Math.max(p.idle, gearRpm(p, state.v, state.gear), slip);
  }
  if (blip) tRpm += 900;
  const diff = tRpm - state.rpm;
  const rate = diff > 0 ? (moving ? 9000 : 7000 * (0.4 + state.load)) : moving ? 14000 : 3800;
  state.rpm += clamp(diff, -rate * dt, rate * dt);

  // Rev limiter bounce.
  if (state.rpm >= p.redline && state.load > 0.5 && now - state.limiterT > 70) {
    state.limiterT = now;
    state.rpm -= 250;
    post({ type: "cut", ms: 45 });
  }

  const tBoost = p.turbo
    ? clamp((state.load - 0.3) / 0.55, 0, 1) * clamp((state.rpm - 1800) / 2600, 0, 1)
    : 0;
  state.boost += (tBoost - state.boost) * ease(dt, tBoost > state.boost ? 0.7 : 0.18);

  post({
    type: "params",
    rpm: state.rpm,
    load: blip ? 0.7 : sinceStart < 2600 ? 0.35 : state.load,
    boost: state.boost,
    overrun: state.overrun,
    vol: state.running ? state.vol : 0,
  });
};

setInterval(tick, 30);

// ---------- motion & sensor diagnostics ----------

const motion = { n: 0, on: 0, last: null, lastO: null, hz: 0, ohz: 0, pn: 0, pon: 0 };
// Desktop Chrome fires one empty event, so only count events that carry data.
window.addEventListener("devicemotion", (e) => {
  motion.last = e;
  const g = e.accelerationIncludingGravity;
  if (e.acceleration?.x != null || g?.x != null || e.rotationRate?.alpha != null) motion.n++;
});
window.addEventListener("deviceorientation", (e) => {
  motion.lastO = e;
  if (e.alpha != null || e.beta != null) motion.on++;
});

const sensors = {};
const SENSOR_NAMES = ["Accelerometer", "LinearAccelerationSensor", "Gyroscope", "AbsoluteOrientationSensor"];
const startSensors = () => {
  for (const name of SENSOR_NAMES) {
    if (!(name in window)) {
      sensors[name] = { status: "Not in this browser" };
      continue;
    }
    try {
      const s = new window[name]({ frequency: 30 });
      sensors[name] = { status: "Starting", n: 0, s };
      s.addEventListener("reading", () => {
        sensors[name].n++;
        sensors[name].status = "Reading";
      });
      s.addEventListener("error", (ev) => {
        sensors[name].status = `${ev.error.name}: ${ev.error.message}`;
      });
      s.start();
    } catch (err) {
      sensors[name] = { status: `${err.name}: ${err.message}` };
    }
  }
};

const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "null" : Number(x).toFixed(d));
const xyz = (o) => (o ? `${fmt(o.x)}, ${fmt(o.y)}, ${fmt(o.z)}` : "null");

const renderList = (el, rows) => {
  el.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
};

const setChip = (el, text, level) => {
  el.textContent = text;
  el.dataset.level = level;
};

let lastDiag = performance.now();
const pageStart = performance.now();

const updateDiag = () => {
  const now = performance.now();
  const dt = (now - lastDiag) / 1000;
  lastDiag = now;
  motion.hz = (motion.n - motion.pn) / dt;
  motion.ohz = (motion.on - motion.pon) / dt;
  motion.pn = motion.n;
  motion.pon = motion.on;

  const c = gps.last?.coords;
  const age = gps.last ? (now - gps.prevT) / 1000 : null;
  renderList($("gpsDiag"), [
    ["Fixes", String(gps.count)],
    ["Update rate", gps.interval ? `${(1000 / gps.interval).toFixed(2)} Hz` : "n/a"],
    ["Last fix", age === null ? "none" : `${age.toFixed(1)} s ago`],
    ["Speed (reported)", gps.rawSpeed === null ? "null" : `${fmt(gps.rawSpeed * 3.6, 1)} km/h`],
    ["Speed (from positions)", gps.computed === null ? "n/a" : `${fmt(gps.computed * 3.6, 1)} km/h`],
    ["Accuracy", c ? `${fmt(c.accuracy, 0)} m` : "n/a"],
    ["Heading", c ? fmt(c.heading, 0) : "n/a"],
    ["Error", gps.err || "none"],
  ]);
  const m = motion.last;
  const o = motion.lastO;
  renderList($("motionDiag"), [
    ["DeviceMotionEvent", typeof DeviceMotionEvent === "undefined" ? "missing" : "present"],
    ["devicemotion", `${motion.n} events, ${motion.hz.toFixed(0)} Hz`],
    ["Acceleration", xyz(m?.acceleration)],
    ["With gravity", xyz(m?.accelerationIncludingGravity)],
    ["Rotation rate", m?.rotationRate ? `${fmt(m.rotationRate.alpha)}, ${fmt(m.rotationRate.beta)}, ${fmt(m.rotationRate.gamma)}` : "null"],
    ["deviceorientation", `${motion.on} events, ${motion.ohz.toFixed(0)} Hz`],
    ["Orientation", o ? `${fmt(o.alpha, 1)}, ${fmt(o.beta, 1)}, ${fmt(o.gamma, 1)}` : "null"],
  ]);
  renderList(
    $("sensorDiag"),
    SENSOR_NAMES.map((name) => {
      const s = sensors[name];
      if (!s) return [name, "Not started"];
      if (s.s && s.n) {
        const r = s.s;
        const val = "quaternion" in r ? (r.quaternion || []).map((q) => fmt(q)).join(", ") : `${fmt(r.x)}, ${fmt(r.y)}, ${fmt(r.z)}`;
        return [name, `${s.n} readings: ${val}`];
      }
      return [name, s.status];
    }),
  );
  renderList($("browserDiag"), [
    ["Audio", audioMode],
    ["Sample rate", ctx ? `${ctx.sampleRate} Hz` : "n/a"],
    ["Output latency", ctx?.outputLatency ? `${(ctx.outputLatency * 1000).toFixed(0)} ms` : "n/a"],
    ["Secure context", String(window.isSecureContext)],
    ["Screen", `${innerWidth} × ${innerHeight} @ ${devicePixelRatio}x`],
    ["User agent", navigator.userAgent],
  ]);

  const waited = (now - pageStart) / 1000 > 4;
  if (gps.err) setChip($("chipGps"), "GPS error", "bad");
  else if (!gps.count) setChip($("chipGps"), "GPS waiting", "wait");
  else setChip($("chipGps"), `GPS ${gps.interval ? (1000 / gps.interval).toFixed(1) : "?"} Hz`, age > 5 ? "wait" : "ok");
  const anySensor = SENSOR_NAMES.some((n) => sensors[n]?.n);
  if (motion.n || motion.on || anySensor) setChip($("chipMotion"), `Motion ${motion.hz.toFixed(0)} Hz`, "ok");
  else setChip($("chipMotion"), waited ? "No motion data" : "Motion checking", waited ? "bad" : "wait");
  setChip($("chipAudio"), state.running ? "Audio on" : "Audio off", state.running ? "ok" : "wait");
  $("source").textContent = state.source === "demo" ? "Demo drive" : "GPS";
};

setInterval(updateDiag, 250);

// ---------- cluster ----------

const tokens = {};
const readTokens = () => {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["--line", "--muted", "--fg", "--amber", "--red", "--display"]) tokens[k] = cs.getPropertyValue(k).trim();
};

const drawTach = () => {
  const c = $("tach");
  const size = c.clientWidth;
  const dpr = devicePixelRatio || 1;
  const px = Math.round(size * dpr);
  if (c.width !== px) {
    c.width = px;
    c.height = px;
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  const p = state.preset;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 6;
  const max = Math.ceil(p.redline / 1000) + 1;
  const a0 = Math.PI * 0.75;
  const a1 = Math.PI * 2.25;
  const ang = (rpm) => a0 + (a1 - a0) * clamp(rpm / (max * 1000), 0, 1);
  const arc = (from, to, color, w) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.arc(cx, cy, R * 0.9, from, to);
    g.stroke();
  };
  g.lineCap = "butt";
  arc(a0, a1, tokens["--line"], R * 0.07);
  arc(ang(p.redline), a1, tokens["--red"], R * 0.07);
  arc(a0, ang(state.rpm), state.rpm >= p.redline * 0.95 ? tokens["--red"] : tokens["--amber"], R * 0.07);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `600 ${Math.round(R * 0.11)}px ${tokens["--display"]}`;
  for (let k = 0; k <= max * 2; k++) {
    const rpm = k * 500;
    const a = ang(rpm);
    const major = k % 2 === 0;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    g.strokeStyle = rpm >= p.redline ? tokens["--red"] : tokens["--muted"];
    g.lineWidth = major ? 3 : 1.5;
    g.beginPath();
    g.moveTo(cx + cos * R * (major ? 0.74 : 0.78), cy + sin * R * (major ? 0.74 : 0.78));
    g.lineTo(cx + cos * R * 0.82, cy + sin * R * 0.82);
    g.stroke();
    if (major) {
      g.fillStyle = rpm >= p.redline ? tokens["--red"] : tokens["--fg"];
      g.fillText(String(k / 2), cx + cos * R * 0.63, cy + sin * R * 0.63);
    }
  }
};

const frame = () => {
  drawTach();
  const moving = state.v > MOVING;
  $("gear").textContent = state.running ? (moving ? String(state.gear + 1) : "N") : "–";
  $("speed").textContent = String(Math.round(state.v * 3.6));
  $("rpm").textContent = String(Math.round(state.rpm / 10) * 10);
  $("loadBar").style.transform = `scaleX(${state.load.toFixed(3)})`;
  $("boostBar").style.transform = `scaleX(${state.boost.toFixed(3)})`;
  $("boostVal").textContent = `${(state.boost * state.preset.turbo * 1.4).toFixed(1)} bar`;
  $("rev").disabled = !state.running || moving;
  requestAnimationFrame(frame);
};

// ---------- controls ----------

const buildEngines = () => {
  const wrap = $("engines");
  for (const p of PRESETS) {
    const label = document.createElement("label");
    label.className = "engine";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "engine";
    input.id = `engine-${p.id}`;
    input.value = p.id;
    input.checked = p.id === state.preset.id;
    const name = document.createElement("strong");
    name.textContent = p.name;
    const sub = document.createElement("span");
    sub.textContent = p.sub;
    label.append(input, name, sub);
    input.addEventListener("change", () => {
      state.preset = p;
      store.set("preset", p.id);
      post({ type: "preset", preset: p });
    });
    wrap.append(label);
  }
};

const bindControls = () => {
  $("power").addEventListener("click", () => (state.running ? stopEngine() : startEngine()));
  $("demo").addEventListener("click", runDemo);
  const vol = $("vol");
  vol.value = String(Math.round(state.vol * 100));
  vol.addEventListener("input", () => {
    state.vol = Number(vol.value) / 100;
    store.set("vol", state.vol);
  });
  const drama = $("drama");
  drama.value = String(Math.round(state.drama * 100));
  drama.addEventListener("input", () => {
    state.drama = Number(drama.value) / 100;
    store.set("drama", state.drama);
  });
  const rev = $("rev");
  const down = (e) => {
    e.preventDefault();
    if (!rev.disabled) state.revHeld = true;
  };
  const up = () => {
    state.revHeld = false;
  };
  rev.addEventListener("pointerdown", down);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) rev.addEventListener(ev, up);
};

readTokens();
buildEngines();
bindControls();
startGps();
startSensors();
document.fonts?.ready.then(readTokens);
requestAnimationFrame(frame);

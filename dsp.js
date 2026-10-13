// Engine sound synthesizer. Loaded as an AudioWorklet module, and as a plain
// script so the main thread can fall back to a ScriptProcessorNode.

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const hash01 = (i) => {
  const s = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return s - Math.floor(s);
};

class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
    this.g = 1;
  }

  set(type, freq, q, sr) {
    const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    let b0;
    let b1;
    let b2;
    if (type === "lp") {
      b0 = (1 - c) / 2;
      b1 = 1 - c;
      b2 = (1 - c) / 2;
    } else if (type === "hp") {
      b0 = (1 + c) / 2;
      b1 = -(1 + c);
      b2 = (1 + c) / 2;
    } else {
      b0 = al;
      b1 = 0;
      b2 = -al;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
  }

  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class EngineDSP {
  constructor(sr) {
    this.sr = sr;
    this.p = null;
    this.rpm = 0;
    this.tRpm = 0;
    this.load = 0;
    this.tLoad = 0;
    this.boost = 0;
    this.tBoost = 0;
    this.overrun = 0;
    this.tOverrun = 0;
    this.vol = 0;
    this.tVol = 0;
    this.phase = 0;
    this.idx = 0;
    this.cut = 0;
    this.popEnv = 0;
    this.bovEnv = 0;
    this.tPhase = 0;
    this.k = 0;
    this.smooth = 1 - Math.exp(-1 / (0.02 * sr));
    this.popDecay = Math.exp(-1 / (0.007 * sr));
    this.bovDecay = Math.exp(-1 / (0.38 * sr));
    this.banks = [];
    this.cyl = [];
    this.muff = new Biquad();
    this.intake = new Biquad();
    this.bovF = new Biquad();
    this.hiss = new Biquad();
    this.crackle = new Biquad();
    this.dc = new Biquad();
    this.dc.set("hp", 28, 0.707, sr);
    this.hiss.set("bp", 5200, 1.5, sr);
    this.crackle.set("hp", 1800, 0.7, sr);
  }

  msg(m) {
    if (m.type === "preset") this.setPreset(m.preset);
    else if (m.type === "params") {
      this.tRpm = m.rpm;
      this.tLoad = m.load;
      this.tBoost = m.boost;
      this.tOverrun = m.overrun;
      this.tVol = m.vol;
    } else if (m.type === "cut") this.cut = Math.round((m.ms / 1000) * this.sr);
    else if (m.type === "bov") this.bovEnv = Math.max(this.bovEnv, m.amt);
    else if (m.type === "pop") this.popEnv = Math.min(2.2, this.popEnv + m.amt);
  }

  setPreset(p) {
    this.p = p;
    const bankCount = Math.max(...p.fires.map((f) => f.b)) + 1;
    this.banks = [];
    for (let b = 0; b < bankCount; b++) {
      const detune = p.bankDetune ? p.bankDetune[b] : 1;
      const res = p.res.map(([freq, q, g]) => {
        const bq = new Biquad();
        bq.set("bp", freq * detune, q, this.sr);
        bq.g = g;
        return bq;
      });
      this.banks.push({ fast: 0, slow: 0, gain: p.bankGain ? p.bankGain[b] : 1, res });
    }
    // Small fixed imbalance per cylinder gives the idle its lope.
    this.cyl = p.fires.map((_, i) => 1 + (hash01(i) - 0.5) * 0.18);
    this.phase = 0;
    this.idx = 0;
    this.k = 0;
  }

  control() {
    const p = this.p;
    const sr = this.sr;
    const r = clamp01(this.rpm / p.redline);
    const L = this.load;
    const open = Math.min(1, 0.15 * r + L * (0.35 + 0.6 * r));
    this.muff.set("lp", p.muffle[0] + (p.muffle[1] - p.muffle[0]) * open, 0.75, sr);
    this.intake.set("bp", 500 + this.rpm * 0.22, 1.1, sr);
    this.bovF.set("bp", 1400 + 3200 * this.bovEnv, 0.8, sr);
    // Pulse = difference of two decays: a soft attack at idle, a sharp crack under load.
    const tau = p.tau * (1.25 - 0.55 * r);
    const k = 0.4 - 0.28 * L;
    const tPeak = ((tau * k) / (1 - k)) * Math.log(1 / k);
    this.pDecay = Math.exp(-1 / (tau * sr));
    this.aDecay = Math.exp(-1 / (tau * k * sr));
    this.pulseNorm = 1 / (Math.exp(-tPeak / tau) - Math.exp(-tPeak / (tau * k)));
    this.drive = p.drive[0] + (p.drive[1] - p.drive[0]) * L;
    this.driveNorm = 1 / Math.tanh(this.drive);
    this.rough = p.rough * Math.min(1.6, Math.max(0.3, 1.6 - this.rpm / 3000));
    this.noiseAmt = 0.04 + 0.5 * L;
    this.direct = 0.03 + 0.1 * L;
  }

  fire(i) {
    if (this.cut > 0) return;
    const bank = this.banks[this.p.fires[i].b];
    let amp = (0.25 + 0.75 * this.load) * this.cyl[i] * (1 + (Math.random() * 2 - 1) * this.rough);
    if (this.rpm < 450) amp *= 0.35;
    bank.fast += amp * bank.gain;
    bank.slow += amp * bank.gain;
  }

  render(out, n) {
    const p = this.p;
    if (!p) {
      out.fill(0);
      return;
    }
    const sr = this.sr;
    const s = this.smooth;
    const banks = this.banks;
    const fires = p.fires;
    const nf = fires.length;
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      if ((this.k++ & 63) === 0) this.control();
      this.rpm += (this.tRpm - this.rpm) * s;
      this.load += (this.tLoad - this.load) * s;
      this.boost += (this.tBoost - this.boost) * s;
      this.overrun += (this.tOverrun - this.overrun) * s;
      this.vol += (this.tVol - this.vol) * s;
      const nz = Math.random() * 2 - 1;

      // One phase cycle is one full engine cycle; cylinders fire at fixed fractions of it.
      let ph = this.phase + this.rpm / p.cycleDiv / sr;
      while (this.idx < nf && ph >= fires[this.idx].f) this.fire(this.idx++);
      if (ph >= 1) {
        ph -= 1;
        this.idx = 0;
        while (this.idx < nf && ph >= fires[this.idx].f) this.fire(this.idx++);
      }
      this.phase = ph;
      if (this.cut > 0) this.cut--;

      // Overrun: unburnt fuel popping in the exhaust after lifting off.
      if (
        this.overrun > 0.02 &&
        this.rpm > 1400 &&
        Math.random() < (this.overrun * p.pops * (4 + this.rpm / 450)) / sr
      ) {
        this.popEnv = Math.min(2.2, this.popEnv + (Math.random() < 0.12 ? 1.5 : 0.25 + Math.random() * 0.55));
      }
      this.popEnv *= this.popDecay;
      const pop = this.popEnv * (0.35 + 0.65 * nz);

      let eng = 0;
      for (let b = 0; b < banks.length; b++) {
        const bank = banks[b];
        bank.slow *= this.pDecay;
        bank.fast *= this.aDecay;
        let x = (bank.slow - bank.fast) * this.pulseNorm * (1 + this.noiseAmt * nz);
        if (b === 0) x += pop * 0.8;
        let y = x * this.direct;
        for (let r = 0; r < bank.res.length; r++) y += bank.res[r].run(x) * bank.res[r].g;
        eng += y;
      }
      eng = Math.tanh(eng * this.drive * p.gain) * this.driveNorm;
      eng = this.muff.run(eng);

      const r = this.rpm / p.redline;
      const intake = this.intake.run(nz) * this.load * (0.1 + 0.5 * r) * 0.35;

      this.tPhase += (2400 + 6800 * this.boost) / sr;
      if (this.tPhase >= 1) this.tPhase -= 1;
      const spool = this.boost * this.boost * p.turbo;
      const whistle = (Math.sin(this.tPhase * twoPi) * 0.03 + Math.sin(this.tPhase * 2 * twoPi) * 0.008) * spool;
      const hiss = this.hiss.run(nz) * spool * 0.05;

      this.bovEnv *= this.bovDecay;
      const bov = p.turbo > 0 ? this.bovF.run(nz) * this.bovEnv * 0.5 : 0;
      const crackle = this.crackle.run(pop) * 0.3;

      out[i] = this.dc.run(eng * 0.8 + intake + whistle + hiss + bov + crackle) * this.vol;
    }
  }
}

if (typeof registerProcessor === "function") {
  class EngineProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new EngineDSP(sampleRate);
      this.port.onmessage = (e) => this.dsp.msg(e.data);
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      this.dsp.render(out[0], out[0].length);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      return true;
    }
  }
  registerProcessor("engine", EngineProcessor);
}

if (typeof module === "object") module.exports = { EngineDSP };

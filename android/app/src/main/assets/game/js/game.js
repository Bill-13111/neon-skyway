/* =========================================================
   霓虹轨道 · Neon Skyway
   A Rolling-Sky inspired neon runner.
   ========================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------
     Utilities
     --------------------------------------------------------- */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const rand = (a, b) => a + Math.random() * (b - a);
  const TAU = Math.PI * 2;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pick = (arr, rng) => arr[Math.floor((rng ? rng() : Math.random()) * arr.length)];
  const formatNumber = (n) => Math.round(n).toLocaleString('zh-CN');
  const formatTime = (seconds) => {
    const s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  /* ---------------------------------------------------------
     Audio — a tiny generative synth. No external assets.
     --------------------------------------------------------- */
  class AudioEngine {
    constructor(muted) {
      this.ctx = null;
      this.master = null;
      this.musicBus = null;
      this.duck = null;
      this.sfxBus = null;
      this.delay = null;
      this.delayWet = null;
      this.muted = !!muted;
      this.musicOn = false;
      this.timer = null;
      this.step = 0;
      this.nextTime = 0;
      this.pausedAt = 0;
      this.bpm = 120;
      this.stepDur = 60 / this.bpm / 4;
      this.noiseBuffer = null;
      this.padBeats = new Set();
      // Am — F — C — G, one chord per bar, four-bar cycle.
      this.progression = [
        { bass: 33, chord: [57, 60, 64, 69] },
        { bass: 29, chord: [53, 57, 60, 65] },
        { bass: 36, chord: [48, 52, 55, 60] },
        { bass: 31, chord: [43, 47, 50, 55] }
      ];
      this.arpPattern = [0, 1, 2, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 1, 0, 2];
    }

    midi(n) {
      return 440 * Math.pow(2, (n - 69) / 12);
    }

    init() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch (e) {
        return;
      }
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(ctx.destination);

      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.0001;
      this.duck = ctx.createGain();
      this.duck.gain.value = 1;
      this.musicBus.connect(this.duck);
      this.duck.connect(this.master);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 0.72;
      this.sfxBus.connect(this.master);

      this.delay = ctx.createDelay(1.2);
      this.delay.delayTime.value = 0.32;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.26;
      this.delay.connect(feedback);
      feedback.connect(this.delay);
      this.delayWet = ctx.createGain();
      this.delayWet.gain.value = 0.16;
      this.delay.connect(this.delayWet);
      this.delayWet.connect(this.musicBus);

      this.noiseBuffer = this.createNoiseBuffer(2.0);
    }

    createNoiseBuffer(seconds) {
      const length = Math.floor(this.ctx.sampleRate * seconds);
      const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      return buffer;
    }

    setMuted(muted) {
      this.muted = muted;
      if (this.master && this.ctx) {
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(muted ? 0 : 0.8, now, 0.08);
      }
    }

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }

    setPadBeats(beats) {
      this.padBeats = new Set(beats);
    }

    tone(freq, dur, type, gain, options = {}) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const t = options.when != null ? options.when : ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(Math.max(20, freq), t);
      if (options.to) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.to), t + dur);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t + (options.attack || 0.01));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const dest = options.dest || this.sfxBus;
      osc.connect(g);
      g.connect(dest);
      if (options.pan && ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = options.pan;
        g.disconnect();
        g.connect(panner);
        panner.connect(dest);
      }
      osc.start(t);
      osc.stop(t + dur + 0.04);
    }

    noise(dur, gain, filterFreq, options = {}) {
      if (!this.ctx || !this.noiseBuffer) return;
      const ctx = this.ctx;
      const t = options.when != null ? options.when : ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = options.type || 'bandpass';
      filter.frequency.setValueAtTime(filterFreq, t);
      if (options.to) filter.frequency.exponentialRampToValueAtTime(options.to, t + dur);
      filter.Q.value = options.q || 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter);
      filter.connect(g);
      g.connect(options.dest || this.sfxBus);
      src.start(t);
      src.stop(t + dur + 0.03);
    }

    bass(midi, time, dur) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(this.midi(midi), time);
      filter.type = 'lowpass';
      filter.Q.value = 5;
      filter.frequency.setValueAtTime(520, time);
      filter.frequency.exponentialRampToValueAtTime(150, time + dur);
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.045, time + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.musicBus);
      osc.start(time);
      osc.stop(time + dur + 0.03);
    }

    lead(midi, time, dur, gain) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(this.midi(midi), time);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2400, time);
      filter.frequency.exponentialRampToValueAtTime(700, time + dur);
      filter.Q.value = 3;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(gain, time + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.musicBus);
      osc.start(time);
      osc.stop(time + dur + 0.04);
    }

    pluck(midi, time, gain) {
      this.tone(this.midi(midi), 0.2, 'triangle', gain, {
        attack: 0.004, when: time, dest: this.delay
      });
      this.tone(this.midi(midi + 12), 0.12, 'sine', gain * 0.5, {
        attack: 0.003, when: time + 0.015, dest: this.musicBus
      });
    }

    pad(chord, time, gain) {
      chord.forEach((n, i) => {
        this.tone(this.midi(n), 4.3, i % 2 ? 'triangle' : 'sine', gain, {
          attack: 0.55, when: time + i * 0.012, dest: this.musicBus
        });
      });
    }

    kick(time) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(125, time);
      osc.frequency.exponentialRampToValueAtTime(42, time + 0.13);
      g.gain.setValueAtTime(0.13, time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.25);
      osc.connect(g);
      g.connect(this.musicBus);
      osc.start(time);
      osc.stop(time + 0.27);
      // Sidechain-style pump on the music bus.
      const d = this.duck.gain;
      d.cancelScheduledValues(time);
      d.setValueAtTime(1, time);
      d.linearRampToValueAtTime(0.52, time + 0.018);
      d.setTargetAtTime(1, time + 0.05, 0.11);
    }

    clap(time) {
      this.noise(0.11, 0.065, 1800, {
        type: 'bandpass', q: 1.2, when: time, dest: this.musicBus
      });
      this.tone(190, 0.07, 'triangle', 0.025, {
        attack: 0.004, when: time, dest: this.musicBus
      });
    }

    hat(time, open) {
      this.noise(open ? 0.18 : 0.045, open ? 0.022 : 0.013, 7600, {
        type: 'highpass', q: 0.7, when: time, dest: this.musicBus
      });
    }

    impact(time) {
      this.noise(0.5, 0.12, 2400, {
        type: 'lowpass', to: 90, q: 1.2, when: time, dest: this.musicBus
      });
      this.tone(90, 0.7, 'sine', 0.1, {
        to: 32, attack: 0.005, when: time, dest: this.musicBus
      });
    }

    riser(time, dur) {
      this.noise(dur, 0.045, 300, {
        type: 'highpass', to: 6800, q: 0.7, when: time, dest: this.musicBus
      });
    }

    padHit() {
      this.tone(220, 0.42, 'sine', 0.15, { to: 1320, attack: 0.012 });
      this.tone(440, 0.32, 'triangle', 0.06, { to: 1760, attack: 0.008 });
      this.noise(0.32, 0.055, 800, { to: 6200 });
    }

    land() {
      this.noise(0.08, 0.04, 480, { type: 'lowpass' });
    }

    crystal(streak) {
      const n = 1046.5 * Math.pow(2, Math.min(6, streak || 0) / 12);
      this.tone(n, 0.16, 'sine', 0.12, { attack: 0.004 });
      this.tone(n * 1.5, 0.26, 'sine', 0.07, { attack: 0.004 });
      if (streak && streak % 5 === 0) {
        this.tone(n * 2, 0.4, 'triangle', 0.06, { attack: 0.01 });
      }
    }

    hit() {
      this.noise(0.35, 0.3, 260, { type: 'lowpass', to: 90, q: 1.2 });
      this.tone(140, 0.4, 'sawtooth', 0.1, { to: 45 });
      this.tone(72, 0.5, 'sine', 0.16, { to: 36 });
    }

    checkpoint() {
      if (!this.ctx) return;
      [523.25, 659.25, 783.99, 1046.5].forEach((n, i) => {
        this.tone(n, 0.6, 'sine', 0.075, { attack: 0.02, when: this.ctx.currentTime + i * 0.09 });
      });
    }

    countdown(go) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      if (go) {
        this.tone(880, 0.5, 'triangle', 0.12, { attack: 0.01, when: t });
        this.tone(1320, 0.7, 'sine', 0.07, { attack: 0.01, when: t + 0.02 });
      } else {
        this.tone(440, 0.14, 'sine', 0.1, { attack: 0.005, when: t });
      }
    }

    win() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      [392, 523.25, 659.25, 783.99, 1046.5].forEach((n, i) => {
        this.tone(n, 1.6, 'sine', 0.085, { attack: 0.04, when: t + i * 0.1 });
        this.tone(n / 2, 1.8, 'triangle', 0.04, { attack: 0.1, when: t + i * 0.1 });
      });
      this.noise(1.2, 0.05, 4000, { type: 'highpass' });
    }

    lose() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      [329.63, 261.63, 196, 146.83].forEach((n, i) => {
        this.tone(n, 0.9, 'sine', 0.09, { attack: 0.03, when: t + i * 0.13 });
      });
    }

    startMusic(reset) {
      this.init();
      if (!this.ctx) return;
      if (reset) {
        this.step = 0;
        this.nextTime = 0;
        this.pausedAt = 0;
      }
      if (this.musicOn) return;
      this.resume();
      this.musicOn = true;
      const now = this.ctx.currentTime;
      if (this.pausedAt) {
        this.nextTime += now - this.pausedAt;
        this.pausedAt = 0;
      }
      if (!this.nextTime || this.nextTime < now) this.nextTime = now + 0.08;
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setValueAtTime(Math.max(0.0001, this.musicBus.gain.value), now);
      this.musicBus.gain.exponentialRampToValueAtTime(0.2, now + 0.8);
      this.timer = setInterval(() => this.schedule(), 25);
    }

    pauseMusic() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this.ctx && this.musicOn) this.pausedAt = this.ctx.currentTime;
      this.musicOn = false;
      if (this.ctx) {
        const now = this.ctx.currentTime;
        this.musicBus.gain.cancelScheduledValues(now);
        this.musicBus.gain.setTargetAtTime(0.0001, now, 0.1);
      }
    }

    stopMusic(reset) {
      this.pauseMusic();
      if (reset) {
        this.step = 0;
        this.nextTime = 0;
        this.pausedAt = 0;
      }
    }

    schedule() {
      if (!this.ctx || !this.musicOn) return;
      const horizon = this.ctx.currentTime + 0.25;
      while (this.nextTime < horizon) {
        this.playStep(this.step, this.nextTime);
        this.nextTime += this.stepDur;
        this.step++;
      }
    }

    sectionAt(bar) {
      if (bar < 2) return 'intro';
      if (bar < 10) return 'verse';
      if (bar < 18) return 'build';
      if (bar < 34) return 'drop';
      if (bar < 42) return 'break';
      return 'finale';
    }

    playStep(step, time) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const entry = this.progression[bar % 4];
      const section = this.sectionAt(bar);
      const beat = Math.floor(s / 4);
      const padBeat = bar * 4 + beat;
      const padHere = this.padBeats.has(padBeat);
      const full = section === 'drop' || section === 'finale';

      // Pads and section-level harmony.
      if (s === 0) {
        const gain = section === 'break' ? 0.012 : (full ? 0.016 : 0.011);
        this.pad(entry.chord, time, gain);
        if (bar === 18 || bar === 34 || bar === 42) {
          this.impact(time);
          this.noise(0.7, 0.03, 5000, {
            type: 'highpass', when: time, dest: this.musicBus
          });
        }
      }

      // Low end: a driving 8th/16th pattern, muted in the intro/break.
      if (section !== 'intro' && (section !== 'break' || s % 8 === 0)) {
        const bassStep = full ? (s % 8 === 0 ? 0 : (s % 4 === 2 ? 12 : 0)) : (s % 4 === 0 ? 0 : 12);
        if (bassStep >= 0) {
          this.bass(entry.bass + bassStep, time, full ? 0.2 : 0.32);
        }
      }

      // Four-on-the-floor kick.
      if (section !== 'intro' || s === 0 || s === 8) {
        if (s % 4 === 0) this.kick(time);
      }
      if (full && s === 14) this.kick(time);

      // Clap / snare.
      if (s === 4 || s === 12) {
        if (section !== 'intro' || bar >= 1) this.clap(time);
      }
      if (section === 'build' && bar >= 16 && s % 2 === 1) {
        this.clap(time);
      }

      // Hats.
      if (s % 2 === 0 && section !== 'break') {
        this.hat(time, full && (s === 2 || s === 6 || s === 10 || s === 14));
      }

      // Arpeggio / pluck.
      if (s % 2 === 0 || full) {
        const idx = this.arpPattern[s];
        const octave = full ? 24 : 12;
        const gain = section === 'break' ? 0.008 : (full ? 0.018 : 0.013);
        this.pluck(entry.chord[idx] + octave, time, gain);
      }

      // Lead motif in the second half.
      if ((full || section === 'build') && [0, 3, 6, 10, 12].includes(s)) {
        const leadNote = entry.chord[(s + bar) % entry.chord.length] + 24;
        this.lead(leadNote, time, s === 0 ? 0.7 : 0.35, full ? 0.018 : 0.012);
      }

      // Launch riser one beat before a pad, impact on the pad beat.
      if (s === 8 && this.padBeats.has(padBeat + 1)) this.riser(time, 0.45);
      if (padHere && s % 4 === 0) {
        this.impact(time);
      }

      // Extra percussion flourish at section turns.
      if (bar === 17 && s >= 8) this.clap(time);
      if (bar === 41 && s % 2 === 0) this.clap(time);
    }
  }

  /* ---------------------------------------------------------
     Constants / world styling
     --------------------------------------------------------- */
  const FINISH = 1200;
  const ROW = 3.2;
  const LANE = 2.35;
  const LANE_X = [-4.7, -2.35, 0, 2.35, 4.7];
  const BALL_R = 0.47;
  const GRAVITY = 27.5;
  const PAD_V = 12.8;
  const BPM = 120;
  const BEAT = 60 / BPM;
  const BEAT_DIST = 6;          // 12 m/s × 0.5 s per beat
  const BASE_SPEED = 12;
  const VERSION = '1.1.0';
  const CHANGELOG_KEY = 'neon-skyway-seen-version';

  const ZONES = [
    {
      name: '晨曦回廊', en: 'AURORA GATEWAY',
      accent: 0x55f6e4, accent2: 0x4d7dff,
      fog: 0x06101f, top: 0x030611, bottom: 0x0a1e3d, haze: 0x1d6b82
    },
    {
      name: '浮光裂谷', en: 'LUMEN RIFT',
      accent: 0x69e0ff, accent2: 0x8f6bff,
      fog: 0x080b20, top: 0x040516, bottom: 0x13163f, haze: 0x3645a8
    },
    {
      name: '赤霞回旋', en: 'SCARLET ORBIT',
      accent: 0xffb06d, accent2: 0xff4d8d,
      fog: 0x160b1a, top: 0x09040f, bottom: 0x2b1027, haze: 0x9c3f5d
    },
    {
      name: '镜面迷宫', en: 'MIRROR MAZE',
      accent: 0xb393ff, accent2: 0x4ce1ff,
      fog: 0x0a0a20, top: 0x050513, bottom: 0x17103a, haze: 0x5b49b8
    },
    {
      name: '星陨长桥', en: 'METEOR BRIDGE',
      accent: 0x6cf7c7, accent2: 0xffd36e,
      fog: 0x061510, top: 0x030b0a, bottom: 0x0a2522, haze: 0x218c72
    },
    {
      name: '天穹之门', en: 'CELESTIAL GATE',
      accent: 0xffd76e, accent2: 0xff6bd6,
      fog: 0x140a1b, top: 0x080410, bottom: 0x24102f, haze: 0xa65a9c
    }
  ];

  const STORAGE_KEY = 'neon-skyway-best-v1';
  const MUTE_KEY = 'neon-skyway-muted-v1';

  /* ---------------------------------------------------------
     Main game
     --------------------------------------------------------- */
  class NeonSkyway {
    constructor() {
      this.canvas = document.getElementById('game');
      this.app = document.getElementById('app');
      this.dom = {
        hud: document.getElementById('hud'),
        menu: document.getElementById('menu'),
        pause: document.getElementById('pause'),
        result: document.getElementById('result'),
        changelog: document.getElementById('changelog'),
        btnChangelog: document.getElementById('btn-changelog'),
        btnChangelogClose: document.getElementById('btn-changelog-close'),
        changelogDot: document.getElementById('changelog-dot'),
        countdown: document.getElementById('countdown'),
        countdownNum: document.getElementById('countdown-num'),
        countdownLabel: document.getElementById('countdown-label'),
        hudDistance: document.getElementById('hud-distance'),
        hudCrystals: document.getElementById('hud-crystals'),
        hudCrystalsTotal: document.getElementById('hud-crystals-total'),
        hudZone: document.getElementById('hud-zone'),
        hudProgressPct: document.getElementById('hud-progress-pct'),
        hudProgressFill: document.getElementById('hud-progress-fill'),
        hudProgressDot: document.getElementById('hud-progress-dot'),
        hudHearts: document.getElementById('hud-hearts'),
        btnPause: document.getElementById('btn-pause'),
        btnSound: document.getElementById('btn-sound'),
        btnStart: document.getElementById('btn-start'),
        btnResume: document.getElementById('btn-resume'),
        btnRestartPause: document.getElementById('btn-restart-pause'),
        btnMenuPause: document.getElementById('btn-menu-pause'),
        btnAgain: document.getElementById('btn-again'),
        btnMenu: document.getElementById('btn-menu'),
        resultBadge: document.getElementById('result-badge'),
        resultTitle: document.getElementById('result-title'),
        resultSubtitle: document.getElementById('result-subtitle'),
        resultScore: document.getElementById('result-score'),
        resultBest: document.getElementById('result-best'),
        resultDistance: document.getElementById('result-distance'),
        resultCrystals: document.getElementById('result-crystals'),
        resultTime: document.getElementById('result-time'),
        bestLabel: document.getElementById('best-label'),
        bestScore: document.getElementById('best-score'),
        bestDistance: document.getElementById('best-distance'),
        bestCrystals: document.getElementById('best-crystals'),
        zoneBanner: document.getElementById('zone-banner'),
        checkpointToast: document.getElementById('checkpoint-toast'),
        comboToast: document.getElementById('combo-toast'),
        controlHint: document.getElementById('control-hint'),
        speedBars: document.getElementById('speed-bars'),
        rotateHint: document.getElementById('rotate-hint'),
        webglError: document.getElementById('webgl-error')
      };

      this.zoneBannerEls = {
        index: this.dom.zoneBanner.querySelector('.zone-index'),
        name: this.dom.zoneBanner.querySelector('b'),
        en: this.dom.zoneBanner.querySelector('small')
      };
      this.speedBarEls = Array.from(this.dom.speedBars.querySelectorAll('i'));

      this.muted = false;
      try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
      this.audio = new AudioEngine(this.muted);

      this.state = 'boot';
      this.visualTime = 0;
      this.elapsed = 0;
      this.maxDistance = 0;
      this.speed = BASE_SPEED;
      this.zoneIndex = -1;
      this.themeIndex = 0;
      this.hearts = 3;
      this.crystalsCollected = 0;
      this.bonusScore = 0;
      this.crystalStreak = 0;
      this.lastCrystalAt = 0;
      this.padCooldown = 0;
      this.hitSlow = 0;
      this.shake = 0;
      this.goTimer = 0;
      this.prestartTimer = 0;
      this.countdownTimer = 0;
      this.lastCountdownNum = 0;
      this.resultTimer = 0;
      this.resultShown = false;
      this.hudTimer = 0;
      this.hintTimer = 10;
      this._lastHudDistance = -1;
      this._lastHudCrystals = -1;
      this._lastHudPct = -1;
      this._lastHudSpeed = -1;
      this._lastHearts = -1;
      this.zoneBannerTimer = 0;

      this.input = { axis: 0, targetX: null };
      this.keys = { left: false, right: false };
      this.pointer = {
        active: false, id: null, startX: 0, startY: 0,
        startBallX: 0, moved: false, startTime: 0
      };

      this.player = {
        x: 0, y: BALL_R, z: 0, vx: 0, vy: 0,
        grounded: true, invuln: 0
      };

      this.best = this.loadBest();

      if (!this.setupRenderer()) return;
      this.setupScene();
      this.setupWorld();
      this.setupPlayer();
      this.setupEffects();
      this.setupUI();
      this.bindUI();
      this.bindInput();
      this.resize();
      this.showMenu();
      this.initChangelog();
      this.clock = new THREE.Clock();
      this.animate = this.animate.bind(this);
      requestAnimationFrame(this.animate);

      // A small, harmless back door for curious players / testing.
      window.NeonSkyway = this;
    }

    /* -------------------------------------------------------
       Boot / scene
       ------------------------------------------------------- */
    setupRenderer() {
      try {
        this.renderer = new THREE.WebGLRenderer({
          canvas: this.canvas,
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
          stencil: false
        });
      } catch (err) {
        console.error(err);
        this.dom.webglError.classList.remove('hidden');
        return false;
      }
      this.renderer.setClearColor(0x050713, 1);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1800);
      this.camera.position.set(0, 7.4, 12);
      this.camLook = new THREE.Vector3(0, 1.3, -12);
      return true;
    }

    setupScene() {
      this.scene.fog = new THREE.FogExp2(ZONES[0].fog, 0.0082);

      this.hemi = new THREE.HemisphereLight(0x8bd8ff, 0x080616, 1.35);
      this.scene.add(this.hemi);

      this.sun = new THREE.DirectionalLight(0xcfeaff, 2.1);
      this.sun.position.set(9, 18, 8);
      this.scene.add(this.sun);

      this.fill = new THREE.DirectionalLight(0x7662ff, 0.62);
      this.fill.position.set(-12, 6, -12);
      this.scene.add(this.fill);

      this.glowTexture = this.makeGlowTexture();
      this.shadowTexture = this.makeShadowTexture();
      this.tileTexture = this.makeTileTexture();
      this.warningTexture = this.makeWarningTexture();

      this.buildSky();
      this.buildStars();
      this.buildNebulae();

      this.fogColor = new THREE.Color(ZONES[0].fog);
      this.targetFog = new THREE.Color(ZONES[0].fog);
      this.targetTop = new THREE.Color(ZONES[0].top);
      this.targetBottom = new THREE.Color(ZONES[0].bottom);
      this.targetHaze = new THREE.Color(ZONES[0].haze);
      this.playerAccent = new THREE.Color(ZONES[0].accent);
      this.targetAccent = new THREE.Color(ZONES[0].accent);
      this.targetAccent2 = new THREE.Color(ZONES[0].accent2);
    }

    buildSky() {
      const geo = new THREE.SphereGeometry(1000, 32, 20);
      this.skyUniforms = {
        uTop: { value: new THREE.Color(ZONES[0].top) },
        uBottom: { value: new THREE.Color(ZONES[0].bottom) },
        uHaze: { value: new THREE.Color(ZONES[0].haze) }
      };
      const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: this.skyUniforms,
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vDir = world.xyz - cameraPosition;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          uniform vec3 uTop;
          uniform vec3 uBottom;
          uniform vec3 uHaze;
          varying vec3 vDir;
          void main() {
            vec3 dir = normalize(vDir);
            float h = clamp(dir.y, -1.0, 1.0);
            vec3 col = mix(uBottom, uTop, smoothstep(-0.08, 0.66, h));
            float horizon = pow(1.0 - clamp(abs(h) * 2.1, 0.0, 1.0), 6.0);
            col += uHaze * horizon * 0.32;
            float glow = pow(max(0.0, 1.0 - abs(dir.x + 0.12) * 1.6), 8.0) *
                         pow(max(0.0, 1.0 - abs(h + 0.02) * 4.0), 4.0);
            col += uHaze * glow * 0.15;
            gl_FragColor = vec4(col, 1.0);
          }
        `
      });
      this.sky = new THREE.Mesh(geo, mat);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = -100;
      this.scene.add(this.sky);
    }

    buildStars() {
      const count = 900;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = 180 + Math.random() * 430;
        const angle = Math.random() * TAU;
        positions[i * 3] = Math.cos(angle) * r;
        positions[i * 3 + 1] = Math.random() * 260 - 30;
        positions[i * 3 + 2] = 80 - Math.random() * 1500;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0x9fd9ff, size: 1.15, map: this.glowTexture,
        transparent: true, opacity: 0.82, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: true,
        toneMapped: false
      });
      this.starField = new THREE.Points(geo, mat);
      this.scene.add(this.starField);

      const nearCount = 260;
      const nearPos = new Float32Array(nearCount * 3);
      for (let i = 0; i < nearCount; i++) {
        nearPos[i * 3] = (Math.random() - 0.5) * 54;
        nearPos[i * 3 + 1] = Math.random() * 22 - 2;
        nearPos[i * 3 + 2] = 30 - Math.random() * 1280;
      }
      const nearGeo = new THREE.BufferGeometry();
      nearGeo.setAttribute('position', new THREE.BufferAttribute(nearPos, 3));
      this.dust = new THREE.Points(nearGeo, new THREE.PointsMaterial({
        color: 0x76efff, size: 0.16, map: this.glowTexture,
        transparent: true, opacity: 0.55, depthWrite: false,
        blending: THREE.AdditiveBlending, sizeAttenuation: true,
        toneMapped: false
      }));
      this.scene.add(this.dust);
    }

    buildNebulae() {
      this.nebulaGroup = new THREE.Group();
      const configs = [
        [-95, 55, -250, 180, 0x3b4dff, 0.12],
        [110, 36, -480, 220, 0x9b4dff, 0.1],
        [-140, 18, -760, 250, 0x1ca3a3, 0.08],
        [150, 62, -980, 210, 0xff4d9d, 0.08],
        [-80, 80, -1180, 200, 0xffc96e, 0.07],
        [70, 12, -150, 120, 0x61fff0, 0.08]
      ];
      configs.forEach((c) => {
        const mat = new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: c[4],
          transparent: true,
          opacity: c[5],
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
          toneMapped: false
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(c[0], c[1], c[2]);
        sprite.scale.set(c[3], c[3] * 0.6, 1);
        this.nebulaGroup.add(sprite);
      });
      this.scene.add(this.nebulaGroup);
    }

    /* -------------------------------------------------------
       Procedural textures
       ------------------------------------------------------- */
    makeGlowTexture() {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.18, 'rgba(255,255,255,0.72)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.2)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }

    makeShadowTexture() {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
      g.addColorStop(0, 'rgba(0,0,0,0.72)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.3)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    }

    makeTileTexture() {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');

      const bg = ctx.createLinearGradient(0, 0, 256, 256);
      bg.addColorStop(0, '#31445e');
      bg.addColorStop(0.5, '#17243a');
      bg.addColorStop(1, '#0a1220');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 256, 256);

      const glow = ctx.createRadialGradient(88, 62, 4, 88, 62, 180);
      glow.addColorStop(0, 'rgba(190,240,255,0.24)');
      glow.addColorStop(0.6, 'rgba(120,180,230,0.04)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, 256, 256);

      ctx.strokeStyle = 'rgba(220,255,255,0.82)';
      ctx.lineWidth = 7;
      ctx.strokeRect(5, 5, 246, 246);
      ctx.strokeStyle = 'rgba(190,245,255,0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(15, 15, 226, 226);

      ctx.strokeStyle = 'rgba(205,250,255,0.10)';
      ctx.lineWidth = 1;
      [64, 128, 192].forEach((v) => {
        ctx.beginPath();
        ctx.moveTo(v, 22);
        ctx.lineTo(v, 234);
        ctx.moveTo(22, v);
        ctx.lineTo(234, v);
        ctx.stroke();
      });

      ctx.strokeStyle = 'rgba(235,255,255,0.9)';
      ctx.lineWidth = 3;
      const corners = [
        [5, 5, 1, 1], [251, 5, -1, 1], [5, 251, 1, -1], [251, 251, -1, -1]
      ];
      corners.forEach(([x, y, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(x, y + sy * 34);
        ctx.lineTo(x, y);
        ctx.lineTo(x + sx * 34, y);
        ctx.stroke();
      });

      ctx.fillStyle = 'rgba(225,255,255,0.26)';
      ctx.fillRect(124, 18, 8, 3);
      ctx.fillRect(124, 235, 8, 3);

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      return tex;
    }

    makeWarningTexture() {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 64;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 256, 64);
      ctx.strokeStyle = 'rgba(255,171,80,0.95)';
      ctx.lineWidth = 5;
      ctx.lineCap = 'square';
      ctx.shadowColor = 'rgba(255,130,60,0.9)';
      ctx.shadowBlur = 12;
      for (let i = 0; i < 4; i++) {
        const x = 34 + i * 58;
        ctx.beginPath();
        ctx.moveTo(x - 18, 44);
        ctx.lineTo(x, 22);
        ctx.lineTo(x + 18, 44);
        ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }

    /* -------------------------------------------------------
       Level data
       ------------------------------------------------------- */
    zoneAt(distance) {
      return clamp(Math.floor(distance / 200), 0, ZONES.length - 1);
    }

    buildLevel() {
      this.rows = [];
      this.obstacles = [];
      this.crystalData = [];
      this.crystalKeys = new Set();
      this.pads = [];
      this.padDistances = [];
      this.specialDistances = [];
      this.checkpoints = [300, 600, 900].map((distance) => ({
        distance, z: -distance, passed: false
      }));
      this.warnings = [];

      const N = Math.ceil((FINISH + 110) / ROW);
      for (let i = 0; i < N; i++) {
        this.rows.push({
          i,
          z: -i * ROW,
          active: [true, true, true, true, true],
          zone: this.zoneAt(i * ROW),
          section: 'start',
          blocked: [],
          hasPad: false,
          checkpoint: false,
          gap: false
        });
      }

      // Checkpoint pads are solid, calm landings.
      this.checkpoints.forEach((cp) => {
        const idx = Math.round(cp.distance / ROW);
        for (let k = -2; k <= 2; k++) {
          const row = this.rows[idx + k];
          if (!row) continue;
          this.setRowActive(row, [0, 1, 2, 3, 4], 'checkpoint');
          row.checkpoint = true;
        }
        this.rows[idx].checkpoint = true;
      });

      this.buildRoute();
      this.addChartPads();
      this.addChartGapsAndWalls();
      this.addChartObstacles();
      this.addChartCrystals();
      this.addGapCrystals(mulberry32(0x1A2B3C4D));

      // The pads are the only jump input, so they are also the musical downbeats.
      this.audio.setPadBeats(this.pads.map((pad) => Math.round(pad.dist / BEAT_DIST)));
    }

    setRowActive(row, lanes, section) {
      row.active = [false, false, false, false, false];
      lanes.forEach((lane) => {
        if (lane >= 0 && lane < 5) row.active[lane] = true;
      });
      if (section) row.section = section;
    }

    activeLanes(row) {
      return row.active.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    }

    routeForBar(bar) {
      const zone = this.zoneAt(bar * 24);
      const routes = [
        [[5, 0], [5, 0], [5, 0], [4, 0], [5, 0], [4, 1], [5, 0], [5, 0]],
        [[4, 0], [4, 1], [3, 1], [4, 0], [4, 1], [3, 1], [4, 0], [4, 1]],
        [[5, 0], [4, 0], [5, 0], [4, 1], [5, 0], [4, 0], [4, 1], [5, 0]],
        [[4, 0], [4, 1], [3, 1], [4, 0], [4, 1], [5, 0], [4, 0], [3, 1]],
        [[3, 1], [3, 1], [3, 1], [4, 1], [3, 1], [4, 0], [4, 1], [5, 0]],
        [[5, 0], [4, 0], [4, 1], [5, 0], [5, 0], [4, 0], [4, 1], [5, 0]]
      ];
      const [width, start] = routes[zone][bar % 8];
      const lanes = [];
      for (let k = 0; k < width; k++) lanes.push(start + k);
      return lanes;
    }

    buildRoute() {
      const last = this.rows.length;
      this.rows.forEach((row, i) => {
        const dist = i * ROW;
        if (row.checkpoint || dist < 12 || dist > FINISH - 42) {
          this.setRowActive(row, [0, 1, 2, 3, 4],
            row.checkpoint ? 'checkpoint' : (dist > FINISH - 42 ? 'finish' : 'start'));
          return;
        }
        const bar = Math.floor(dist / 24);
        let lanes = this.routeForBar(bar);
        // Smooth the lane hand-off at bar lines so a fast ball never meets an
        // invisible diagonal edge. Only one transition row is widened.
        if (dist % 24 < ROW * 1.15 && bar > 0) {
          const prev = this.routeForBar(bar - 1);
          lanes = Array.from(new Set(prev.concat(lanes))).sort((a, b) => a - b);
        }
        this.setRowActive(row, lanes, 'route');
      });
      // The start plate and the finish runway are always five lanes wide.
      for (let i = 0; i < Math.ceil(8 / ROW); i++) this.setRowActive(this.rows[i], [0, 1, 2, 3, 4], 'start');
      for (let i = Math.floor((FINISH - 30) / ROW); i < last; i++) {
        this.setRowActive(this.rows[i], [0, 1, 2, 3, 4], 'finish');
      }
    }

    nearCheckpoint(distance, margin) {
      return this.checkpoints.some((cp) => Math.abs(cp.distance - distance) < margin);
    }

    nearSpecial(distance, margin) {
      return this.specialDistances.some((d) => Math.abs(d - distance) < margin);
    }

    addCrystalAt(lane, distance, y, phase) {
      const key = Math.round(distance * 10) + ':' + Math.round(LANE_X[lane] * 10) + ':' + Math.round(y * 10);
      if (this.crystalKeys.has(key)) return;
      this.crystalKeys.add(key);
      this.crystalData.push({
        x: LANE_X[lane],
        y,
        z: -distance,
        phase: phase != null ? phase : (distance * 0.37) % TAU,
        zone: this.zoneAt(distance),
        collected: false
      });
    }

    addChartPads() {
      const jumps = [
        48, 96, 144, 192, 240, 276, 324, 372, 420, 468, 516, 552, 576,
        636, 684, 732, 780, 816, 864, 876, 924, 972, 1020, 1068, 1116
      ];
      jumps.forEach((dist, index) => {
        if (this.nearCheckpoint(dist, 23.9)) return;
        const row = this.rowAtZ(-dist);
        if (!row) return;
        const lanes = this.activeLanes(row);
        if (lanes.length < 2) return;
        const first = lanes[0];
        const lastLane = lanes[lanes.length - 1];
        const width = (lastLane - first + 1) * LANE - 0.22;
        const x = (LANE_X[first] + LANE_X[lastLane]) / 2;
        const pad = {
          x, z: row.z, dist, beat: Math.round(dist / BEAT_DIST),
          lanes, width, halfWidth: width / 2,
          phase: index * 0.83,
          group: null, rings: [], glow: null, ring: null
        };
        this.pads.push(pad);
        this.padDistances.push(dist);
        this.specialDistances.push(dist);
        row.hasPad = true;
        row.section = 'jump';

        // A wide launch stage, then a readable crystal arc over the landing.
        [4.2, 7.2].forEach((offset, k) => {
          lanes.forEach((lane) => this.addCrystalAt(lane, dist + offset, 2.15 + k * 0.35, k * 1.6));
        });
        [12.5, 16.5].forEach((offset) => {
          lanes.forEach((lane) => this.addCrystalAt(lane, dist + offset, 1.02, 0.5));
        });
      });
    }

    addJumpWall(pad) {
      const distance = pad.dist + 8.2;
      const row = this.rowAtZ(-distance);
      if (!row || row.gap || row.hasPad || row.checkpoint) return;
      if (this.nearCheckpoint(distance, 17) || distance > FINISH - 34) return;
      const lanes = this.activeLanes(row);
      if (lanes.length < 2) return;
      const first = lanes[0];
      const last = lanes[lanes.length - 1];
      const width = (last - first + 1) * LANE - 0.27;
      const x = (LANE_X[first] + LANE_X[last]) / 2;
      this.addObstacle('barrier', x, distance, {
        w: width, h: 0.62, d: 0.52, jumpGate: true
      });
      row.blocked = lanes.slice();
      row.section = 'jump';
      this.specialDistances.push(distance);
    }

    addChartGapsAndWalls() {
      this.pads.forEach((pad, index) => {
        if (pad.dist > 1120 || this.nearCheckpoint(pad.dist, 26)) return;
        if (index % 4 === 1) {
          const distance = pad.dist + 6.4;
          const row = this.rowAtZ(-distance);
          if (!row || row.hasPad || row.checkpoint) return;
          if (this.nearCheckpoint(distance, 16)) return;
          this.setRowActive(row, [], 'gap');
          row.gap = true;
          this.specialDistances.push(distance);
        } else if (index % 4 === 2) {
          this.addJumpWall(pad);
        }
      });
    }

    addObstacle(kind, x, distance, extra) {
      const specs = {
        block:   { w: 1.72, h: 2.02, d: 1.50 },
        prism:   { w: 1.60, h: 2.28, d: 1.58 },
        spinner: { w: 1.66, h: 1.92, d: 1.62 },
        mirror:  { w: 1.72, h: 2.16, d: 0.52 },
        meteor:  { w: 1.56, h: 1.70, d: 1.42 },
        halo:    { w: 1.86, h: 1.82, d: 0.62 },
        barrier: { w: 2.2, h: 0.62, d: 0.52 }
      };
      const spec = specs[kind] || specs.block;
      const obs = {
        type: kind,
        x, baseX: x, z: -distance,
        w: spec.w, h: spec.h, d: spec.d,
        amp: 0, moveSpeed: 0, phase: 0,
        zone: this.zoneAt(distance),
        group: null, core: null, edges: null, top: null
      };
      if (extra) Object.assign(obs, extra);
      this.obstacles.push(obs);
      return obs;
    }

    addChartObstacles() {
      const typesByZone = [
        ['block', 'prism'],
        ['spinner', 'mover'],
        ['mirror', 'block'],
        ['mirror', 'spinner'],
        ['meteor', 'mover'],
        ['halo', 'prism']
      ];
      for (let bar = 0; bar < Math.ceil(FINISH / 24); bar++) {
        const base = bar * 24;
        if (base < 28 || base > FINISH - 56 || this.nearCheckpoint(base, 28)) continue;
        for (let slot = 0; slot < 2; slot++) {
          const distance = base + (slot === 0 ? 8.2 : 17.6);
          if (this.nearSpecial(distance, 5.2) || this.nearCheckpoint(distance, 18)) continue;
          const row = this.rowAtZ(-distance);
          if (!row || !row.active.some(Boolean)) continue;
          const active = this.activeLanes(row);
          if (active.length < 2) continue;
          const width = active.length;
          let chosen;
          if (width === 5 && bar % 7 === 0) {
            chosen = [active[0], active[2], active[4]];
          } else if (width >= 5) {
            const pair = slot === 0 ? [0, width - 1] : [1, width - 2];
            chosen = [active[pair[0]], active[pair[1]]];
          } else if (width >= 4) {
            chosen = slot === 0
              ? [active[0], active[width - 1]]
              : [active[1]];
          } else {
            chosen = [active[(bar + slot * 2 + 1) % width]];
          }
          chosen = Array.from(new Set(chosen)).filter((l) => l != null);
          if (!chosen.length || chosen.length >= width) continue;

          const kinds = typesByZone[this.zoneAt(distance)];
          let kind = kinds[(bar + slot) % kinds.length];
          if (kind === 'mover') {
            if (slot !== 0 || width < 4 || bar % 3 !== 0) kind = 'block';
          }
          if (kind === 'mover') {
            const minX = LANE_X[active[0]];
            const maxX = LANE_X[active[active.length - 1]];
            const center = (minX + maxX) / 2;
            this.addObstacle('mover', center, distance, {
              w: 1.38, h: 1.52, d: 1.24,
              amp: Math.max(1.1, (maxX - minX) / 2 - 0.55),
              moveSpeed: 0.62 + (bar % 4) * 0.08,
              phase: bar * 0.9
            });
          } else {
            chosen.forEach((lane) => {
              row.blocked.push(lane);
              this.addObstacle(kind, LANE_X[lane], distance, {
                phase: bar * 0.7 + lane,
                seed: bar * 13 + lane
              });
            });
          }
          row.section = 'hazard';
          this.specialDistances.push(distance);
        }
      }
    }

    addChartCrystals() {
      for (let bar = 0; bar < Math.ceil(FINISH / 24); bar++) {
        for (let k = 0; k < 4; k++) {
          const distance = bar * 24 + 4.2 + k * 4.4;
          if (distance > FINISH - 8) continue;
          const row = this.rowAtZ(-distance);
          if (!row || !row.active.some(Boolean)) continue;
          const free = this.activeLanes(row).filter((lane) => !row.blocked.includes(lane));
          if (!free.length) continue;
          const lane = free[(bar + k * 2) % free.length];
          this.addCrystalAt(lane, distance, 1.02, bar * 0.6 + k);
        }
      }
    }

    addGapCrystals(rng) {
      const N = this.rows.length;
      for (let i = 1; i < N - 1; i++) {
        if (this.rows[i].active.some(Boolean)) continue;
        let end = i;
        while (end + 1 < N && !this.rows[end + 1].active.some(Boolean)) end++;
        const before = this.rows[i - 1];
        const after = this.rows[end + 1];
        if (before && after && before.active.some(Boolean) && after.active.some(Boolean)) {
          const activeAfter = this.activeLanes(after);
          const lane = activeAfter.includes(2) ? 2 : activeAfter[Math.floor(rng() * activeAfter.length)];
          const zStart = before.z - ROW / 2;
          const zEnd = after.z + ROW / 2;
          for (let k = 0; k < 3; k++) {
            const t = (k + 1) / 4;
            this.crystalData.push({
              x: LANE_X[lane],
              y: 1.9 + Math.sin(t * Math.PI) * 0.72,
              z: lerp(zStart, zEnd, t),
              phase: k * 1.9,
              zone: after.zone,
              collected: false
            });
          }
        }
        i = end;
      }

      this.rows.forEach((row, idx) => {
        const next = this.rows[idx + 1];
        if (row.active.some(Boolean) && next && !next.active.some(Boolean)) {
          this.warnings.push(row);
        }
      });
    }

    /* -------------------------------------------------------
       World geometry
       ------------------------------------------------------- */
    setupWorld() {
      this.buildLevel();

      this.trackGroup = new THREE.Group();
      this.scene.add(this.trackGroup);
      this.obstacleGroup = new THREE.Group();
      this.scene.add(this.obstacleGroup);
      this.crystalGroup = new THREE.Group();
      this.scene.add(this.crystalGroup);
      this.padGroup = new THREE.Group();
      this.scene.add(this.padGroup);
      this.decorGroup = new THREE.Group();
      this.scene.add(this.decorGroup);

      this.buildTrackMeshes();
      this.buildObstacles();
      this.buildCrystals();
      this.buildPads();
      this.buildWarnings();
      this.buildCheckpoints();
      this.buildFinishGate();
      this.buildTrackDecor();
      this.buildScenery();
      this.buildSignatureScenery();
      this.buildStartPlatform();

      this.dom.hudCrystalsTotal.textContent = this.crystalData.length;
      this.padCooldown = 0;
      this.trailHistory = [];
      const p = this.player;
      for (let i = 0; i < 30; i++) this.trailHistory.push(new THREE.Vector3(p.x, p.y, p.z));
    }

    buildTrackMeshes() {
      const tiles = [];
      this.rows.forEach((row) => {
        row.active.forEach((active, lane) => {
          if (!active) return;
          tiles.push({ row, lane });
        });
      });

      const topGeo = new THREE.PlaneGeometry(LANE * 0.95, ROW * 0.91);
      topGeo.rotateX(-Math.PI / 2);
      const topMat = new THREE.MeshBasicMaterial({
        map: this.tileTexture,
        color: 0xffffff,
        toneMapped: false,
        fog: true
      });
      const topMesh = new THREE.InstancedMesh(topGeo, topMat, tiles.length);
      topMesh.frustumCulled = false;

      const baseGeo = new THREE.BoxGeometry(LANE * 0.94, 0.48, ROW * 0.89);
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0.72,
        roughness: 0.38,
        emissive: 0x06121e,
        emissiveIntensity: 0.7
      });
      const baseMesh = new THREE.InstancedMesh(baseGeo, baseMat, tiles.length);
      baseMesh.frustumCulled = false;

      const railGeo = new THREE.BoxGeometry(0.075, 0.11, ROW * 0.95);
      const railMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: false,
        fog: true
      });
      const rails = [];
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();

      tiles.forEach((tile, index) => {
        const { row, lane } = tile;
        const x = LANE_X[lane];
        const theme = ZONES[row.zone];

        dummy.position.set(x, 0.001, row.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        topMesh.setMatrixAt(index, dummy.matrix);

        color.setHex(theme.accent).lerp(new THREE.Color(theme.accent2), ((row.i * 7 + lane * 3) % 11) / 20);
        const topColor = color.clone().multiplyScalar(0.58);
        topMesh.setColorAt(index, topColor);

        dummy.position.set(x, -0.25, row.z);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        baseMesh.setMatrixAt(index, dummy.matrix);
        const baseColor = color.clone().multiplyScalar(0.12).lerp(new THREE.Color(0x070d16), 0.5);
        baseMesh.setColorAt(index, baseColor);
      });

      topMesh.instanceMatrix.needsUpdate = true;
      if (topMesh.instanceColor) topMesh.instanceColor.needsUpdate = true;
      baseMesh.instanceMatrix.needsUpdate = true;
      if (baseMesh.instanceColor) baseMesh.instanceColor.needsUpdate = true;

      this.trackGroup.add(baseMesh);
      this.trackGroup.add(topMesh);
      this.floorTopMesh = topMesh;

      // Bright outer rails make the track silhouette legible.
      this.rows.forEach((row) => {
        const active = row.active
          .map((v, idx) => (v ? idx : -1))
          .filter((v) => v >= 0);
        if (!active.length) return;
        const first = active[0];
        const last = active[active.length - 1];
        const sideX = [LANE_X[first] - LANE / 2 + 0.05, LANE_X[last] + LANE / 2 - 0.05];
        sideX.forEach((x) => rails.push({ x, z: row.z, zone: row.zone }));
      });

      const railMesh = new THREE.InstancedMesh(railGeo, railMat, rails.length);
      railMesh.frustumCulled = false;
      rails.forEach((rail, index) => {
        dummy.position.set(rail.x, 0.055, rail.z);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        railMesh.setMatrixAt(index, dummy.matrix);
        color.setHex(ZONES[rail.zone].accent).multiplyScalar(1.1);
        railMesh.setColorAt(index, color);
      });
      railMesh.instanceMatrix.needsUpdate = true;
      if (railMesh.instanceColor) railMesh.instanceColor.needsUpdate = true;
      this.trackGroup.add(railMesh);
      this.railMesh = railMesh;
    }

    buildObstacles() {
      const unitBox = new THREE.BoxGeometry(1, 1, 1);
      const unitEdges = new THREE.EdgesGeometry(unitBox);
      const ringGeo = new THREE.TorusGeometry(0.78, 0.045, 6, 32);
      const prismGeo = new THREE.ConeGeometry(0.92, 1, 4, 1);
      prismGeo.rotateY(Math.PI / 4);
      const prismEdges = new THREE.EdgesGeometry(prismGeo);
      const rockGeo = new THREE.IcosahedronGeometry(0.72, 0);
      const rockEdges = new THREE.EdgesGeometry(rockGeo);

      const blockMat = new THREE.MeshStandardMaterial({
        color: 0x0a1020, metalness: 0.84, roughness: 0.22,
        emissive: 0x250614, emissiveIntensity: 0.7
      });
      const prismMat = new THREE.MeshStandardMaterial({
        color: 0x111a3f, metalness: 0.8, roughness: 0.15,
        emissive: 0x29106a, emissiveIntensity: 1.0
      });
      const mirrorMat = new THREE.MeshBasicMaterial({
        color: 0xa8f4ff, transparent: true, opacity: 0.24,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x100e16, metalness: 0.35, roughness: 0.8,
        emissive: 0x451610, emissiveIntensity: 0.7
      });
      const barrierMat = new THREE.MeshStandardMaterial({
        color: 0x180d16, metalness: 0.55, roughness: 0.34,
        emissive: 0x6b1828, emissiveIntensity: 0.8
      });
      const moverMat = new THREE.MeshStandardMaterial({
        color: 0x150b24, metalness: 0.8, roughness: 0.25,
        emissive: 0x2c0e58, emissiveIntensity: 0.9
      });
      const edgeBlockMat = new THREE.LineBasicMaterial({ color: 0xff5e91, transparent: true, opacity: 0.96, toneMapped: false });
      const edgeBarrierMat = new THREE.LineBasicMaterial({ color: 0xffb45a, transparent: true, opacity: 0.96, toneMapped: false });
      const edgePrismMat = new THREE.LineBasicMaterial({ color: 0x8d6bff, transparent: true, opacity: 0.95, toneMapped: false });
      const edgeRockMat = new THREE.LineBasicMaterial({ color: 0xff7a3d, transparent: true, opacity: 0.85, toneMapped: false });
      const edgeMoverMat = new THREE.LineBasicMaterial({ color: 0xd58cff, transparent: true, opacity: 0.95, toneMapped: false });
      const edgeMirrorMat = new THREE.LineBasicMaterial({ color: 0x8df6ff, transparent: true, opacity: 0.9, toneMapped: false });
      const topBlockMat = new THREE.MeshBasicMaterial({ color: 0xff6b9b, toneMapped: false });
      const topBarrierMat = new THREE.MeshBasicMaterial({ color: 0xffb45a, toneMapped: false });
      const topPrismMat = new THREE.MeshBasicMaterial({ color: 0xb69bff, toneMapped: false });
      const topRockMat = new THREE.MeshBasicMaterial({ color: 0xff8a42, toneMapped: false });
      const topMirrorMat = new THREE.MeshBasicMaterial({ color: 0xa4f7ff, toneMapped: false });
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0x66fff0, transparent: true, opacity: 0.82,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const haloWarmMat = new THREE.MeshBasicMaterial({
        color: 0xff79c8, transparent: true, opacity: 0.58,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const glowSprite = (color, x, y, opacity) => {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTexture, color, transparent: true, opacity,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
        }));
        sprite.scale.set(x, y, 1);
        return sprite;
      };

      this.obstacles.forEach((obs) => {
        const group = new THREE.Group();
        group.position.set(obs.x, 0, obs.z);
        const h = obs.h;

        if (obs.type === 'barrier') {
          const core = new THREE.Mesh(unitBox, barrierMat);
          core.scale.set(obs.w, h, obs.d);
          core.position.y = h / 2;
          group.add(core);
          const edges = new THREE.LineSegments(unitEdges, edgeBarrierMat);
          edges.scale.copy(core.scale);
          edges.position.y = h / 2;
          group.add(edges);
          const top = new THREE.Mesh(unitBox, topBarrierMat);
          top.scale.set(obs.w * 0.96, 0.045, obs.d * 0.9);
          top.position.y = h + 0.02;
          group.add(top);
          for (let i = 0; i < 7; i++) {
            const tooth = new THREE.Mesh(unitBox, topBarrierMat);
            tooth.scale.set(0.055, 0.16, obs.d * 0.72);
            tooth.position.set(-obs.w * 0.42 + i * (obs.w * 0.14), h + 0.1, 0);
            group.add(tooth);
          }
          obs.core = core;
          obs.edges = edges;
          obs.top = top;
        } else if (obs.type === 'prism') {
          const core = new THREE.Mesh(prismGeo, prismMat);
          core.scale.set(obs.w / 1.65, h, obs.d / 1.65);
          core.position.y = h / 2;
          group.add(core);
          const edges = new THREE.LineSegments(prismEdges, edgePrismMat);
          edges.scale.copy(core.scale);
          edges.position.y = h / 2;
          group.add(edges);
          const crown = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), topPrismMat);
          crown.position.y = h + 0.27;
          group.add(crown);
          group.add(glowSprite(0x8b6bff, 2.4, 3.2, 0.28));
          obs.core = core;
          obs.edges = edges;
          obs.crown = crown;
        } else if (obs.type === 'spinner') {
          const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.64, 0), prismMat);
          core.scale.y = 1.35;
          core.position.y = h * 0.52;
          group.add(core);
          const coreEdges = new THREE.LineSegments(new THREE.EdgesGeometry(core.geometry), edgePrismMat);
          coreEdges.scale.copy(core.scale);
          coreEdges.position.y = core.position.y;
          group.add(coreEdges);
          const ringA = new THREE.Mesh(ringGeo, edgePrismMat);
          ringA.rotation.x = Math.PI / 2;
          ringA.position.y = h * 0.52;
          ringA.scale.setScalar(1.02);
          group.add(ringA);
          const ringB = new THREE.Mesh(ringGeo, edgeMoverMat);
          ringB.rotation.y = Math.PI / 2;
          ringB.position.y = h * 0.52;
          group.add(ringB);
          group.add(glowSprite(0x9b6bff, 3.0, 3.0, 0.24));
          obs.core = core;
          obs.spinRings = [ringA, ringB];
        } else if (obs.type === 'mirror') {
          const panel = new THREE.Mesh(unitBox, mirrorMat);
          panel.scale.set(obs.w, h * 0.94, 0.08);
          panel.position.y = h / 2;
          group.add(panel);
          const panelEdges = new THREE.LineSegments(unitEdges, edgeMirrorMat);
          panelEdges.scale.copy(panel.scale);
          panelEdges.position.y = h / 2;
          group.add(panelEdges);
          const railGeo = new THREE.BoxGeometry(0.05, h * 0.98, 0.07);
          [-1, 1].forEach((side) => {
            const rail = new THREE.Mesh(railGeo, topMirrorMat);
            rail.position.set(side * obs.w * 0.4, h / 2, 0.02);
            group.add(rail);
          });
          const shard = new THREE.Mesh(unitBox, mirrorMat);
          shard.scale.set(obs.w * 0.42, h * 0.3, 0.035);
          shard.position.set(obs.w * 0.16, h * 0.38, 0.16);
          shard.rotation.z = -0.24;
          group.add(shard);
          group.add(glowSprite(0x8df6ff, 2.8, 3.4, 0.22));
          obs.core = panel;
          obs.edges = panelEdges;
          obs.shard = shard;
        } else if (obs.type === 'meteor') {
          const rock = new THREE.Mesh(rockGeo, rockMat);
          rock.scale.set(obs.w / 1.44, h / 1.5, obs.d / 1.44);
          rock.position.y = h * 0.5;
          rock.rotation.set(0.35, 0.6, -0.2);
          group.add(rock);
          const edges = new THREE.LineSegments(rockEdges, edgeRockMat);
          edges.scale.copy(rock.scale);
          edges.position.copy(rock.position);
          edges.rotation.copy(rock.rotation);
          group.add(edges);
          const orbiters = [];
          for (let i = 0; i < 3; i++) {
            const shard = new THREE.Mesh(new THREE.TetrahedronGeometry(0.12 + i * 0.025, 0), topRockMat);
            shard.position.set(Math.cos(i * 2.1) * 0.85, h * 0.45 + i * 0.28, Math.sin(i * 2.1) * 0.55);
            group.add(shard);
            orbiters.push(shard);
          }
          group.add(glowSprite(0xff6a2e, 3.4, 3.0, 0.3));
          obs.core = rock;
          obs.edges = edges;
          obs.orbiters = orbiters;
        } else if (obs.type === 'halo') {
          const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.052, 8, 48), haloMat);
          ringA.position.y = h * 0.52;
          group.add(ringA);
          const ringB = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.032, 6, 40), haloWarmMat);
          ringB.position.y = h * 0.52;
          group.add(ringB);
          const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), topMirrorMat);
          core.position.y = h * 0.52;
          group.add(core);
          group.add(glowSprite(0x66fff0, 3.2, 3.2, 0.28));
          obs.core = core;
          obs.spinRings = [ringA, ringB];
        } else if (obs.type === 'mover') {
          const core = new THREE.Mesh(unitBox, moverMat);
          core.scale.set(0.92, h, obs.d * 0.7);
          core.position.y = h / 2;
          group.add(core);
          const edges = new THREE.LineSegments(unitEdges, edgeMoverMat);
          edges.scale.copy(core.scale);
          edges.position.y = h / 2;
          group.add(edges);
          const rotor = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.045, 6, 28), edgeMoverMat);
          rotor.rotation.x = Math.PI / 2;
          rotor.position.y = h * 0.55;
          group.add(rotor);
          const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.45, 4), topPrismMat);
          fin.position.y = h + 0.18;
          group.add(fin);
          group.add(glowSprite(0xb45cff, 2.8, 2.8, 0.28));
          obs.core = core;
          obs.edges = edges;
          obs.rotor = rotor;
        } else {
          const core = new THREE.Mesh(unitBox, blockMat);
          core.scale.set(obs.w, h, obs.d);
          core.position.y = h / 2;
          group.add(core);
          const edges = new THREE.LineSegments(unitEdges, edgeBlockMat);
          edges.scale.copy(core.scale);
          edges.position.y = h / 2;
          group.add(edges);
          const top = new THREE.Mesh(unitBox, topBlockMat);
          top.scale.set(obs.w * 0.88, 0.04, obs.d * 0.88);
          top.position.y = h + 0.02;
          group.add(top);
          const inset = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({
            color: 0xff3f78, transparent: true, opacity: 0.22,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
          }));
          inset.scale.set(obs.w * 0.54, h * 0.48, 0.012);
          inset.position.set(0, h * 0.5, obs.d * 0.5 + 0.012);
          group.add(inset);
          obs.core = core;
          obs.edges = edges;
          obs.top = top;
        }

        obs.group = group;
        this.obstacleGroup.add(group);
      });
    }

    buildCrystals() {
      const count = this.crystalData.length;
      if (!count) return;
      const geo = new THREE.OctahedronGeometry(0.29, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffd36e,
        emissive: 0xffa71e,
        emissiveIntensity: 1.9,
        metalness: 0.45,
        roughness: 0.18
      });
      this.crystalMesh = new THREE.InstancedMesh(geo, mat, count);
      this.crystalMesh.frustumCulled = false;

      const glowGeo = new THREE.OctahedronGeometry(0.52, 0);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xffcf5e,
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      });
      this.crystalGlow = new THREE.InstancedMesh(glowGeo, glowMat, count);
      this.crystalGlow.frustumCulled = false;

      this.crystalGroup.add(this.crystalMesh);
      this.crystalGroup.add(this.crystalGlow);
      this.crystalDummy = new THREE.Object3D();
      this.crystalDummy2 = new THREE.Object3D();
      this.syncCrystals(0);
    }

    buildPads() {
      const unitBox = new THREE.BoxGeometry(1, 1, 1);
      const ringGeo = new THREE.TorusGeometry(0.46, 0.035, 6, 28);
      const arrowGeo = new THREE.ConeGeometry(0.2, 0.4, 3);
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0x062c34, metalness: 0.35, roughness: 0.28,
        emissive: 0x0a6570, emissiveIntensity: 0.9
      });
      const stripMat = new THREE.MeshBasicMaterial({
        color: 0x9bfff4, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xd8ffff, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const arrowMat = new THREE.MeshBasicMaterial({
        color: 0xffd36e, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x54fff0, transparent: true, opacity: 0.78, toneMapped: false
      });

      this.pads.forEach((pad) => {
        const group = new THREE.Group();
        group.position.set(pad.x, 0.02, pad.z);

        const base = new THREE.Mesh(unitBox, baseMat);
        base.scale.set(pad.width, 0.09, 1.2);
        base.position.y = 0.045;
        group.add(base);

        const baseEdges = new THREE.LineSegments(new THREE.EdgesGeometry(unitBox), edgeMat);
        baseEdges.scale.copy(base.scale);
        baseEdges.position.y = 0.045;
        group.add(baseEdges);

        const strip = new THREE.Mesh(unitBox, stripMat);
        strip.scale.set(pad.width * 0.94, 0.018, 0.07);
        strip.position.set(0, 0.098, 0.36);
        group.add(strip);

        const backStrip = strip.clone();
        backStrip.position.z = -0.36;
        group.add(backStrip);

        pad.rings = [];
        pad.lanes.forEach((lane) => {
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.set(LANE_X[lane] - pad.x, 0.11, 0);
          group.add(ring);
          pad.rings.push(ring);

          const arrow = new THREE.Mesh(arrowGeo, arrowMat);
          arrow.position.set(LANE_X[lane] - pad.x, 0.26, 0.12);
          arrow.rotation.x = Math.PI / 2;
          arrow.rotation.z = Math.PI;
          group.add(arrow);
        });

        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: 0x4cffe7,
          transparent: true,
          opacity: 0.34,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false
        }));
        glow.scale.set(Math.min(12, pad.width * 1.35), 3.4, 1);
        glow.position.y = 0.18;
        group.add(glow);

        const beaconGeo = new THREE.BoxGeometry(0.045, 1.25, 0.045);
        const beacons = [];
        [-1, 1].forEach((side) => {
          const beacon = new THREE.Mesh(beaconGeo, stripMat);
          beacon.position.set(side * (pad.width / 2 - 0.08), 0.66, 0);
          group.add(beacon);
          beacons.push(beacon);
        });

        pad.group = group;
        pad.ring = pad.rings[Math.floor(pad.rings.length / 2)];
        pad.glow = glow;
        pad.beacons = beacons;
        this.padGroup.add(group);
      });
    }

    buildWarnings() {
      if (!this.warnings.length) return;
      this.warningMaterial = new THREE.MeshBasicMaterial({
        map: this.warningTexture,
        color: 0xffb15c,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false
      });

      this.warnings.forEach((row) => {
        const active = row.active
          .map((v, idx) => (v ? idx : -1))
          .filter((v) => v >= 0);
        if (!active.length) return;
        const width = (active[active.length - 1] - active[0] + 1) * LANE - 0.18;
        const geo = new THREE.PlaneGeometry(width, 1.55);
        const mesh = new THREE.Mesh(geo, this.warningMaterial);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(
          (LANE_X[active[0]] + LANE_X[active[active.length - 1]]) / 2,
          0.045,
          row.z - ROW / 2 + 0.78
        );
        this.trackGroup.add(mesh);
      });
    }

    buildCheckpoints() {
      this.checkpointVisuals = [];
      this.checkpointMat = new THREE.MeshBasicMaterial({
        color: 0x5dffe0,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      });
      const postMat = new THREE.MeshBasicMaterial({
        color: 0x56f7e7,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      });

      this.checkpoints.forEach((cp) => {
        const idx = Math.round(cp.distance / ROW);
        const row = this.rows[idx];
        if (!row) return;
        const active = row.active
          .map((v, lane) => (v ? lane : -1))
          .filter((v) => v >= 0);
        if (!active.length) return;
        const left = LANE_X[active[0]] - LANE / 2;
        const right = LANE_X[active[active.length - 1]] + LANE / 2;
        const width = right - left;

        const band = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.75), this.checkpointMat);
        band.rotation.x = -Math.PI / 2;
        band.position.set((left + right) / 2, 0.05, -cp.distance);
        this.trackGroup.add(band);

        const postGeo = new THREE.BoxGeometry(0.09, 2.1, 0.09);
        const p1 = new THREE.Mesh(postGeo, postMat);
        p1.position.set(left + 0.25, 1.05, -cp.distance);
        const p2 = p1.clone();
        p2.position.x = right - 0.25;
        this.trackGroup.add(p1, p2);
        this.checkpointVisuals.push({ band, p1, p2 });
      });
    }

    buildFinishGate() {
      const gold = 0xffd36e;
      const mat = new THREE.MeshBasicMaterial({
        color: gold, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
        toneMapped: false, side: THREE.DoubleSide
      });
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xffb44d, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false,
        toneMapped: false, side: THREE.DoubleSide
      });
      const arch = new THREE.Mesh(new THREE.TorusGeometry(7.0, 0.1, 8, 100, Math.PI), mat);
      arch.position.set(0, 0.4, -FINISH);
      this.decorGroup.add(arch);
      this.finishArch = arch;

      const halo = new THREE.Mesh(new THREE.TorusGeometry(7.0, 0.5, 8, 100, Math.PI), haloMat);
      halo.position.copy(arch.position);
      this.decorGroup.add(halo);
      this.finishHalo = halo;

      const pillarGeo = new THREE.BoxGeometry(0.38, 6.8, 0.38);
      const pillarMat = new THREE.MeshBasicMaterial({ color: gold, toneMapped: false });
      const p1 = new THREE.Mesh(pillarGeo, pillarMat);
      p1.position.set(-7.0, 3.4, -FINISH);
      const p2 = p1.clone();
      p2.position.x = 7.0;
      this.decorGroup.add(p1, p2);

      const checkerGeo = new THREE.BoxGeometry(0.7, 0.035, 0.85);
      for (let i = 0; i < 18; i++) {
        const tile = new THREE.Mesh(checkerGeo, new THREE.MeshBasicMaterial({
          color: i % 2 ? 0xf4ffff : 0x17223a,
          toneMapped: false
        }));
        tile.position.set(-6.0 + i * 0.705, 0.035, -FINISH);
        this.decorGroup.add(tile);
      }

      const light1 = new THREE.PointLight(gold, 6, 26, 2);
      light1.position.set(-6, 1.2, -FINISH + 1);
      const light2 = light1.clone();
      light2.position.x = 6;
      this.decorGroup.add(light1, light2);
    }

    buildTrackDecor() {
      // Distant gate rings create a sense of speed and scale.
      this.gateGroups = [];
      for (let d = 64; d < FINISH - 40; d += 78) {
        const zone = this.zoneAt(d);
        const color = ZONES[zone].accent;
        const group = new THREE.Group();
        group.position.set(0, 2.7, -d);
        const m1 = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.24,
          blending: THREE.AdditiveBlending, depthWrite: false,
          toneMapped: false
        });
        const m2 = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.08,
          blending: THREE.AdditiveBlending, depthWrite: false,
          toneMapped: false
        });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(9.4, 0.045, 5, 84), m1);
        group.add(ring);
        const ring2 = new THREE.Mesh(new THREE.TorusGeometry(11.2, 0.035, 5, 84), m2);
        group.add(ring2);
        this.decorGroup.add(group);
        this.gateGroups.push({ group, ring, ring2, phase: Math.random() * TAU });
      }

      // Vertical guide lights along the track.
      const count = Math.floor(FINISH / 28) * 2;
      const pylonGeo = new THREE.BoxGeometry(0.06, 6.4, 0.06);
      const pylonMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.62,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, count);
      pylons.frustumCulled = false;
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      let index = 0;
      for (let d = 12; d < FINISH; d += 28) {
        const zone = this.zoneAt(d);
        [-8.6, 8.6].forEach((x) => {
          dummy.position.set(x, 3.2, -d);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          pylons.setMatrixAt(index, dummy.matrix);
          color.setHex(ZONES[zone].accent).multiplyScalar(0.9);
          pylons.setColorAt(index, color);
          index++;
        });
      }
      pylons.instanceMatrix.needsUpdate = true;
      if (pylons.instanceColor) pylons.instanceColor.needsUpdate = true;
      this.decorGroup.add(pylons);
    }

    buildScenery() {
      const count = 44;
      const geo = new THREE.IcosahedronGeometry(1, 0);
      const solidMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0.15,
        roughness: 0.82,
        flatShading: true,
        emissive: 0x06101e,
        emissiveIntensity: 0.5
      });
      const solid = new THREE.InstancedMesh(geo, solidMat, count);
      solid.frustumCulled = false;

      const wireMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, wireframe: true, transparent: true,
        opacity: 0.24, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false
      });
      const wire = new THREE.InstancedMesh(geo, wireMat, count);
      wire.frustumCulled = false;

      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      const rng = mulberry32(0xC0FFEE42);
      for (let i = 0; i < count; i++) {
        const side = rng() < 0.5 ? -1 : 1;
        const z = -25 - rng() * (FINISH + 40);
        const zone = this.zoneAt(-z);
        const scale = 1.4 + rng() * 4.4;
        dummy.position.set(side * (16 + rng() * 32), -6 + rng() * 24, z);
        dummy.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
        dummy.scale.set(scale * (0.7 + rng() * 0.7), scale, scale * (0.7 + rng() * 0.7));
        dummy.updateMatrix();
        solid.setMatrixAt(i, dummy.matrix);
        wire.setMatrixAt(i, dummy.matrix);
        color.setHex(ZONES[zone].accent).multiplyScalar(0.3);
        solid.setColorAt(i, color);
        color.setHex(ZONES[zone].accent).multiplyScalar(0.95);
        wire.setColorAt(i, color);
      }
      solid.instanceMatrix.needsUpdate = true;
      wire.instanceMatrix.needsUpdate = true;
      if (solid.instanceColor) solid.instanceColor.needsUpdate = true;
      if (wire.instanceColor) wire.instanceColor.needsUpdate = true;
      this.decorGroup.add(solid);
      this.decorGroup.add(wire);
    }

    buildSignatureScenery() {
      this.landmarks = [];
      const glow = (color, size, opacity) => {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTexture, color, transparent: true, opacity,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
        }));
        sprite.scale.set(size, size, 1);
        return sprite;
      };
      const additive = (color, opacity) => new THREE.MeshBasicMaterial({
        color, transparent: true, opacity,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const lineMat = (color, opacity) => new THREE.LineBasicMaterial({
        color, transparent: true, opacity, toneMapped: false
      });
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x0d1524, metalness: 0.45, roughness: 0.72,
        emissive: 0x071827, emissiveIntensity: 0.7, flatShading: true
      });
      const metalMat = new THREE.MeshStandardMaterial({
        color: 0x101525, metalness: 0.9, roughness: 0.18,
        emissive: 0x130c27, emissiveIntensity: 0.55
      });

      const defs = [
        { type: 'halo',    dist: 86,   side: -1, x: 18, color: 0x66fff0 },
        { type: 'rift',    dist: 286,  side: 1,  x: 17, color: 0x6b9bff },
        { type: 'turbine', dist: 486,  side: -1, x: 19, color: 0xff5a7d },
        { type: 'mirror',  dist: 686,  side: 1,  x: 18, color: 0x9df6ff },
        { type: 'meteor',  dist: 886,  side: -1, x: 20, color: 0xff8a42 },
        { type: 'pendulum',dist: 1086, side: 1,  x: 20, color: 0xffd36e }
      ];

      defs.forEach((def) => {
        const group = new THREE.Group();
        group.position.set(def.side * def.x, 0, -def.dist);
        const entry = { type: def.type, group };

        if (def.type === 'halo') {
          const y = 8.2;
          const ring1 = new THREE.Mesh(new THREE.TorusGeometry(6.0, 0.10, 8, 80), additive(def.color, 0.55));
          ring1.position.y = y;
          ring1.rotation.z = 0.18;
          const ring2 = new THREE.Mesh(new THREE.TorusGeometry(4.9, 0.045, 6, 64), additive(def.color, 0.32));
          ring2.position.y = y;
          ring2.rotation.z = -0.26;
          const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 0), additive(0xffffff, 0.85));
          core.position.y = y;
          core.scale.y = 1.7;
          group.add(ring1, ring2, core);
          entry.rings = [ring1, ring2];
          entry.core = core;
          entry.orbiters = [];
          for (let i = 0; i < 4; i++) {
            const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.28 + i * 0.05, 0), additive(def.color, 0.9));
            shard.position.set(Math.cos(i * 1.7) * 6.7, y + Math.sin(i * 2.1) * 2.1, Math.sin(i * 1.7) * 5.0);
            group.add(shard);
            entry.orbiters.push(shard);
          }
        } else if (def.type === 'rift') {
          const left = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 2.35, 16, 5, 1), rockMat);
          left.position.set(-2.2, 8, 0);
          left.rotation.z = 0.16;
          const right = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 2.2, 15, 5, 1), rockMat);
          right.position.set(2.5, 7.6, 0.8);
          right.rotation.z = -0.25;
          const edge1 = new THREE.LineSegments(new THREE.EdgesGeometry(left.geometry), lineMat(def.color, 0.65));
          edge1.position.copy(left.position);
          edge1.rotation.copy(left.rotation);
          edge1.scale.copy(left.scale);
          const edge2 = new THREE.LineSegments(new THREE.EdgesGeometry(right.geometry), lineMat(0x8d6bff, 0.55));
          edge2.position.copy(right.position);
          edge2.rotation.copy(right.rotation);
          edge2.scale.copy(right.scale);
          const seam = new THREE.Mesh(new THREE.BoxGeometry(0.08, 14, 0.5), additive(def.color, 0.8));
          seam.position.set(0.2, 7.6, 0);
          seam.rotation.z = -0.05;
          group.add(left, right, edge1, edge2, seam);
          entry.seam = seam;
          entry.orbiters = [];
          for (let i = 0; i < 5; i++) {
            const chunk = new THREE.Mesh(new THREE.TetrahedronGeometry(0.34 + i * 0.08), additive(def.color, 0.75));
            group.add(chunk);
            entry.orbiters.push(chunk);
          }
        } else if (def.type === 'turbine') {
          const y = 7.2;
          const outer = new THREE.Mesh(new THREE.TorusGeometry(6.4, 0.13, 8, 72), additive(def.color, 0.52));
          outer.position.y = y;
          const rotor = new THREE.Group();
          rotor.position.y = y;
          const bladeGeo = new THREE.BoxGeometry(6.6, 0.22, 0.6);
          for (let i = 0; i < 6; i++) {
            const blade = new THREE.Mesh(bladeGeo, additive(i % 2 ? def.color : 0xffb36b, 0.66));
            blade.position.x = 3.25;
            blade.rotation.z = i * Math.PI / 3;
            const arm = new THREE.Group();
            arm.rotation.z = i * Math.PI / 3;
            arm.add(blade);
            rotor.add(arm);
          }
          const hub = new THREE.Mesh(new THREE.OctahedronGeometry(0.68, 0), additive(0xffffff, 0.9));
          rotor.add(hub);
          group.add(outer, rotor, glow(def.color, 14, 0.22));
          entry.rotor = rotor;
        } else if (def.type === 'mirror') {
          const panelMat = new THREE.MeshBasicMaterial({
            color: 0xbdf8ff, transparent: true, opacity: 0.16,
            blending: THREE.AdditiveBlending, depthWrite: false,
            side: THREE.DoubleSide, toneMapped: false
          });
          entry.panels = [];
          for (let i = 0; i < 3; i++) {
            const panel = new THREE.Mesh(new THREE.BoxGeometry(3.0, 8.4 - i * 0.6, 0.10), panelMat);
            panel.position.set((i - 1) * 4.1, 5.2 + i * 0.3, 0);
            panel.rotation.y = (i - 1) * 0.22;
            const frame = new THREE.LineSegments(new THREE.EdgesGeometry(panel.geometry), lineMat(def.color, 0.8));
            frame.position.copy(panel.position);
            frame.rotation.copy(panel.rotation);
            group.add(panel, frame);
            entry.panels.push(panel);
          }
          const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), additive(0xffffff, 0.8));
          shard.position.set(0, 5.4, 1.1);
          group.add(shard, glow(def.color, 12, 0.2));
          entry.shard = shard;
        } else if (def.type === 'meteor') {
          const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), rockMat);
          core.position.y = 8.4;
          const halo = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.08, 6, 48), additive(def.color, 0.38));
          halo.position.y = 8.4;
          halo.rotation.x = Math.PI / 2;
          group.add(core, halo, glow(def.color, 18, 0.25));
          entry.core = core;
          entry.orbiters = [];
          for (let i = 0; i < 8; i++) {
            const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32 + (i % 3) * 0.16, 0), rockMat);
            const edge = new THREE.LineSegments(new THREE.EdgesGeometry(rock.geometry), lineMat(def.color, 0.75));
            rock.add(edge);
            group.add(rock);
            entry.orbiters.push(rock);
          }
        } else if (def.type === 'pendulum') {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.26, 0.4), additive(def.color, 0.55));
          beam.position.y = 15.3;
          const postGeo = new THREE.BoxGeometry(0.28, 15, 0.28);
          [-5, 5].forEach((x) => {
            const post = new THREE.Mesh(postGeo, metalMat);
            post.position.set(x, 7.5, 0);
            group.add(post);
          });
          const pivot = new THREE.Group();
          pivot.position.y = 15.1;
          const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 9.5, 0.12), additive(def.color, 0.7));
          arm.position.y = -4.8;
          const ring = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.10, 8, 64), additive(def.color, 0.6));
          ring.position.y = -9.4;
          const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.05, 6, 48), additive(0xffffff, 0.42));
          ring2.position.y = -9.4;
          pivot.add(arm, ring, ring2);
          group.add(beam, pivot, glow(def.color, 14, 0.2));
          entry.pivot = pivot;
          entry.ring = ring;
          entry.ring2 = ring2;
        }

        this.decorGroup.add(group);
        this.landmarks.push(entry);
      });
    }

    buildStartPlatform() {
      const group = new THREE.Group();
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0x070d18,
        metalness: 0.75,
        roughness: 0.35,
        emissive: 0x071625,
        emissiveIntensity: 0.7
      });
      const base = new THREE.Mesh(new THREE.BoxGeometry(15.5, 0.6, 12), baseMat);
      base.position.set(0, -0.36, 5.4);
      group.add(base);

      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x54f5e7, transparent: true, opacity: 0.55, toneMapped: false
      });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(base.geometry), edgeMat);
      edges.position.copy(base.position);
      group.add(edges);

      const lineMat = new THREE.MeshBasicMaterial({
        color: 0x66fff0, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      const line = new THREE.Mesh(new THREE.BoxGeometry(13.8, 0.03, 0.12), lineMat);
      line.position.set(0, -0.04, 0.4);
      group.add(line);

      this.decorGroup.add(group);
    }

    /* -------------------------------------------------------
       Player, trail, effects
       ------------------------------------------------------- */
    setupPlayer() {
      this.playerGroup = new THREE.Group();
      const innerMat = new THREE.MeshStandardMaterial({
        color: 0x0a2633,
        metalness: 0.9,
        roughness: 0.12,
        emissive: 0x0d8e9e,
        emissiveIntensity: 0.95
      });
      this.ballInner = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 20), innerMat);
      this.playerGroup.add(this.ballInner);

      this.ballOuterMat = new THREE.MeshBasicMaterial({
        color: 0xbaffff, wireframe: true, transparent: true,
        opacity: 0.16, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false
      });
      this.ballOuter = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.06, 18, 12), this.ballOuterMat);
      this.playerGroup.add(this.ballOuter);

      this.ballRingMat = new THREE.MeshBasicMaterial({
        color: 0x6bfff0, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      this.ballRings = [];
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(BALL_R * 1.38, 0.012, 4, 50),
          this.ballRingMat
        );
        ring.rotation.set(Math.PI / 2 * i, i * 0.7, i * 1.1);
        this.playerGroup.add(ring);
        this.ballRings.push(ring);
      }

      this.ballGlowMat = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0x55f6e4,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      });
      this.ballGlow = new THREE.Sprite(this.ballGlowMat);
      this.ballGlow.scale.set(2.6, 2.6, 1);
      this.playerGroup.add(this.ballGlow);

      this.shieldMat = new THREE.MeshBasicMaterial({
        color: 0x9cffff, transparent: true, opacity: 0.22,
        wireframe: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false
      });
      this.shield = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.62, 18, 12), this.shieldMat);
      this.playerGroup.add(this.shield);

      this.ballLight = new THREE.PointLight(0x56f7e7, 2.6, 10, 2);
      this.playerGroup.add(this.ballLight);

      this.scene.add(this.playerGroup);

      this.shadowMat = new THREE.MeshBasicMaterial({
        map: this.shadowTexture,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        toneMapped: false
      });
      this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.65, 1.65), this.shadowMat);
      this.shadow.rotation.x = -Math.PI / 2;
      this.shadow.position.y = 0.04;
      this.scene.add(this.shadow);

      this.buildTrail();
    }

    buildTrail() {
      this.trailCount = 30;
      const positions = new Float32Array(this.trailCount * 3);
      const alphas = new Float32Array(this.trailCount);
      const sizes = new Float32Array(this.trailCount);
      this.trailHistory = [];
      for (let i = 0; i < this.trailCount; i++) {
        positions[i * 3] = 0;
        positions[i * 3 + 1] = BALL_R;
        positions[i * 3 + 2] = 0;
        alphas[i] = Math.max(0, 1 - i / this.trailCount);
        sizes[i] = 0.32 * alphas[i] + 0.03;
        this.trailHistory.push(new THREE.Vector3(0, BALL_R, 0));
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
      geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
      this.trailUniforms = {
        uColor: { value: new THREE.Color(ZONES[0].accent) },
        uScale: { value: 900 }
      };
      const mat = new THREE.ShaderMaterial({
        uniforms: this.trailUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          attribute float aAlpha;
          attribute float aSize;
          varying float vAlpha;
          uniform float uScale;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * uScale / max(1.0, -mv.z);
            gl_Position = projectionMatrix * mv;
            vAlpha = aAlpha;
          }
        `,
        fragmentShader: `
          uniform vec3 uColor;
          varying float vAlpha;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p);
            float a = smoothstep(0.5, 0.04, d) * vAlpha;
            gl_FragColor = vec4(uColor, a);
          }
        `
      });
      this.trail = new THREE.Points(geo, mat);
      this.trail.frustumCulled = false;
      this.scene.add(this.trail);
      this.trailGeo = geo;
      this.trailPositions = positions;
      this.trailAlphas = alphas;
      this.trailSizes = sizes;
    }

    setupEffects() {
      this.effectRings = [];
      const geo = new THREE.RingGeometry(0.4, 0.54, 40);
      for (let i = 0; i < 10; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0x66fff0,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        this.scene.add(mesh);
        this.effectRings.push({
          mesh, mat, age: 0, life: 0.5, startScale: 1, grow: 5, visible: false
        });
      }
    }

    spawnRing(x, y, z, color, life, grow, startScale) {
      const ring = this.effectRings.find((r) => !r.visible) || this.effectRings[0];
      ring.visible = true;
      ring.age = 0;
      ring.life = life || 0.6;
      ring.grow = grow || 5;
      ring.startScale = startScale || 1;
      ring.mesh.visible = true;
      ring.mesh.position.set(x, y, z);
      ring.mesh.scale.setScalar(ring.startScale);
      ring.mat.color.setHex(color || 0x66fff0);
      ring.mat.opacity = 0.8;
    }

    updateEffects(dt) {
      this.effectRings.forEach((r) => {
        if (!r.visible) return;
        r.age += dt;
        const t = r.age / r.life;
        if (t >= 1) {
          r.visible = false;
          r.mesh.visible = false;
          return;
        }
        const s = r.startScale + t * r.grow;
        r.mesh.scale.setScalar(s);
        r.mat.opacity = (1 - t) * 0.8;
      });
    }

    /* -------------------------------------------------------
       UI setup
       ------------------------------------------------------- */
    setupUI() {
      this.heartEls = [];
      this.dom.hudHearts.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const heart = document.createElement('span');
        heart.className = 'heart';
        heart.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-9.5-9A5.3 5.3 0 0 1 12 6a5.3 5.3 0 0 1 9.5 6c-2 4.3-9.5 9-9.5 9Z"/></svg>';
        this.dom.hudHearts.appendChild(heart);
        this.heartEls.push(heart);
      }

      this.flashEl = document.createElement('div');
      this.flashEl.className = 'screen-flash';
      this.app.appendChild(this.flashEl);

      this.dom.btnSound.classList.toggle('muted', this.muted);
      this.refreshBest();
      this.renderHearts(true);
      this.updateSoundButton();
    }

    initChangelog() {
      let seen = false;
      try { seen = localStorage.getItem(CHANGELOG_KEY) === VERSION; } catch (e) {}
      this.dom.changelogDot.classList.toggle('hidden', seen);
      if (!seen) {
        setTimeout(() => {
          if (this.state === 'menu') this.openChangelog();
        }, 650);
      }
    }

    openChangelog() {
      this.dom.changelog.classList.remove('hidden');
    }

    closeChangelog() {
      this.dom.changelog.classList.add('hidden');
      this.dom.changelogDot.classList.add('hidden');
      try { localStorage.setItem(CHANGELOG_KEY, VERSION); } catch (e) {}
    }

    refreshBest() {
      this.best = this.loadBest();
      const b = this.best;
      if (b && b.score) {
        this.dom.bestLabel.textContent = '最佳 ' + formatNumber(b.score);
        this.dom.bestScore.textContent = formatNumber(b.score);
        this.dom.bestDistance.textContent = formatNumber(b.distance || 0);
        this.dom.bestCrystals.textContent = formatNumber(b.crystals || 0);
      } else {
        this.dom.bestLabel.textContent = '尚未启程';
        this.dom.bestScore.textContent = '0';
        this.dom.bestDistance.textContent = '0';
        this.dom.bestCrystals.textContent = '0';
      }
    }

    loadBest() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { score: 0, distance: 0, crystals: 0, time: 0 };
        const parsed = JSON.parse(raw);
        return Object.assign({ score: 0, distance: 0, crystals: 0, time: 0 }, parsed);
      } catch (e) {
        return { score: 0, distance: 0, crystals: 0, time: 0 };
      }
    }

    saveBest(stats) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
      } catch (e) {}
    }

    updateSoundButton() {
      this.dom.btnSound.classList.toggle('muted', this.muted);
      this.dom.btnSound.title = this.muted ? '开启声音 (M)' : '静音 (M)';
    }

    toggleSound() {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      if (!this.muted) {
        this.audio.init();
        this.audio.resume();
      }
      try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch (e) {}
      this.updateSoundButton();
    }

    renderHearts(instant) {
      const previous = this._lastHearts;
      this.heartEls.forEach((el, i) => {
        const lost = i >= this.hearts;
        el.classList.toggle('lost', lost);
        if (!instant && !lost && previous >= 0 && i >= previous) {
          el.classList.remove('gain');
          void el.offsetWidth;
          el.classList.add('gain');
        }
      });
      this._lastHearts = this.hearts;
    }

    updateHearts() {
      this.renderHearts(false);
    }

    showZoneBanner(index) {
      const zone = ZONES[clamp(index, 0, ZONES.length - 1)];
      this.zoneBannerEls.index.textContent = String(clamp(index, 0, ZONES.length - 1) + 1).padStart(2, '0');
      this.zoneBannerEls.name.textContent = zone.name;
      this.zoneBannerEls.en.textContent = zone.en;
      this.dom.zoneBanner.classList.remove('show');
      void this.dom.zoneBanner.offsetWidth;
      this.dom.zoneBanner.classList.add('show');
      clearTimeout(this.zoneBannerTimer);
      this.zoneBannerTimer = setTimeout(() => {
        this.dom.zoneBanner.classList.remove('show');
      }, 2900);
    }

    showCombo(text, danger) {
      this.dom.comboToast.textContent = text;
      this.dom.comboToast.classList.toggle('danger', !!danger);
      this.dom.comboToast.classList.remove('show');
      void this.dom.comboToast.offsetWidth;
      this.dom.comboToast.classList.add('show');
    }

    showCheckpointToast(text) {
      this.dom.checkpointToast.textContent = text;
      this.dom.checkpointToast.classList.remove('show');
      void this.dom.checkpointToast.offsetWidth;
      this.dom.checkpointToast.classList.add('show');
    }

    flashDamage() {
      this.flashEl.classList.remove('active');
      void this.flashEl.offsetWidth;
      this.flashEl.classList.add('active');
    }

    updateHUD(force) {
      const distance = Math.floor(this.maxDistance);
      const pct = clamp((this.maxDistance / FINISH) * 100, 0, 100);
      if (force || distance !== this._lastHudDistance) {
        this.dom.hudDistance.textContent = distance;
        this._lastHudDistance = distance;
      }
      if (force || this.crystalsCollected !== this._lastHudCrystals) {
        this.dom.hudCrystals.textContent = this.crystalsCollected;
        this._lastHudCrystals = this.crystalsCollected;
      }
      if (force || Math.round(pct) !== this._lastHudPct) {
        this.dom.hudProgressFill.style.width = pct.toFixed(2) + '%';
        this.dom.hudProgressDot.style.left = pct.toFixed(2) + '%';
        this.dom.hudProgressPct.textContent = Math.floor(pct) + '%';
        this._lastHudPct = Math.round(pct);
      }
      const speedLevel = clamp(Math.round(((this.speed - 10) / 6.5) * 5), 0, 5);
      if (force || speedLevel !== this._lastHudSpeed) {
        this.speedBarEls.forEach((el, i) => el.classList.toggle('on', i < speedLevel));
        this._lastHudSpeed = speedLevel;
      }
    }

    applyZone(index, instant) {
      const idx = clamp(index, 0, ZONES.length - 1);
      if (idx === this.zoneIndex && !instant) return;
      const changed = this.zoneIndex !== idx;
      this.zoneIndex = idx;
      const zone = ZONES[idx];
      this.targetFog.setHex(zone.fog);
      this.targetTop.setHex(zone.top);
      this.targetBottom.setHex(zone.bottom);
      this.targetHaze.setHex(zone.haze);
      this.targetAccent.setHex(zone.accent);
      this.targetAccent2.setHex(zone.accent2);
      this.dom.hudZone.textContent = zone.name;
      if (instant) {
        this.fogColor.setHex(zone.fog);
        this.skyUniforms.uTop.value.setHex(zone.top);
        this.skyUniforms.uBottom.value.setHex(zone.bottom);
        this.skyUniforms.uHaze.value.setHex(zone.haze);
        this.playerAccent.setHex(zone.accent);
        this.scene.fog.color.copy(this.fogColor);
        this.trailUniforms.uColor.value.copy(this.playerAccent);
      }
      if (changed && !instant && this.state === 'playing') {
        this.showZoneBanner(idx);
      }
    }

    updateTheme(dt) {
      const k = 1 - Math.exp(-dt * 1.1);
      this.fogColor.lerp(this.targetFog, k);
      this.scene.fog.color.copy(this.fogColor);
      this.skyUniforms.uTop.value.lerp(this.targetTop, k);
      this.skyUniforms.uBottom.value.lerp(this.targetBottom, k);
      this.skyUniforms.uHaze.value.lerp(this.targetHaze, k);
      this.playerAccent.lerp(this.targetAccent, k);
      if (this.ballRingMat) this.ballRingMat.color.copy(this.playerAccent);
      if (this.ballGlowMat) this.ballGlowMat.color.copy(this.playerAccent);
      if (this.trailUniforms) this.trailUniforms.uColor.value.copy(this.playerAccent);
      if (this.ballLight) this.ballLight.color.copy(this.playerAccent);
      if (this.hemi) {
        this.hemi.color.copy(this.playerAccent).lerp(new THREE.Color(0xffffff), 0.55);
      }
    }

    /* -------------------------------------------------------
       State flow
       ------------------------------------------------------- */
    showMenu() {
      this.state = 'menu';
      this.audio.stopMusic(true);
      this.resetRace();
      this.state = 'menu';
      this.dom.hud.classList.add('hidden');
      this.dom.result.classList.add('hidden');
      this.dom.pause.classList.add('hidden');
      this.dom.countdown.classList.add('hidden');
      this.dom.menu.classList.remove('hidden', 'leaving');
      this.dom.zoneBanner.classList.remove('show');
      this.dom.checkpointToast.classList.remove('show');
      this.dom.comboToast.classList.remove('show');
      this.refreshBest();
      this.updateSoundButton();
      this.camera.position.set(2.4, 7.7, 12.4);
      this.camLook.set(0, 1.4, -10);
      this.applyZone(0, true);
    }

    startGame() {
      if (!['menu', 'over', 'won', 'paused'].includes(this.state)) return;
      this.audio.init();
      this.audio.resume();
      this.dom.result.classList.add('hidden');
      this.dom.pause.classList.add('hidden');
      this.dom.countdown.classList.add('hidden');
      this.dom.menu.classList.add('leaving');
      this.dom.changelog.classList.add('hidden');
      this.dom.hud.classList.remove('hidden');
      this.resetRace();
      this.state = 'prestart';
      this.prestartTimer = 0.5;
      this.dom.menu.classList.remove('hidden');
      this.audio.stopMusic(true);
      this.hintTimer = 10;
      this.dom.controlHint.style.opacity = '1';
      this.updateHUD(true);
    }

    beginCountdown() {
      this.dom.menu.classList.add('hidden');
      this.dom.menu.classList.remove('leaving');
      this.state = 'countdown';
      this.countdownTimer = 3.0;
      this.lastCountdownNum = 3;
      this.dom.countdown.classList.remove('hidden');
      this.dom.countdownNum.classList.remove('go');
      this.dom.countdownLabel.textContent = '准备出发';
      this.setCountdownNumber(3);
      this.audio.countdown(false);
    }

    setCountdownNumber(n) {
      this.dom.countdownNum.textContent = n;
      this.dom.countdownNum.classList.remove('tick');
      void this.dom.countdownNum.offsetWidth;
      this.dom.countdownNum.classList.add('tick');
    }

    resetRace() {
      this.player = {
        x: 0, y: BALL_R, z: 0, vx: 0, vy: 0,
        grounded: true, invuln: 0
      };
      this.speed = BASE_SPEED;
      this.elapsed = 0;
      this.maxDistance = 0;
      this.hearts = 3;
      this.crystalsCollected = 0;
      this.bonusScore = 0;
      this.crystalStreak = 0;
      this.lastCrystalAt = 0;
      this.padCooldown = 0;
      this.hitSlow = 0;
      this.shake = 0;
      this.goTimer = 0;
      this.countdownTimer = 0;
      this.resultTimer = 0;
      this.resultShown = false;
      this.hintTimer = 10;
      this.hudTimer = 0;
      this._lastHudDistance = -1;
      this._lastHudCrystals = -1;
      this._lastHudPct = -1;
      this._lastHudSpeed = -1;
      this._lastHearts = -1;
      this.zoneIndex = -1;
      this.applyZone(0, true);
      this.crystalsCollected = 0;
      if (this.crystalData) {
        this.crystalData.forEach((c) => { c.collected = false; });
      }
      if (this.checkpoints) {
        this.checkpoints.forEach((cp) => { cp.passed = false; });
      }
      if (this.pads) this.pads.forEach((p) => { p.phase = Math.random() * TAU; });
      this.updateHearts();
      this.renderHearts(true);
      this.updateHUD(true);
      this.input.axis = 0;
      this.input.targetX = null;
      this.pointer.active = false;
      this.keys.left = false;
      this.keys.right = false;
      this.dom.controlHint.style.opacity = '1';
      this.playerGroup.position.set(0, BALL_R, 0);
      this.playerGroup.visible = true;
      this.shield.visible = false;
      this.shadow.visible = true;
      this.resize();
      this.camera.position.set(0, 7.4, 11.2);
      this.camLook.set(0, 1.4, -11);
      this.trailHistory = this.trailHistory || [];
      this.trailHistory.forEach((v) => v.set(0, BALL_R, 0));
      this.syncCrystals(0);
      this.dom.zoneBanner.classList.remove('show');
      this.dom.checkpointToast.classList.remove('show');
      this.dom.comboToast.classList.remove('show');
    }

    returnToMenu() {
      this.audio.stopMusic(true);
      this.dom.pause.classList.add('hidden');
      this.dom.result.classList.add('hidden');
      this.dom.countdown.classList.add('hidden');
      this.showMenu();
    }

    pauseGame() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      this.dom.pause.classList.remove('hidden');
      this.audio.pauseMusic();
      this.input.axis = 0;
      this.keys.left = false;
      this.keys.right = false;
      this.pointer.active = false;
      this.input.targetX = null;
    }

    resumeGame() {
      if (this.state !== 'paused') return;
      this.dom.pause.classList.add('hidden');
      this.state = 'playing';
      this.audio.startMusic();
      this.clock.getDelta();
    }

    finishRun(won) {
      if (this.state === 'over' || this.state === 'won') return;
      this.state = won ? 'won' : 'over';
      this.resultTimer = won ? 1.45 : 0.95;
      this.resultShown = false;
      this.input.axis = 0;
      this.keys.left = false;
      this.keys.right = false;
      this.pointer.active = false;
      this.input.targetX = null;
      this.audio.stopMusic();
      if (won) this.audio.win();
      else this.audio.lose();
      this.finalStats = {
        score: this.calcScore(won),
        distance: won ? FINISH : Math.floor(this.maxDistance),
        crystals: this.crystalsCollected,
        time: this.elapsed,
        won
      };
      this.best = this.loadBest();
      this.isNewRecord = this.finalStats.score > (this.best.score || 0);
      if (this.isNewRecord) {
        this.best = {
          score: this.finalStats.score,
          distance: this.finalStats.distance,
          crystals: this.finalStats.crystals,
          time: this.finalStats.time
        };
        this.saveBest(this.best);
      }
      if (this.shake < 0.8) this.shake = 0.8;
    }

    showResult() {
      if (this.resultShown || !this.finalStats) return;
      this.resultShown = true;
      const s = this.finalStats;
      this.dom.result.classList.remove('hidden');
      this.dom.resultBadge.textContent = s.won ? 'FINISH · RUN COMPLETE' : 'RUN ENDED';
      this.dom.resultTitle.textContent = s.won ? '冲线成功' : '轨道失守';
      this.dom.resultSubtitle.textContent = s.won
        ? '你穿过了整片霓虹天空，星海为你亮起。'
        : '距离终点还有 ' + Math.max(0, Math.ceil(FINISH - s.distance)) + ' 米。再靠近一点。';
      this.dom.resultScore.textContent = formatNumber(s.score);
      this.dom.resultDistance.textContent = formatNumber(s.distance);
      this.dom.resultCrystals.textContent = formatNumber(s.crystals);
      this.dom.resultTime.textContent = formatTime(s.time);
      this.dom.resultBest.classList.toggle('show', !!this.isNewRecord);
      this.dom.resultBest.textContent = this.isNewRecord ? 'NEW RECORD' : 'BEST ' + formatNumber(this.best.score || 0);
      this.refreshBest();
    }

    calcScore(won) {
      return Math.round(
        this.maxDistance * 8 +
        this.crystalsCollected * 105 +
        this.hearts * 380 +
        this.bonusScore +
        (won ? 2500 : 0)
      );
    }

    /* -------------------------------------------------------
       Input
       ------------------------------------------------------- */
    bindUI() {
      this.dom.btnStart.addEventListener('click', () => this.startGame());
      this.dom.btnPause.addEventListener('click', () => this.pauseGame());
      this.dom.btnResume.addEventListener('click', () => this.resumeGame());
      this.dom.btnRestartPause.addEventListener('click', () => {
        this.dom.pause.classList.add('hidden');
        this.startGame();
      });
      this.dom.btnMenuPause.addEventListener('click', () => this.returnToMenu());
      this.dom.btnAgain.addEventListener('click', () => {
        this.dom.result.classList.add('hidden');
        this.startGame();
      });
      this.dom.btnMenu.addEventListener('click', () => this.returnToMenu());
      this.dom.btnSound.addEventListener('click', () => this.toggleSound());
      this.dom.btnChangelog.addEventListener('click', () => this.openChangelog());
      this.dom.btnChangelogClose.addEventListener('click', () => this.closeChangelog());

      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.state === 'playing') this.pauseGame();
      });

      window.addEventListener('resize', () => this.resize());
      window.addEventListener('orientationchange', () => {
        setTimeout(() => this.resize(), 120);
      });
    }

    bindInput() {
      window.addEventListener('keydown', (e) => {
        const code = e.code;
        if (code === 'Space' || code === 'ArrowUp' || code === 'ArrowDown' ||
            code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyW') {
          e.preventDefault();
        }
        if (!this.dom.changelog.classList.contains('hidden')) {
          if (code === 'Escape' || code === 'Enter' || code === 'Space') {
            this.closeChangelog();
          }
          return;
        }
        if (code === 'KeyM') {
          this.toggleSound();
          return;
        }
        if (code === 'Escape' || code === 'KeyP') {
          if (this.state === 'playing') this.pauseGame();
          else if (this.state === 'paused') this.resumeGame();
          return;
        }
        if (this.state === 'menu' && (code === 'Enter' || code === 'Space')) {
          this.startGame();
          return;
        }
        if ((this.state === 'over' || this.state === 'won') && this.resultShown &&
            (code === 'Enter' || code === 'Space')) {
          this.dom.result.classList.add('hidden');
          this.startGame();
          return;
        }
        if (this.state !== 'playing') return;

        if (code === 'ArrowLeft' || code === 'KeyA') {
          this.keys.left = true;
          this.input.targetX = null;
        } else if (code === 'ArrowRight' || code === 'KeyD') {
          this.keys.right = true;
          this.input.targetX = null;
        }
      }, { passive: false });

      window.addEventListener('keyup', (e) => {
        const code = e.code;
        if (code === 'ArrowLeft' || code === 'KeyA') this.keys.left = false;
        if (code === 'ArrowRight' || code === 'KeyD') this.keys.right = false;
      });

      this.canvas.addEventListener('pointerdown', (e) => {
        if (this.state !== 'playing') return;
        if (this.pointer.active) return;
        this.pointer.active = true;
        this.pointer.id = e.pointerId;
        this.pointer.startX = e.clientX;
        this.pointer.startY = e.clientY;
        this.pointer.startBallX = this.player.x;
        this.pointer.moved = false;
        this.pointer.startTime = performance.now();
        try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
      });

      this.canvas.addEventListener('pointermove', (e) => {
        if (!this.pointer.active || e.pointerId !== this.pointer.id) return;
        const dx = e.clientX - this.pointer.startX;
        const dy = e.clientY - this.pointer.startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) this.pointer.moved = true;
        if (Math.abs(dx) > 3) {
          this.input.targetX = clamp(this.pointer.startBallX + dx * 0.026, -5.3, 5.3);
        }
      });

      const release = (e) => {
        if (!this.pointer.active || e.pointerId !== this.pointer.id) return;
        this.pointer.active = false;
        this.pointer.id = null;
        this.input.targetX = null;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
      };
      this.canvas.addEventListener('pointerup', release);
      this.canvas.addEventListener('pointercancel', release);
    }

    /* -------------------------------------------------------
       Simulation
       ------------------------------------------------------- */
    surfaceAt(x, z) {
      const idx = Math.floor((-z + ROW / 2) / ROW);
      const row = this.rows[idx];
      if (!row) return false;
      // The five lanes are contiguous: steering across a lane seam must never
      // drop the ball, only leaving the outer edge or crossing a real gap does.
      if (Math.abs(x) > 5.86) return false;
      const lane = Math.round(x / LANE + 2);
      if (lane < 0 || lane > 4) return false;
      return row.active[lane];
    }

    rowAtZ(z) {
      return this.rows[Math.floor((-z + ROW / 2) / ROW)];
    }

    updatePhysics(dt) {
      const p = this.player;
      this.elapsed += dt;
      if (this.padCooldown > 0) this.padCooldown -= dt;
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (this.hitSlow > 0) this.hitSlow = Math.max(0, this.hitSlow - dt);

      // Locked tempo: 12 m/s keeps every beat exactly 6 m, so the level chart
      // and the 120 BPM soundtrack stay in phase even after a hit.
      this.speed = damp(this.speed, BASE_SPEED, 10, dt);
      p.z -= this.speed * dt;

      let targetVx;
      if (this.pointer.active && this.input.targetX != null) {
        targetVx = clamp((this.input.targetX - p.x) * 9.0, -13, 13);
      } else {
        const axis = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
        targetVx = axis * 10.6;
      }
      p.vx = damp(p.vx, targetVx, p.grounded ? 14 : 8, dt);
      p.x = clamp(p.x + p.vx * dt, -7.3, 7.3);

      p.vy -= GRAVITY * dt;
      p.y += p.vy * dt;
      const support = this.surfaceAt(p.x, p.z);
      if (support && p.y <= BALL_R + 0.02 && p.vy <= 0) {
        const wasAir = !p.grounded && p.vy < -4;
        p.y = BALL_R;
        p.vy = 0;
        p.grounded = true;
        if (wasAir) this.audio.land();
      } else {
        p.grounded = false;
      }

      // Launch pads.
      if (this.padCooldown <= 0) {
        for (let i = 0; i < this.pads.length; i++) {
          const pad = this.pads[i];
          const reach = pad.halfWidth != null ? pad.halfWidth : 0.95;
          if (Math.abs(pad.z - p.z) < 1.25 && Math.abs(p.x - pad.x) < reach && p.y < 1.15) {
            p.vy = PAD_V;
            p.grounded = false;
            this.padCooldown = 0.35;
            this.audio.padHit();
            this.spawnRing(pad.x, 0.12, pad.z, 0x5fffe8, 0.75, 6.5, 0.8);
            this.spawnRing(p.x, 0.12, pad.z, 0x9fffff, 0.45, 2.8, 0.5);
            if (this.shake < 0.3) this.shake = 0.3;
            break;
          }
        }
      }

      // Obstacles.
      if (p.invuln <= 0) {
        for (let i = 0; i < this.obstacles.length; i++) {
          const obs = this.obstacles[i];
          if (Math.abs(obs.z - p.z) > 2.7) continue;
          const ox = obs.type === 'mover'
            ? obs.baseX + Math.sin(this.visualTime * obs.moveSpeed + obs.phase) * obs.amp
            : obs.x;
          const cx = clamp(p.x, ox - obs.w / 2, ox + obs.w / 2);
          const cy = clamp(p.y, 0, obs.h);
          const cz = clamp(p.z, obs.z - obs.d / 2, obs.z + obs.d / 2);
          const dx = p.x - cx;
          const dy = p.y - cy;
          const dz = p.z - cz;
          if (dx * dx + dy * dy + dz * dz < (BALL_R * 0.9) * (BALL_R * 0.9)) {
            this.damage('hit');
            break;
          }
        }
      }

      // Crystals.
      for (let i = 0; i < this.crystalData.length; i++) {
        const c = this.crystalData[i];
        if (c.collected) continue;
        if (Math.abs(c.z - p.z) > 1.4) continue;
        const dx = c.x - p.x;
        const dz = c.z - p.z;
        if (dx * dx + dz * dz < 1.45 && Math.abs(p.y - c.y) < 1.55) {
          c.collected = true;
          this.crystalsCollected++;
          this.crystalStreak++;
          this.lastCrystalAt = this.elapsed;
          this.audio.crystal(this.crystalStreak);
          this.spawnRing(c.x, c.y - 0.15, c.z, 0xffd36e, 0.55, 2.4, 0.55);
          if (this.crystalsCollected % 10 === 0) {
            this.bonusScore += 150;
            this.showCombo('星晶共鸣 · +150');
          }
          this.updateHUD(false);
        }
      }

      if (this.elapsed - this.lastCrystalAt > 3.5) this.crystalStreak = 0;

      this.maxDistance = Math.max(this.maxDistance, Math.max(0, -p.z));
      this.applyZone(this.zoneAt(this.maxDistance));

      // Checkpoints.
      this.checkpoints.forEach((cp) => {
        if (!cp.passed && this.maxDistance >= cp.distance) {
          cp.passed = true;
          if (this.hearts < 3) {
            this.hearts++;
            this.updateHearts();
            this.showCheckpointToast('检查点 · 星核恢复');
            this.showCombo('CHECKPOINT');
          } else {
            this.bonusScore += 300;
            this.showCheckpointToast('检查点 · 完美通过 +300');
            this.showCombo('PERFECT · +300');
          }
          this.audio.checkpoint();
          this.spawnRing(p.x, 0.08, p.z, 0x65fff0, 0.85, 7, 0.8);
        }
      });

      if (this.maxDistance >= FINISH) {
        this.finishRun(true);
        return;
      }

      if (p.y < -7.5) {
        if (p.invuln > 0) {
          this.respawn();
        } else {
          this.damage('fall');
        }
      }
    }

    damage(type) {
      if (this.state !== 'playing' || this.player.invuln > 0) return;
      this.hearts = Math.max(0, this.hearts - 1);
      this.player.invuln = 2.3;
      this.shake = 1.55;
      this.flashDamage();
      this.audio.hit();
      if (navigator.vibrate) {
        try { navigator.vibrate(24); } catch (e) {}
      }
      if (this.hearts <= 0) {
        this.updateHearts();
        this.finishRun(false);
        return;
      }
      if (type === 'fall') {
        this.respawn();
        this.showCombo('星核 −1', true);
      } else {
        this.player.vy = 3.6;
        this.player.grounded = false;
        this.hitSlow = 0.55;
        this.showCombo('星核 −1', true);
      }
      this.updateHearts();
    }

    freeLaneForRow(row) {
      if (!row) return null;
      const active = row.active
        .map((v, idx) => (v ? idx : -1))
        .filter((v) => v >= 0);
      if (!active.length) return null;
      const blocked = this.obstacles
        .filter((o) => Math.abs(o.z - row.z) < 0.1)
        .map((o) => Math.round(o.x / LANE + 2));
      const free = active.filter((l) => !blocked.includes(l));
      return free.length ? free : active;
    }

    respawn() {
      const p = this.player;
      let targetIndex = Math.floor((-p.z + ROW / 2) / ROW) - 1;
      let found = null;
      for (let k = 0; k < 12; k++) {
        const idx = targetIndex + k;
        const row = this.rows[idx];
        if (!row) continue;
        const lanes = this.freeLaneForRow(row);
        if (lanes && lanes.length) {
          found = { row, lanes };
          break;
        }
      }
      if (!found) {
        p.x = 0;
        p.z = 0;
        p.y = BALL_R + 1.3;
        p.vx = 0;
        p.vy = 0;
        p.invuln = 2.5;
        p.grounded = false;
        return;
      }
      const lane = found.lanes.reduce((best, l) =>
        Math.abs(LANE_X[l] - p.x) < Math.abs(LANE_X[best] - p.x) ? l : best, found.lanes[0]);
      p.x = LANE_X[lane];
      p.z = found.row.z;
      p.y = BALL_R + 1.8;
      p.vx = 0;
      p.vy = 0;
      p.invuln = 2.45;
      p.grounded = false;
      this.speed = BASE_SPEED;
      this.pointer.active = false;
      this.input.targetX = null;
      this.camera.position.z = p.z + this.camOffsetZ;
      this.trailHistory.forEach((v) => v.set(p.x, p.y, p.z));
    }

    /* -------------------------------------------------------
       Camera / visuals
       ------------------------------------------------------- */
    resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dprCap = this.isTouchDevice() ? 1.5 : 1.8;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.isPortrait = w / h < 0.95;
      this.camOffsetZ = this.isPortrait ? 13.6 : (w / h < 1.25 ? 11.4 : 10.8);
      this.camHeight = this.isPortrait ? 9.4 : 7.4;
      this.lookAhead = this.isPortrait ? 17.5 : 13;
      this.baseFov = this.isPortrait ? 75 : (w / h < 1.25 ? 67 : 61);
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }

    isTouchDevice() {
      return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    }

    updateCamera(dt) {
      if (!this.camera) return;
      let tx, ty, tz, lx, ly, lz;
      const p = this.player;
      const raceView = this.state === 'playing' || this.state === 'paused' ||
                       this.state === 'countdown' || this.state === 'prestart' ||
                       this.state === 'won' || this.state === 'over';

      if (!raceView) {
        const t = this.visualTime;
        tx = Math.sin(t * 0.15) * 2.0;
        ty = 7.8 + Math.sin(t * 0.36) * 0.18;
        tz = 12.6 + Math.sin(t * 0.22) * 0.25;
        lx = 0;
        ly = 1.4;
        lz = -10.5;
      } else {
        const ox = this.camOffsetZ || 10.8;
        const oy = this.camHeight || 7.4;
        const la = this.lookAhead || 13;
        tx = p.x * 0.36;
        ty = oy + p.y * 0.18;
        tz = p.z + ox;
        lx = p.x * 0.19;
        ly = 1.2 + p.y * 0.16;
        lz = p.z - la;
      }

      const posLambda = this.state === 'menu' ? 1.6 : 9.5;
      this.camera.position.x = damp(this.camera.position.x, tx, posLambda, dt);
      this.camera.position.y = damp(this.camera.position.y, ty, posLambda, dt);
      this.camera.position.z = damp(this.camera.position.z, tz, this.state === 'menu' ? 1.7 : 14, dt);
      this.camLook.x = damp(this.camLook.x, lx, 8, dt);
      this.camLook.y = damp(this.camLook.y, ly, 8, dt);
      this.camLook.z = damp(this.camLook.z, lz, 9, dt);

      if (this.shake > 0.001) {
        const s = this.shake;
        this.camera.position.x += (Math.random() - 0.5) * s * 0.32;
        this.camera.position.y += (Math.random() - 0.5) * s * 0.25;
        this.shake = Math.max(0, this.shake - dt * 2.6);
      }

      this.camera.lookAt(this.camLook);

      let targetFov = this.baseFov || 61;
      if (this.state === 'playing') {
        targetFov += clamp((this.speed - BASE_SPEED) * 0.85, 0, 6.5);
      }
      const newFov = damp(this.camera.fov, targetFov, 2.6, dt);
      if (Math.abs(newFov - this.camera.fov) > 0.001) {
        this.camera.fov = newFov;
        this.camera.updateProjectionMatrix();
      }

      this.sky.position.copy(this.camera.position);
      if (this.trailUniforms) {
        const bufferH = this.renderer.domElement.height || window.innerHeight;
        this.trailUniforms.uScale.value = bufferH /
          (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
      }
    }

    updatePlayerVisuals(dt) {
      const p = this.player;
      const menuBob = this.state === 'menu' ? Math.sin(this.visualTime * 1.5) * 0.07 : 0;
      const y = p.y + menuBob;
      this.playerGroup.position.set(p.x, y, p.z);

      const groundSpeed = Math.max(0, this.speed);
      this.ballInner.rotation.x -= groundSpeed * dt / BALL_R;
      this.ballInner.rotation.z += p.vx * dt / BALL_R * 0.5;
      this.ballOuter.rotation.y += dt * 0.8;
      this.ballOuter.rotation.x += dt * 0.23;
      this.ballRings.forEach((ring, i) => {
        ring.rotation.z += dt * (0.8 + i * 0.35) * (i % 2 ? -1 : 1);
        ring.rotation.y += dt * 0.5;
      });
      this.ballGlow.scale.setScalar(2.5 + Math.sin(this.visualTime * 3.2) * 0.15);

      this.shield.visible = p.invuln > 0 && this.state === 'playing';
      if (this.shield.visible) {
        const s = 1 + Math.sin(this.visualTime * 10) * 0.04;
        this.shield.scale.setScalar(s);
        this.shieldMat.opacity = 0.18 + Math.sin(this.visualTime * 8) * 0.06;
        this.shield.rotation.y += dt * 1.5;
      }
      this.playerGroup.visible = y > -8;

      const supported = this.surfaceAt(p.x, p.z);
      this.shadow.visible = supported && y > -2;
      if (this.shadow.visible) {
        const height = Math.max(0, p.y - BALL_R);
        const scale = clamp(1.1 - height * 0.035, 0.65, 1.1);
        this.shadow.position.set(p.x, 0.035, p.z);
        this.shadow.scale.set(scale, scale, 1);
        this.shadowMat.opacity = clamp(0.42 - height * 0.035, 0.16, 0.42);
      }
    }

    updateTrail(dt) {
      if (!this.trailHistory) return;
      const p = this.player;
      const bob = this.state === 'menu' ? Math.sin(this.visualTime * 1.5) * 0.07 : 0;
      for (let i = this.trailHistory.length - 1; i > 0; i--) {
        this.trailHistory[i].copy(this.trailHistory[i - 1]);
      }
      this.trailHistory[0].set(p.x, p.y + bob, p.z);
      const n = this.trailCount;
      for (let i = 0; i < n; i++) {
        const v = this.trailHistory[i];
        this.trailPositions[i * 3] = v.x;
        this.trailPositions[i * 3 + 1] = v.y;
        this.trailPositions[i * 3 + 2] = v.z;
        const a = Math.pow(1 - i / n, 1.7);
        this.trailAlphas[i] = a * (this.state === 'menu' ? 0.38 : 0.85);
        this.trailSizes[i] = 0.32 * a + 0.02;
      }
      this.trailGeo.attributes.position.needsUpdate = true;
      this.trailGeo.attributes.aAlpha.needsUpdate = true;
      this.trailGeo.attributes.aSize.needsUpdate = true;
    }

    syncCrystals(time) {
      if (!this.crystalMesh) return;
      for (let i = 0; i < this.crystalData.length; i++) {
        const c = this.crystalData[i];
        if (c.collected) {
          this.crystalDummy.position.set(c.x, c.y, c.z);
          this.crystalDummy.scale.setScalar(0.0001);
          this.crystalDummy.rotation.set(0, 0, 0);
          this.crystalDummy.updateMatrix();
          this.crystalMesh.setMatrixAt(i, this.crystalDummy.matrix);
          this.crystalGlow.setMatrixAt(i, this.crystalDummy.matrix);
          continue;
        }
        const bob = Math.sin(time * 2 + c.phase) * 0.1;
        const rot = time * 1.4 + c.phase;
        this.crystalDummy.position.set(c.x, c.y + bob, c.z);
        this.crystalDummy.rotation.set(0.35, rot, 0);
        this.crystalDummy.scale.setScalar(1);
        this.crystalDummy.updateMatrix();
        this.crystalMesh.setMatrixAt(i, this.crystalDummy.matrix);

        this.crystalDummy2.position.set(c.x, c.y + bob, c.z);
        this.crystalDummy2.rotation.set(0.35, rot, 0);
        this.crystalDummy2.scale.setScalar(1.4 + Math.sin(time * 2.4 + c.phase) * 0.14);
        this.crystalDummy2.updateMatrix();
        this.crystalGlow.setMatrixAt(i, this.crystalDummy2.matrix);
      }
      this.crystalMesh.instanceMatrix.needsUpdate = true;
      this.crystalGlow.instanceMatrix.needsUpdate = true;
    }

    updateWorldVisuals(dt) {
      const t = this.visualTime;

      this.obstacles.forEach((obs) => {
        if (!obs.group) return;
        if (obs.type === 'mover') {
          const x = obs.baseX + Math.sin(t * obs.moveSpeed + obs.phase) * obs.amp;
          obs.group.position.x = x;
          obs.x = x;
          obs.group.rotation.y = Math.sin(t * obs.moveSpeed * 0.7 + obs.phase) * 0.15;
          if (obs.rotor) obs.rotor.rotation.z = t * 2.2;
        } else if (obs.type === 'spinner') {
          if (obs.core) obs.core.rotation.y = t * 1.4 + obs.phase;
          if (obs.spinRings) {
            obs.spinRings[0].rotation.z = t * 1.8 + obs.phase;
            obs.spinRings[1].rotation.x = t * 1.15 + obs.phase;
          }
        } else if (obs.type === 'halo') {
          if (obs.spinRings) {
            obs.spinRings[0].rotation.z = -t * 0.5 + obs.phase;
            obs.spinRings[1].rotation.z = t * 0.75 + obs.phase;
            const pulse = 1 + Math.sin(t * 2.2 + obs.phase) * 0.06;
            obs.spinRings[0].scale.setScalar(pulse);
            obs.spinRings[1].scale.setScalar(1.06 - (pulse - 1));
          }
          if (obs.core) obs.core.scale.setScalar(1 + Math.sin(t * 4.1 + obs.phase) * 0.16);
        } else if (obs.type === 'prism') {
          if (obs.crown) {
            obs.crown.rotation.y = t * 1.5 + obs.phase;
            obs.crown.position.y = obs.h + 0.27 + Math.sin(t * 2.4 + obs.phase) * 0.08;
          }
        } else if (obs.type === 'mirror') {
          if (obs.shard) obs.shard.rotation.z = -0.24 + Math.sin(t * 0.9 + obs.phase) * 0.06;
        } else if (obs.type === 'meteor') {
          if (obs.core) {
            obs.core.rotation.x = 0.35 + t * 0.18;
            obs.core.rotation.y = 0.6 + t * 0.24;
          }
          if (obs.orbiters) {
            obs.orbiters.forEach((shard, i) => {
              const a = t * 2.1 + i * 2.1 + obs.phase;
              shard.position.x = Math.cos(a) * 0.86;
              shard.position.z = Math.sin(a) * 0.58;
              shard.position.y = obs.h * 0.45 + i * 0.24 + Math.sin(a * 2) * 0.08;
              shard.rotation.x = a;
              shard.rotation.y = a * 1.4;
            });
          }
        }
      });

      this.pads.forEach((pad) => {
        if (!pad.group) return;
        if (pad.rings) {
          pad.rings.forEach((ring, i) => {
            const pulse = 1 + Math.sin(t * 3.4 + pad.phase + i * 0.55) * 0.08;
            ring.scale.setScalar(pulse);
            ring.rotation.z = t * 0.8 + pad.phase;
          });
        }
        if (pad.glow) {
          pad.glow.material.opacity = 0.27 + Math.sin(t * 2.3 + pad.phase) * 0.09;
        }
        if (pad.beacons) {
          pad.beacons.forEach((beacon, i) => {
            beacon.scale.y = 1 + Math.sin(t * 2.8 + pad.phase + i) * 0.16;
            beacon.position.y = 0.66 + Math.sin(t * 2.1 + pad.phase + i) * 0.05;
          });
        }
      });

      if (this.landmarks) {
        this.landmarks.forEach((l, li) => {
          const phase = li * 0.9;
          if (l.type === 'halo') {
            l.rings[0].rotation.z = 0.18 + t * 0.12;
            l.rings[1].rotation.z = -0.26 - t * 0.09;
            l.core.rotation.y = t * 0.7;
            l.core.scale.x = 1 + Math.sin(t * 2.1) * 0.08;
            l.orbiters.forEach((shard, i) => {
              const a = t * 0.45 + i * 1.7;
              shard.position.x = Math.cos(a) * 6.7;
              shard.position.z = Math.sin(a) * 5.0;
              shard.position.y = 8.2 + Math.sin(a * 2.1) * 2.1;
              shard.rotation.y = a;
            });
          } else if (l.type === 'rift') {
            l.seam.material.opacity = 0.55 + Math.sin(t * 2.6 + phase) * 0.25;
            l.orbiters.forEach((chunk, i) => {
              const a = t * 0.5 + i * 1.25;
              chunk.position.set(Math.cos(a) * (3.4 + i * 0.4), 6 + Math.sin(a * 1.7 + i) * 3.2, Math.sin(a) * 3.6);
              chunk.rotation.y = a;
            });
          } else if (l.type === 'turbine') {
            l.rotor.rotation.z = t * 0.62;
          } else if (l.type === 'mirror') {
            l.shard.rotation.y = t * 0.8;
            l.shard.rotation.x = t * 0.35;
            l.panels.forEach((panel, i) => {
              panel.rotation.y = (i - 1) * 0.22 + Math.sin(t * 0.4 + i) * 0.04;
            });
          } else if (l.type === 'meteor') {
            l.core.rotation.y = t * 0.18;
            l.orbiters.forEach((rock, i) => {
              const a = t * 0.38 + i * 0.79;
              const r = 4.4 + (i % 3) * 0.7;
              rock.position.set(Math.cos(a) * r, 8.4 + Math.sin(a * 1.6 + i) * 3.2, Math.sin(a) * r);
              rock.rotation.x = a;
              rock.rotation.y = a * 1.3;
            });
          } else if (l.type === 'pendulum') {
            l.pivot.rotation.x = Math.sin(t * 0.52) * 0.2;
            l.ring.rotation.z = t * 0.25;
            l.ring2.rotation.z = -t * 0.32;
          }
        });
      }

      if (this.warningMaterial) {
        this.warningMaterial.opacity = 0.54 + Math.sin(t * 3.5) * 0.25;
      }
      if (this.checkpointVisuals) {
        this.checkpointMat.opacity = 0.38 + Math.sin(t * 2.4) * 0.16;
      }
      if (this.finishHalo) {
        this.finishHalo.material.opacity = 0.13 + Math.sin(t * 1.8) * 0.05;
        this.finishHalo.scale.setScalar(1 + Math.sin(t * 1.5) * 0.02);
      }
      if (this.gateGroups) {
        this.gateGroups.forEach((g) => {
          g.ring.rotation.z = t * 0.05 + g.phase;
          g.ring2.rotation.z = -t * 0.03 + g.phase;
        });
      }
      if (this.dust) this.dust.rotation.y = t * 0.008;
      if (this.starField) this.starField.rotation.y = t * 0.0025;
      if (this.nebulaGroup) {
        this.nebulaGroup.children.forEach((sprite, i) => {
          sprite.material.opacity = (i === 5 ? 0.07 : 0.09) + Math.sin(t * 0.2 + i) * 0.018;
        });
      }

      this.syncCrystals(t);
    }

    /* -------------------------------------------------------
       Main loop
       ------------------------------------------------------- */
    update(dt) {
      this.visualTime += dt;
      this.updateWorldVisuals(dt);

      if (this.state === 'menu') {
        this.applyZone(0, false);
        this.updatePlayerVisuals(dt);
      } else if (this.state === 'prestart') {
        this.prestartTimer -= dt;
        this.updatePlayerVisuals(dt);
        if (this.prestartTimer <= 0) this.beginCountdown();
      } else if (this.state === 'countdown') {
        this.countdownTimer -= dt;
        const n = Math.ceil(this.countdownTimer);
        if (n > 0 && n !== this.lastCountdownNum) {
          this.lastCountdownNum = n;
          this.setCountdownNumber(n);
          this.audio.countdown(false);
        }
        if (this.countdownTimer <= 0) {
          this.state = 'playing';
          this.dom.countdownNum.textContent = 'GO';
          this.dom.countdownNum.classList.remove('tick');
          this.dom.countdownNum.classList.add('go');
          this.dom.countdownLabel.textContent = '穿越开始';
          this.audio.countdown(true);
          this.audio.startMusic(true);
          this.goTimer = 0.55;
          this.elapsed = 0;
          this.showZoneBanner(this.zoneIndex < 0 ? 0 : this.zoneIndex);
        }
        this.updatePlayerVisuals(dt);
      } else if (this.state === 'playing') {
        if (this.goTimer > 0) {
          this.goTimer -= dt;
          if (this.goTimer <= 0) this.dom.countdown.classList.add('hidden');
        }
        if (this.hintTimer > 0) {
          this.hintTimer -= dt;
          if (this.hintTimer <= 0) this.dom.controlHint.style.opacity = '0';
        }
        const steps = Math.max(1, Math.ceil(dt / 0.012));
        const stepDt = dt / steps;
        for (let i = 0; i < steps && this.state === 'playing'; i++) {
          this.updatePhysics(stepDt);
        }
        this.updatePlayerVisuals(dt);
        this.hudTimer -= dt;
        if (this.hudTimer <= 0) {
          this.hudTimer = 0.06;
          this.updateHUD(false);
        }
      } else if (this.state === 'won') {
        const p = this.player;
        this.speed = damp(this.speed, 0, 3.2, dt);
        p.z = Math.max(-FINISH - 1.2, p.z - this.speed * dt);
        this.maxDistance = Math.max(this.maxDistance, -p.z);
        this.camOffsetZ = damp(this.camOffsetZ, 18.5, 1.8, dt);
        this.camHeight = damp(this.camHeight, 8.6, 1.8, dt);
        this.lookAhead = damp(this.lookAhead, 11.0, 1.8, dt);
        this.updatePlayerVisuals(dt);
        if (this.resultTimer > 0) {
          this.resultTimer -= dt;
          if (this.resultTimer <= 0) this.showResult();
        }
      } else if (this.state === 'over') {
        this.updatePlayerVisuals(dt);
        if (this.resultTimer > 0) {
          this.resultTimer -= dt;
          if (this.resultTimer <= 0) this.showResult();
        }
      } else if (this.state === 'paused') {
        // Keep the scene alive under the blur.
      }

      this.updateTheme(dt);
      this.updateTrail(dt);
      this.updateEffects(dt);
      this.updateCamera(dt);
    }

    animate() {
      requestAnimationFrame(this.animate);
      const dt = Math.min(0.05, Math.max(0.001, this.clock.getDelta()));
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  function boot() {
    try {
      new NeonSkyway();
    } catch (err) {
      console.error(err);
      const error = document.getElementById('webgl-error');
      if (error) {
        error.classList.remove('hidden');
        const p = error.querySelector('p');
        if (p) p.textContent = '初始化失败：' + (err && err.message ? err.message : '未知错误');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

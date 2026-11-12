(() => {
  const socket = window.AmongmatesNet.createNet();
  const MAP = window.AmongmatesMap;
  const ENGINE = window.AmongmatesEngine;
  const { TICK_RATE, KILL_RANGE, USE_RANGE, REPORT_RANGE, VENT_RANGE, REAL_IMPOSTER_FROM, MAX_PLAYERS } = ENGINE;
  const DEBUG = /[?&]debug\b/.test(location.search);

  const VIEW_W = 1032;
  const VIEW_H = 645;
  const ZOOM = 1.1;
  const VISION = { crew: 270, imposter: 380, dark: 110 };
  const FONT = "'Just Another Hand', 'Comic Sans MS', cursive";
  const STATION_BY_ID = new Map(MAP.STATIONS.map((s) => [s.id, s]));
  const ROOM_BY_ID = new Map(MAP.ROOMS.map((r) => [r.id, r]));

  const $ = (id) => document.getElementById(id);
  const canvas = $('game-canvas');
  const ctx = canvas.getContext('2d');
  const send = (msg) => socket.emit('input', msg);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const state = {
    playerId: null,
    hostId: null,
    linkRoom: false, // entered via a link like /amongmates/mate: no room code UI
    lobbyPlayers: [],
    playing: false,
    roster: [],
    you: null, // { n, role, alive, tasks, killCooldown, sabotageCooldown, emergencyLeft }
    snaps: [], // recent { t, seats } for smooth movement
    latest: null, // the last state from the host
    phase: null,
    phaseAt: 0,
    keys: { up: false, down: false, left: false, right: false, run: false },
    joy: null,
    sentMove: '',
    showMap: false,
    mini: null,
    pick: null,
    vision: VISION.crew,
    dpr: 1,
    lastReactorSec: null,
    actionsKey: '',
    actions: null,
    votesShown: false,
  };

  // ---------- Sound (synthesized with Web Audio) ----------

  let audioCtx = null;
  let master = null;
  let sfxOn = (() => { try { return localStorage.getItem('amongmates-sfx') !== 'off'; } catch { return true; } })();

  let reverb = null; // a long, dark space echo that every sound sends a little of itself into

  function getAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      master = audioCtx.createGain();
      master.gain.value = 0.5;
      master.connect(audioCtx.destination);
      // Reverb from a generated impulse: 3.5 seconds of softly decaying stereo noise.
      const len = Math.floor(audioCtx.sampleRate * 3.5);
      const ir = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      }
      const conv = audioCtx.createConvolver();
      conv.buffer = ir;
      const tone = audioCtx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 3200;
      reverb = audioCtx.createGain();
      reverb.gain.value = 0.9;
      reverb.connect(conv).connect(tone).connect(master);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // Sends a sound to the speakers plus some of it into the reverb.
  function out(node, wet) {
    node.connect(master);
    if (wet > 0) {
      const send = audioCtx.createGain();
      send.gain.value = wet;
      node.connect(send).connect(reverb);
    }
  }

  // A soft tone: smooth attack and release, optionally gliding, slightly detuned for width.
  function tone(freq, { at = 0, dur = 0.4, type = 'sine', vol = 0.2, to = null, attack = 0.02, wet = 0.35, detune = 0, lp = 0 } = {}) {
    const ac = getAudio();
    if (!ac) return;
    const t0 = ac.currentTime + at;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let last = g;
    if (lp) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      g.connect(f);
      last = f;
    }
    out(last, wet);
    (detune ? [-detune, detune] : [0]).forEach((cents) => {
      const o = ac.createOscillator();
      o.type = type;
      o.detune.value = cents;
      o.frequency.setValueAtTime(freq, t0);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    });
  }

  let noiseBuf = null;
  // Filtered noise: air, wind and whooshes.
  function noise({ at = 0, dur = 0.3, vol = 0.2, freq = 1000, to = null, q = 1, attack = 0.02, wet = 0.4, type = 'bandpass' } = {}) {
    const ac = getAudio();
    if (!ac) return;
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t0 = ac.currentTime + at;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g);
    out(g, wet);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // A glassy chime: a sine with a faint, higher partial.
  function chime(freq, at = 0, vol = 0.12, dur = 1.6) {
    tone(freq, { at, dur, vol, attack: 0.005, wet: 0.6 });
    tone(freq * 2.76, { at, dur: dur * 0.4, vol: vol * 0.25, attack: 0.005, wet: 0.6 });
  }

  // A slow, wide pad chord.
  function pad(freqs, { at = 0, dur = 3, vol = 0.07, attack = 0.8, type = 'triangle', lp = 1800 } = {}) {
    freqs.forEach((f) => tone(f, { at, dur, vol, attack, type, detune: 7, lp, wet: 0.7 }));
  }

  const SOUNDS = {
    // Launch: a deep swell and rush of air opening into a wide, shimmering chord.
    start() {
      tone(41, { dur: 3.2, vol: 0.28, attack: 1.2, to: 55, wet: 0.3 });
      noise({ dur: 2.6, vol: 0.12, freq: 200, to: 3500, q: 0.6, attack: 1.4, wet: 0.6 });
      pad([110, 164.8, 220, 246.9, 329.6], { at: 0.9, dur: 4.2, vol: 0.06, attack: 1.1 });
      [659.3, 987.8, 1318.5].forEach((f, i) => chime(f, 1.3 + i * 0.28, 0.06, 2.4));
    },
    // A dull, heavy hit with a dark whoosh.
    kill() {
      tone(110, { dur: 0.7, vol: 0.4, attack: 0.005, to: 35, wet: 0.5 });
      noise({ dur: 0.6, vol: 0.25, freq: 2400, to: 180, q: 0.7, attack: 0.005, wet: 0.5 });
      tone(233, { dur: 1.6, vol: 0.05, attack: 0.3, detune: 18, wet: 0.8 });
    },
    // Emergency meeting: a slow rising siren, twice.
    meeting() {
      [0, 0.9].forEach((t) => {
        tone(392, { at: t, dur: 0.85, vol: 0.13, attack: 0.15, to: 784, detune: 6, wet: 0.6 });
      });
      tone(98, { dur: 2, vol: 0.18, attack: 0.3, wet: 0.5 });
    },
    // Body reported: an uneasy, dissonant swell.
    body() {
      tone(65, { dur: 2.6, vol: 0.24, attack: 0.05, to: 52, wet: 0.5 });
      pad([311.1, 329.6, 466.2], { dur: 2.4, vol: 0.06, attack: 0.25, type: 'sine' });
      noise({ dur: 1.8, vol: 0.1, freq: 600, to: 120, q: 2, attack: 0.05, wet: 0.7 });
    },
    // Task complete: three glassy chimes, rising.
    task() {
      [784, 1174.7, 1568].forEach((f, i) => chime(f, i * 0.11, 0.1));
    },
    vote() { chime(1318.5, 0, 0.06, 0.8); },
    click() { tone(1046.5, { dur: 0.12, vol: 0.05, attack: 0.004, wet: 0.3 }); },
    wrong() { tone(220, { dur: 0.45, vol: 0.12, attack: 0.01, to: 160, wet: 0.4 }); },
    // Sabotage: a pulsing, low warning tone with a sweep of static.
    alarm() {
      [0, 0.6, 1.2].forEach((t) => tone(220, { at: t, dur: 0.5, vol: 0.12, attack: 0.08, to: 207.7, detune: 10, lp: 1200, wet: 0.6 }));
      noise({ dur: 1.8, vol: 0.06, freq: 1800, to: 400, q: 4, attack: 0.3, wet: 0.7 });
    },
    // Reactor countdown: a sonar ping each second.
    beep() { tone(1480, { dur: 0.6, vol: 0.05, attack: 0.004, wet: 0.7 }); },
    fixed() {
      tone(523.3, { dur: 1.2, vol: 0.1, attack: 0.05, wet: 0.6 });
      tone(784, { at: 0.15, dur: 1.6, vol: 0.1, attack: 0.05, wet: 0.6 });
      chime(1568, 0.3, 0.05);
    },
    vent() {
      noise({ dur: 0.45, vol: 0.22, freq: 180, to: 900, q: 1.5, attack: 0.02, wet: 0.4 });
      tone(70, { dur: 0.35, vol: 0.18, attack: 0.005, to: 45, wet: 0.3 });
    },
    // Ejected into space: a long rush of wind and a fading low drone.
    eject() {
      noise({ dur: 3, vol: 0.16, freq: 300, to: 2400, q: 0.7, attack: 0.4, wet: 0.7 });
      tone(55, { dur: 3.5, vol: 0.15, attack: 0.6, to: 41, wet: 0.6 });
    },
    win() {
      pad([130.8, 196, 261.6, 329.6, 392], { dur: 4, vol: 0.06, attack: 0.5 });
      [523.3, 659.3, 784, 1046.5].forEach((f, i) => chime(f, 0.2 + i * 0.18, 0.08, 2.4));
    },
    lose() {
      pad([110, 130.8, 164.8], { dur: 4, vol: 0.07, attack: 0.6, lp: 900 });
      tone(55, { dur: 4, vol: 0.18, attack: 0.5, to: 41, wet: 0.6 });
      [440, 392, 329.6].forEach((f, i) => chime(f, 0.4 + i * 0.4, 0.05, 2));
    },
  };

  function play(key) {
    if (!sfxOn || !SOUNDS[key]) return;
    try { SOUNDS[key](); } catch { /* audio unavailable */ }
  }

  function applySoundPref() {
    $('sfx-toggle').setAttribute('aria-pressed', String(sfxOn));
  }
  $('sfx-toggle').addEventListener('click', () => {
    sfxOn = !sfxOn;
    try { localStorage.setItem('amongmates-sfx', sfxOn ? 'on' : 'off'); } catch { /* private mode */ }
    applySoundPref();
    $('sfx-toggle').blur();
  });
  applySoundPref();
  // Browsers only start audio after a click or key press.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (sfxOn) getAudio(); }, { once: true }));

  // ---------- Background music ----------
  // Plays quietly on loop through each round (same volume as Candymates). At the end of the track
  // it crossfades into the start again (two copies overlap for a moment), so the loop is seamless.
  const music = (() => {
    const VOLUME = 0.2;
    const FADE = 2.5; // seconds of crossfade at the loop point (and fade in/out at start/stop)
    const SRC = 'assets/sounds/mrwashingt0n-deep-work.mp3';
    const tracks = [new Audio(SRC), new Audio(SRC)];
    tracks.forEach((t) => { t.preload = 'auto'; t.volume = 0; });
    let startedAt = 0; // performance.now() when the music started, or 0 when stopped
    let fadeOutFrom = 0;
    let timer = null;

    const playTrack = (t) => { if (t.paused) t.play().catch(() => {}); };
    const seek = (t, at) => { if (Math.abs(t.currentTime - at) > 0.3) t.currentTime = at; };

    function update() {
      if (fadeOutFrom) {
        const k = 1 - (performance.now() - fadeOutFrom) / (FADE * 1000);
        tracks.forEach((t) => { t.volume = Math.max(0, t.volume * Math.max(0, k)); });
        if (k <= 0) halt();
        return;
      }
      if (!startedAt) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      const duration = tracks[0].duration;
      if (!(duration > FADE * 2)) {
        // Length not known yet: just start playing; the loop maths takes over once it's loaded.
        playTrack(tracks[0]);
        tracks[0].volume = VOLUME * Math.min(1, elapsed / FADE);
        return;
      }
      const period = duration - FADE; // each loop starts as the previous one begins to fade
      const loop = Math.floor(elapsed / period);
      const at = elapsed - loop * period;
      const cur = tracks[loop % 2];
      const prev = tracks[(loop + 1) % 2];
      playTrack(cur);
      seek(cur, at);
      cur.volume = VOLUME * Math.min(1, at / FADE);
      if (loop > 0 && at < FADE) {
        playTrack(prev);
        seek(prev, at + period);
        prev.volume = VOLUME * (1 - at / FADE);
      } else if (!prev.paused) {
        prev.pause();
      }
    }

    function halt() {
      clearInterval(timer);
      timer = null;
      startedAt = 0;
      fadeOutFrom = 0;
      tracks.forEach((t) => { t.pause(); t.volume = 0; });
    }

    // If autoplay was blocked, the next click or key press starts it.
    ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (startedAt) update(); }));

    return {
      start() {
        if (startedAt && !fadeOutFrom) return;
        halt();
        startedAt = performance.now();
        timer = setInterval(update, 100);
        update();
      },
      fadeOut() {
        if (startedAt && !fadeOutFrom) fadeOutFrom = performance.now();
      },
      stop: halt,
      setMuted(m) {
        tracks.forEach((t) => { t.muted = m; });
      },
    };
  })();

  let musicOn = (() => { try { return localStorage.getItem('amongmates-music') !== 'off'; } catch { return true; } })();
  function applyMusicPref() {
    music.setMuted(!musicOn);
    $('music-toggle').setAttribute('aria-pressed', String(musicOn));
  }
  $('music-toggle').addEventListener('click', () => {
    musicOn = !musicOn;
    try { localStorage.setItem('amongmates-music', musicOn ? 'on' : 'off'); } catch { /* private mode */ }
    applyMusicPref();
    $('music-toggle').blur();
  });
  applyMusicPref();

  // ---------- Drawing helpers ----------

  function rr(c, x, y, w, h, r) {
    const [a, b, d, e] = Array.isArray(r) ? r : [r, r, r, r];
    c.beginPath();
    c.moveTo(x + a, y);
    c.lineTo(x + w - b, y);
    c.quadraticCurveTo(x + w, y, x + w, y + b);
    c.lineTo(x + w, y + h - d);
    c.quadraticCurveTo(x + w, y + h, x + w - d, y + h);
    c.lineTo(x + e, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - e);
    c.lineTo(x, y + a);
    c.quadraticCurveTo(x, y, x + a, y);
    c.closePath();
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const t = f < 0 ? 0 : 255;
    const p = Math.abs(f);
    const mix = (v) => Math.round(v + (t - v) * p);
    return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }

  // An original bean-shaped crewmate. (x, y) is between its feet.
  function drawCrewmate(c, x, y, color, o = {}) {
    const s = o.scale || 1;
    const f = o.facing < 0 ? -1 : 1;
    const t = o.t || 0;
    const dark = shade(color, -0.4);
    c.save();
    c.translate(x, y);
    if (o.ghost) {
      c.globalAlpha *= 0.5;
      c.translate(0, Math.sin(t / 300) * 3 * s - 6 * s);
    }
    c.scale(s * f, s);
    c.lineWidth = 3;
    c.strokeStyle = '#000';
    c.lineJoin = 'round';
    if (!o.ghost && !o.noShadow) {
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.beginPath();
      c.ellipse(0, 0, 16, 5, 0, 0, Math.PI * 2);
      c.fill();
    }
    const step = o.moving ? Math.sin(t / 65) : 0;
    // Backpack
    rr(c, -21, -34, 10, 19, 4);
    c.fillStyle = dark;
    c.fill();
    c.stroke();
    if (!o.ghost) {
      rr(c, -12 + step * 3, -14 - Math.max(0, step) * 2, 11, 14, [3, 3, 5, 5]);
      c.fillStyle = dark;
      c.fill();
      c.stroke();
      rr(c, 2 - step * 3, -14 - Math.max(0, -step) * 2, 11, 14, [3, 3, 5, 5]);
      c.fillStyle = color;
      c.fill();
      c.stroke();
    }
    c.translate(0, o.moving ? -Math.abs(step) * 1.5 : 0);
    if (o.ghost) {
      c.beginPath();
      c.moveTo(-14, -30);
      c.quadraticCurveTo(-14, -45, 0.5, -45);
      c.quadraticCurveTo(15, -45, 15, -30);
      c.lineTo(15, -8);
      c.lineTo(10, -2);
      c.lineTo(5, -9);
      c.lineTo(0, -2);
      c.lineTo(-5, -9);
      c.lineTo(-9, -2);
      c.lineTo(-14, -8);
      c.closePath();
    } else {
      rr(c, -14, -45, 29, 36, [14, 14, 7, 7]);
    }
    c.fillStyle = color;
    c.fill();
    c.save();
    c.clip();
    c.fillStyle = dark;
    c.fillRect(-16, -48, 7, 48);
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.fillRect(9, -40, 3, 6);
    c.restore();
    c.stroke();
    // Visor
    c.beginPath();
    c.ellipse(6, -31, 10, 6.5, 0, 0, Math.PI * 2);
    c.fillStyle = '#8fd3ea';
    c.fill();
    c.stroke();
    c.beginPath();
    c.ellipse(9, -33, 4, 2, 0, 0, Math.PI * 2);
    c.fillStyle = '#eafcff';
    c.fill();
    c.restore();
  }

  // What's left after The Imposter strikes: legs, half a body and a bone.
  function drawBody(c, x, y, color, s = 1) {
    const dark = shade(color, -0.4);
    c.save();
    c.translate(x, y);
    c.scale(s, s);
    c.lineWidth = 3;
    c.strokeStyle = '#000';
    c.lineJoin = 'round';
    c.fillStyle = 'rgba(0,0,0,0.28)';
    c.beginPath();
    c.ellipse(0, 0, 16, 5, 0, 0, Math.PI * 2);
    c.fill();
    rr(c, -12, -14, 11, 14, [3, 3, 5, 5]);
    c.fillStyle = dark;
    c.fill();
    c.stroke();
    rr(c, 2, -14, 11, 14, [3, 3, 5, 5]);
    c.fillStyle = color;
    c.fill();
    c.stroke();
    // Bone
    c.fillStyle = '#f3efe2';
    rr(c, -2, -33, 6, 16, 2);
    c.fill();
    c.stroke();
    c.beginPath();
    c.arc(-1.5, -34, 4, 0, Math.PI * 2);
    c.arc(4.5, -34, 4, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    // Lower half of the body, with a jagged top
    c.beginPath();
    c.moveTo(-14, -22);
    [-9, -4, 1, 6, 11].forEach((px, i) => c.lineTo(px, i % 2 ? -24 : -19));
    c.lineTo(15, -22);
    c.lineTo(15, -14);
    c.quadraticCurveTo(15, -8, 9, -8);
    c.lineTo(-8, -8);
    c.quadraticCurveTo(-14, -8, -14, -14);
    c.closePath();
    c.fillStyle = color;
    c.fill();
    c.stroke();
    c.restore();
  }

  function nameTag(c, text, x, y, color = '#fff', size = 22) {
    c.font = `${size}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.lineWidth = 4;
    c.lineJoin = 'round';
    c.strokeStyle = '#000';
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  // Starry background behind the page.
  function drawStars() {
    const cv = $('stars');
    const w = window.innerWidth;
    const h = window.innerHeight;
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d');
    c.fillStyle = '#070a17';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < (w * h) / 2500; i++) {
      c.fillStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.7})`;
      const r = Math.random() < 0.08 ? 1.6 : 0.8;
      c.beginPath();
      c.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
      c.fill();
    }
  }
  drawStars();
  window.addEventListener('resize', drawStars);

  // ---------- The ship (drawn once into an offscreen layer) ----------

  const TASK_COLOURS = { wires: '#ffcf3f', swipe: '#3fd0f0', download: '#3fdc7a', shields: '#ff6fd0', hold: '#ff9f3f' };
  let shipLayer = null;

  function buildShip() {
    const W = MAP.WIDTH;
    const H = MAP.HEIGHT;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#03050d';
    c.fillRect(0, 0, W, H);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 900; i++) {
      c.fillStyle = `rgba(255,255,255,${0.15 + rnd() * 0.6})`;
      c.fillRect(rnd() * W, rnd() * H, rnd() < 0.1 ? 2.5 : 1.5, rnd() < 0.1 ? 2.5 : 1.5);
    }
    const box = (a, g) => [a.x0 - g, a.y0 - g, a.x1 - a.x0 + 2 * g, a.y1 - a.y0 + 2 * g];
    const fillAll = (colour, g) => {
      c.fillStyle = colour;
      MAP.AREAS.forEach((a) => c.fillRect(...box(a, g)));
    };
    // Hull: black outline, grey metal, then a dark line where the wall meets the floor.
    fillAll('#000', 8);
    fillAll('#7d869c', 3);
    fillAll('#1a1d29', -MAP.WALL + 3);
    MAP.CORRIDORS.forEach((a) => {
      c.fillStyle = '#3b4256';
      c.fillRect(...box(a, -MAP.WALL));
    });
    MAP.ROOMS.forEach((r) => {
      const [x, y, w, h] = box(r, -MAP.WALL);
      c.fillStyle = r.floor;
      c.fillRect(x, y, w, h);
      c.save();
      c.beginPath();
      c.rect(x, y, w, h);
      c.clip();
      c.strokeStyle = 'rgba(0,0,0,0.13)';
      c.lineWidth = 2;
      for (let gx = x + 40; gx < x + w; gx += 40) { c.beginPath(); c.moveTo(gx, y); c.lineTo(gx, y + h); c.stroke(); }
      for (let gy = y + 40; gy < y + h; gy += 40) { c.beginPath(); c.moveTo(x, gy); c.lineTo(x + w, gy); c.stroke(); }
      // Back wall along the top, with openings where corridors come in.
      const band = { x0: x, y0: y, x1: x + w, y1: y + 26 };
      const g = c.createLinearGradient(0, band.y0, 0, band.y1);
      g.addColorStop(0, '#59617a');
      g.addColorStop(1, '#3d4458');
      c.fillStyle = g;
      c.fillRect(band.x0, band.y0, band.x1 - band.x0, band.y1 - band.y0);
      MAP.CORRIDORS.forEach((a) => {
        const ix0 = Math.max(band.x0, a.x0 + MAP.WALL);
        const ix1 = Math.min(band.x1, a.x1 - MAP.WALL);
        const iy0 = Math.max(band.y0, a.y0 + MAP.WALL);
        const iy1 = Math.min(band.y1, a.y1 - MAP.WALL);
        if (ix1 > ix0 && iy1 > iy0) {
          c.fillStyle = '#3b4256';
          c.fillRect(ix0, iy0, ix1 - ix0, iy1 - iy0);
        }
      });
      c.restore();
      c.font = `44px ${FONT}`;
      c.textAlign = 'center';
      c.fillStyle = 'rgba(255,255,255,0.3)';
      c.fillText(r.label, (r.x0 + r.x1) / 2, y + 70);
    });
    // Cafeteria table with the emergency button on it.
    const eb = MAP.EMERGENCY_BUTTON;
    c.lineWidth = 4;
    c.strokeStyle = '#000';
    c.fillStyle = '#9aa3b8';
    c.beginPath();
    c.arc(eb.x, eb.y, 62, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = '#b8c0d2';
    c.beginPath();
    c.arc(eb.x, eb.y, 48, 0, Math.PI * 2);
    c.fill();
    // Vents
    MAP.VENTS.forEach((v) => {
      rr(c, v.x - 20, v.y - 12, 40, 24, 4);
      c.fillStyle = '#5c6378';
      c.fill();
      c.lineWidth = 3;
      c.stroke();
      c.strokeStyle = '#2a2e3c';
      c.lineWidth = 2;
      for (let i = -12; i <= 12; i += 6) { c.beginPath(); c.moveTo(v.x + i, v.y - 8); c.lineTo(v.x + i, v.y + 8); c.stroke(); }
      c.strokeStyle = '#000';
    });
    // Task consoles
    MAP.STATIONS.forEach((st) => {
      rr(c, st.x - 19, st.y - 44, 38, 30, 5);
      c.fillStyle = '#2b3142';
      c.fill();
      c.lineWidth = 3;
      c.stroke();
      c.fillStyle = TASK_COLOURS[st.type];
      c.globalAlpha = 0.75;
      c.fillRect(st.x - 13, st.y - 38, 26, 14);
      c.globalAlpha = 1;
    });
    // Lights panel (Electrical) and the reactor's hand scanner.
    const lp = MAP.LIGHTS_PANEL;
    rr(c, lp.x - 20, lp.y - 48, 40, 34, 4);
    c.fillStyle = '#d9b43a';
    c.fill();
    c.stroke();
    c.fillStyle = '#000';
    c.beginPath();
    c.moveTo(lp.x + 3, lp.y - 44);
    c.lineTo(lp.x - 7, lp.y - 30);
    c.lineTo(lp.x, lp.y - 30);
    c.lineTo(lp.x - 4, lp.y - 18);
    c.lineTo(lp.x + 8, lp.y - 34);
    c.lineTo(lp.x + 1, lp.y - 34);
    c.closePath();
    c.fill();
    const rp = MAP.REACTOR_PANEL;
    rr(c, rp.x - 20, rp.y - 50, 40, 36, 5);
    c.fillStyle = '#3a4560';
    c.fill();
    c.stroke();
    c.fillStyle = '#3fd0f0';
    c.fillRect(rp.x - 12, rp.y - 44, 24, 24);
    shipLayer = cv;
  }

  // ---------- Lobby UI ----------

  function showError(msg) {
    $('error-msg').textContent = msg || '';
  }

  const PREVIEW_PLAYER = { id: 'preview', number: 1, name: '', color: ENGINE.COLORS[0].hex };

  function buildSlots() {
    $('slots').replaceChildren(...Array.from({ length: MAX_PLAYERS }, (_, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML = `<span class="slot-num">P${i + 1}</span><canvas width="128" height="144"></canvas>`
        + '<span class="slot-name"></span><span class="slot-tag"></span>';
      return slot;
    }));
  }

  function slotPlayers() {
    return state.playerId ? state.lobbyPlayers : [PREVIEW_PLAYER];
  }

  function renderSlots() {
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const p = players.find((pl) => pl.number === i + 1);
      const isYou = p && (p.id === state.playerId || p === PREVIEW_PLAYER);
      slot.classList.toggle('filled', !!p);
      slot.classList.toggle('you', !!isYou);
      slot.style.color = p ? p.color : '';
      slot.style.borderColor = p ? p.color : '';
      slot.querySelector('.slot-name').textContent = p ? (p.name || 'YOU') : 'EMPTY';
      let tag = '';
      if (p && p !== PREVIEW_PLAYER) tag = [isYou && '(YOU)', !state.linkRoom && p.id === state.hostId && 'HOST'].filter(Boolean).join(' ');
      slot.querySelector('.slot-tag').textContent = tag;
    });
  }

  function drawSlots(now) {
    if ($('lobby-card').style.display === 'none') return;
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const c = slot.querySelector('canvas').getContext('2d');
      c.setTransform(2, 0, 0, 2, 0, 0);
      c.clearRect(0, 0, 64, 72);
      const p = players.find((pl) => pl.number === i + 1);
      if (p) {
        drawCrewmate(c, 32, 66 + Math.sin(now / 400 + i) * 1.5, p.color, { scale: 1.3, facing: i % 2 ? -1 : 1 });
      } else {
        c.globalAlpha = 0.25;
        drawCrewmate(c, 32, 66, '#66708f', { scale: 1.3, noShadow: true });
        c.globalAlpha = 1;
      }
    });
  }

  function lobbyInfo(count) {
    const bots = `Empty seats are filled with crewmate bots.`;
    if (count < 2) return `${bots} You need at least 2 players to start.`;
    if (count < REAL_IMPOSTER_FROM) return `${bots} With fewer than ${REAL_IMPOSTER_FROM}, a bot is The Imposter.`;
    return `${bots} One of you is The Imposter...`;
  }

  function applyLobby(payload) {
    state.hostId = payload.hostId;
    state.lobbyPlayers = payload.players;
    $('setup-view').style.display = 'none';
    $('room-view').style.display = 'block';
    $('room-code-txt').textContent = payload.roomCode;
    $('lobby-card').classList.toggle('link-room', state.linkRoom);
    renderSlots();
    const count = payload.players.length;
    const canStart = count >= 2 || DEBUG;
    $('start-btn').disabled = !canStart;
    $('start-btn').textContent = canStart ? `Start game with ${count} player${count === 1 ? '' : 's'}` : 'Waiting for 1 more player...';
    $('start-btn').style.display = 'block';
    $('again-btn').disabled = !canStart;
    $('lobby-info').textContent = `${count}/${MAX_PLAYERS} players. ${lobbyInfo(count)}`;
    $('room-code-txt').classList.toggle('long', payload.roomCode.length > 6);
    $('share-link').value = shareLink(payload.roomCode);
    history.replaceState(null, '', `${basePath()}?room=${encodeURIComponent(payload.roomCode.toLowerCase())}${DEBUG ? '&debug' : ''}`);
  }

  function showLobby() {
    state.playing = false;
    music.stop();
    closeMini();
    $('game-view').style.display = 'none';
    $('game-over').hidden = true;
    $('lobby-card').style.display = 'block';
    document.body.classList.remove('in-game');
  }

  // Directory the game is served from, e.g. "/amongmates/" on GitHub Pages or "/" locally.
  function basePath() {
    return location.pathname.replace(/[^/]*$/, '');
  }

  function shareLink(roomCode) {
    return `${location.origin}${basePath()}${roomCode.toLowerCase()}`;
  }

  function resetToSetup() {
    history.replaceState(null, '', basePath() + (DEBUG ? '?debug' : ''));
    state.linkRoom = false;
    $('lobby-card').classList.remove('link-room');
    state.playerId = null;
    state.hostId = null;
    state.lobbyPlayers = [];
    renderSlots();
    $('room-view').style.display = 'none';
    $('setup-view').style.display = 'block';
    showLobby();
  }

  // While connecting, Create and Join stay usable: trying again (say, typing a code after a link room
  // gets stuck) replaces the attempt in progress.
  function setConnecting(connecting) {
    if (connecting) showError('');
    $('connecting-hint').textContent = 'Connecting...';
    $('connecting-hint').style.display = connecting ? 'block' : 'none';
  }

  function handleJoinResponse(res) {
    setConnecting(false);
    if (!res.ok) {
      if (state.linkRoom || $('room-view').style.display === 'block') resetToSetup();
      return showError(res.error);
    }
    showError('');
    state.playerId = res.playerId;
    applyLobby(res);
  }

  $('create-btn').addEventListener('click', () => {
    setConnecting(true);
    socket.emit('createRoom', handleJoinResponse);
  });
  $('join-btn').addEventListener('click', () => {
    const code = $('room-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter a 4-letter room code.');
    setConnecting(true);
    socket.emit('joinRoom', code, handleJoinResponse);
  });
  $('room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });
  const startOpts = () => (state.lobbyPlayers.length < 2 && DEBUG ? { solo: true } : {});
  $('start-btn').addEventListener('click', () => socket.emit('startGame', startOpts()));
  $('again-btn').addEventListener('click', () => socket.emit('startGame', startOpts()));
  $('leave-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });
  $('exit-btn').addEventListener('click', showLobby);
  // Link rooms: leave and go back to the home screen to create or join a different room.
  $('home-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });

  socket.on('lobbyUpdate', (payload) => applyLobby(payload));
  socket.on('disconnect', (reason) => {
    resetToSetup();
    showError(reason || 'Disconnected.');
  });
  socket.on('status', (text) => {
    if ($('connecting-hint').style.display === 'block') $('connecting-hint').textContent = text;
    if ($('reconnect-hint').style.display === 'block') $('reconnect-hint').textContent = text;
  });
  socket.on('reconnecting', (message) => {
    showLobby();
    $('start-btn').style.display = 'none';
    showError('');
    $('reconnect-hint').textContent = message;
    $('reconnect-hint').style.display = 'block';
  });
  socket.on('rejoined', (res) => {
    $('reconnect-hint').style.display = 'none';
    handleJoinResponse(res);
  });

  $('copy-btn').addEventListener('click', async () => {
    const input = $('share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('copy-btn').textContent = 'Copied!';
    setTimeout(() => { $('copy-btn').textContent = 'Copy'; }, 1500);
  });


  // Apps that embed the game pass their own session id as ?group=<id> (any length or characters), so each
  // group gets its own link room instead of everyone sharing /mate. The id is hashed into a 4-letter code
  // like any other room (same letters, no I or O), so it can also be typed in to join.
  const GROUP_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  function groupRoom(id) {
    if (!id) return null;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < id.length; i++) {
      const ch = id.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    let hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += GROUP_LETTERS[hash % GROUP_LETTERS.length];
      hash = Math.floor(hash / GROUP_LETTERS.length);
    }
    return code;
  }
  // Links like /amongmates/mate (or ?room=mate) open that room: join it if someone is hosting, otherwise host it.
  function enterRoomFromUrl() {
    const params = new URLSearchParams(location.search);
    const requested = params.get('room') || groupRoom(params.get('group'));
    if (!requested) return;
    if (!window.AmongmatesNet.normaliseRoomName(requested)) {
      history.replaceState(null, '', basePath());
      return showError('Room names are 2-16 letters, numbers or dashes.');
    }
    state.linkRoom = true;
    $('lobby-card').classList.add('link-room');
    setConnecting(true);
    socket.emit('enterRoom', requested, handleJoinResponse);
  }

  // ---------- Game state ----------

  const myN = () => (state.you ? state.you.n : -1);
  const meAlive = () => !state.you || state.you.alive;
  const myRole = () => (state.you ? state.you.role : 'crew');
  const nameOf = (n) => (state.roster[n] ? state.roster[n].name : '???');
  const colourOf = (n) => (state.roster[n] ? state.roster[n].color : '#888');

  function sizeCanvas() {
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(VIEW_W * state.dpr);
    canvas.height = Math.round(VIEW_H * state.dpr);
  }

  function enterGame(payload) {
    state.playing = true;
    state.roster = payload.roster;
    state.snaps = [];
    state.latest = null;
    state.phase = null;
    state.pick = null;
    setMap(false);
    state.sentMove = '';
    state.lastReactorSec = null;
    closeMini();
    $('lobby-card').style.display = 'none';
    $('game-view').style.display = 'block';
    $('game-over').hidden = true;
    $('splash').hidden = true;
    document.body.classList.add('in-game');
    sizeCanvas();
    if (!shipLayer) buildShip();
    applyState(payload);
  }

  function pushSnap(d) {
    state.latest = d;
    state.snaps.push({ t: performance.now(), seats: d.seats });
    if (state.snaps.length > 5) state.snaps.shift();
  }

  // Where seat n is at render time rt, smoothed between the host's updates.
  function seatAt(n, rt) {
    const s = state.snaps;
    if (!s.length) return null;
    let i = s.length - 1;
    while (i > 0 && s[i].t > rt) i--;
    const a = s[i];
    const b = s[i + 1];
    const pa = a.seats[n];
    if (!b || !pa) return pa || (b && b.seats[n]) || null;
    const pb = b.seats[n];
    if (!pb) return pa;
    const k = Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t)));
    // Vents and meetings teleport people: don't slide them across the ship.
    if (Math.abs(pb.x - pa.x) + Math.abs(pb.y - pa.y) > 120) return k < 0.5 ? pa : pb;
    return { ...pb, x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k };
  }

  function applyState(d) {
    pushSnap(d);
    handleEvents(d.events || []);
    setPhase(d.phase);
    updateHud(d);
    if (['discuss', 'vote', 'result'].includes(d.phase)) updateMeeting(d);
  }

  socket.on('gameStarted', (payload) => {
    enterGame(payload);
    music.start();
    if (payload.phase === 'intro') play('start');
  });
  socket.on('state', (d) => {
    if (state.playing) applyState(d);
  });
  socket.on('you', (data) => {
    const wasAlive = meAlive();
    state.you = data;
    updateTasks();
    updateGameHint();
    if (state.phase === 'intro') renderIntro();
    if (wasAlive && !data.alive) closeMini();
  });
  socket.on('gameOver', (d) => {
    if (!state.playing) return;
    handleEvents(d.events || []);
    state.roster = d.roster;
    showGameOver(d);
  });

  function setPhase(p) {
    if (p === state.phase) return;
    state.phase = p;
    state.phaseAt = performance.now();
    // Your task list and buttons only show while you're out on the ship.
    $('stage').classList.toggle('off-ship', p !== 'play');
    $('intro').hidden = p !== 'intro';
    $('meeting').hidden = !['discuss', 'vote', 'result'].includes(p);
    $('ejection').hidden = p !== 'ejection';
    $('sab-menu').hidden = true;
    if (p !== 'play') {
      closeMini();
      setMap(false);
    }
    if (p === 'intro') renderIntro();
    if (p === 'discuss') buildMeeting();
    if (p === 'ejection') {
      state.ejectText = '';
      play('eject');
    }
    // The host stops everyone at meetings; send fresh input when play resumes.
    state.sentMove = '';
    sendMove();
  }

  function handleEvents(events) {
    const me = myN();
    events.forEach((e) => {
      switch (e.type) {
        case 'kill':
          if (e.victim === me) {
            showSplash('You were killed!', e.killer, myRole() === 'crew' ? 'Keep doing your tasks as a ghost.' : '');
            play('kill');
          } else if (e.killer === me || canSee(e)) {
            play('kill');
          }
          break;
        case 'meeting':
          showSplash(e.reason === 'body' ? 'Dead body reported!' : 'Emergency meeting!', e.caller,
            e.reason === 'body' ? `${nameOf(e.caller)} found ${nameOf(e.body)}` : `Called by ${nameOf(e.caller)}`);
          play(e.reason === 'body' ? 'body' : 'meeting');
          break;
        case 'taskDone':
          if (e.n === me) play('task');
          break;
        case 'sabotage':
          play('alarm');
          break;
        case 'fixed':
          play('fixed');
          break;
        case 'vent': {
          const p = state.latest && state.latest.seats[e.n];
          if (e.n === me || (p && canSee(p))) play('vent');
          break;
        }
        case 'voted':
          play('vote');
          break;
        default:
      }
    });
  }

  // Is this point inside your circle of vision right now?
  function canSee(p) {
    const me = state.latest && state.latest.seats[myN()];
    if (!me || !meAlive()) return true;
    return dist(p, me) < state.vision + 20;
  }

  let splashTimer = null;
  function showSplash(title, n, sub, ms = 2300) {
    $('splash-title').textContent = title;
    $('splash-sub').textContent = sub || '';
    const c = $('splash-canvas').getContext('2d');
    c.clearRect(0, 0, 320, 240);
    if (n !== undefined && n !== null && state.roster[n]) drawCrewmate(c, 160, 225, colourOf(n), { scale: 4 });
    $('splash').hidden = false;
    clearTimeout(splashTimer);
    splashTimer = setTimeout(() => { $('splash').hidden = true; }, ms);
  }

  function renderIntro() {
    if (!state.you) return;
    const imp = myRole() === 'imposter';
    $('intro-sub').textContent = imp ? 'Shhh! You are' : 'You are a';
    $('intro-title').textContent = imp ? 'Imposter' : 'Crewmate';
    $('intro-title').style.color = imp ? '#ff4d63' : '#3fd0f0';
    const botImp = state.lobbyPlayers.length < REAL_IMPOSTER_FROM;
    $('intro-note').textContent = imp
      ? 'Kill the crew, sabotage the ship and don\'t get caught.'
      : `There is 1 Imposter among us.${botImp ? ' (It\'s one of the bots.)' : ''}`;
    const c = $('intro-canvas').getContext('2d');
    c.clearRect(0, 0, 440, 300);
    const g = c.createRadialGradient(220, 200, 10, 220, 200, 220);
    g.addColorStop(0, imp ? 'rgba(255,40,70,0.45)' : 'rgba(60,200,240,0.4)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 440, 300);
    drawCrewmate(c, 220, 290, colourOf(myN()), { scale: 5.4 });
  }

  // ---------- Input ----------

  const KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ShiftLeft: 'run', ShiftRight: 'run',
  };

  function sendMove() {
    if (!state.playing) return;
    const blocked = !!state.mini || state.phase !== 'play';
    const j = state.joy || {};
    const k = state.keys;
    const m = {
      up: !blocked && (k.up || !!j.up),
      down: !blocked && (k.down || !!j.down),
      left: !blocked && (k.left || !!j.left),
      right: !blocked && (k.right || !!j.right),
      run: !blocked && k.run,
    };
    const key = `${+m.up}${+m.down}${+m.left}${+m.right}${+m.run}`;
    if (key === state.sentMove) return;
    state.sentMove = key;
    send({ type: 'move', ...m });
  }

  function releaseKeys() {
    state.keys = { up: false, down: false, left: false, right: false, run: false };
    state.joy = null;
    sendMove();
  }

  window.addEventListener('keydown', (e) => {
    if (!state.playing || e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') {
      if (state.mini) closeMini();
      setMap(false);
      $('sab-menu').hidden = true;
      return;
    }
    const dir = KEYMAP[e.code];
    if (dir) {
      e.preventDefault();
      if (!state.keys[dir]) {
        state.keys[dir] = true;
        sendMove();
      }
      return;
    }
    if (e.repeat || state.phase !== 'play') return;
    if (e.code === 'KeyE' || e.code === 'Space') { e.preventDefault(); doUse(); }
    else if (e.code === 'KeyR') doReport();
    else if (e.code === 'KeyQ') doKill();
    else if (e.code === 'KeyV') doVent();
    else if (e.code === 'KeyF') toggleSabMenu();
    else if (e.code === 'KeyM' || e.code === 'Tab') { e.preventDefault(); toggleMap(); }
  });
  window.addEventListener('keyup', (e) => {
    const dir = KEYMAP[e.code];
    if (dir && state.keys[dir]) {
      state.keys[dir] = false;
      sendMove();
    }
  });
  window.addEventListener('blur', releaseKeys);

  // Touch: drag anywhere on the ship to walk that way.
  let joyStart = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    joyStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!joyStart || e.pointerId !== joyStart.id) return;
    const dx = e.clientX - joyStart.x;
    const dy = e.clientY - joyStart.y;
    const len = Math.hypot(dx, dy);
    state.joy = len < 14 ? null : { up: dy / len < -0.38, down: dy / len > 0.38, left: dx / len < -0.38, right: dx / len > 0.38 };
    sendMove();
  });
  const endJoy = () => {
    joyStart = null;
    state.joy = null;
    sendMove();
  };
  canvas.addEventListener('pointerup', endJoy);
  canvas.addEventListener('pointercancel', endJoy);

  function setMap(on) {
    state.showMap = on;
    $('map-btn').setAttribute('aria-pressed', String(on));
    $('stage').classList.toggle('map-open', on);
  }
  const toggleMap = () => setMap(!state.showMap);
  $('map-btn').addEventListener('click', () => {
    toggleMap();
    $('map-btn').blur();
  });
  $('leave-game-btn').addEventListener('click', () => {
    if (!window.confirm('Leave this game? A bot takes over your crewmate.')) return;
    socket.emit('leaveRoom');
    resetToSetup();
  });

  // ---------- Actions ----------

  // What you can do right now, from the host's latest positions (the host checks the same ranges).
  function computeActions() {
    const d = state.latest;
    const y = state.you;
    if (!d || !y || d.phase !== 'play' || state.mini) return { use: null, report: false, kill: false, vent: false, sab: false };
    const me = d.seats[y.n];
    const alive = y.alive;
    const imp = y.role === 'imposter';
    let use = null;
    if (!imp) {
      const task = y.tasks.find((t) => !t.done && dist(me, STATION_BY_ID.get(t.station)) <= USE_RANGE);
      if (task) use = { kind: 'task', station: task.station };
    }
    if (!use && alive && d.sabotage && d.sabotage.kind === 'lights' && dist(me, MAP.LIGHTS_PANEL) <= USE_RANGE + 20) use = { kind: 'lights' };
    if (!use && alive && dist(me, MAP.EMERGENCY_BUTTON) <= USE_RANGE + 20 && y.emergencyLeft > 0 && d.buttonCooldown <= 0
      && !(d.sabotage && d.sabotage.kind === 'reactor')) use = { kind: 'emergency' };
    const report = alive && d.bodies.some((b) => dist(me, b) <= REPORT_RANGE);
    const killable = imp && alive && d.seats.some((s) => s.n !== y.n && s.a && dist(me, s) <= KILL_RANGE);
    const vent = imp && alive && MAP.VENTS.some((v) => dist(me, v) <= VENT_RANGE);
    const sab = imp && alive && !d.sabotage && y.sabotageCooldown <= 0;
    return { use, report, kill: killable && y.killCooldown <= 0, killable, vent, sab };
  }

  function updateActions() {
    const a = computeActions();
    state.actions = a;
    const y = state.you || {};
    const imp = y.role === 'imposter';
    const alive = y.alive !== false;
    const key = JSON.stringify([a, imp, alive, y.killCooldown, y.sabotageCooldown]);
    if (key === state.actionsKey) return;
    state.actionsKey = key;
    $('act-use').disabled = !a.use;
    $('act-use').firstChild.textContent = a.use && a.use.kind === 'emergency' ? 'Meeting' : a.use && a.use.kind === 'lights' ? 'Fix' : 'Use';
    $('act-report').hidden = !alive;
    $('act-report').disabled = !a.report;
    $('act-kill').hidden = !imp || !alive;
    $('act-kill').disabled = !a.kill;
    const kcd = $('act-kill').querySelector('.cd');
    kcd.hidden = !(y.killCooldown > 0);
    kcd.textContent = y.killCooldown || '';
    $('act-vent').hidden = !imp || !alive;
    $('act-vent').disabled = !a.vent;
    $('sab-wrap').hidden = !imp || !alive;
    $('act-sab').disabled = !a.sab;
    const scd = $('act-sab').querySelector('.cd');
    scd.hidden = !(y.sabotageCooldown > 0) || !!(state.latest && state.latest.sabotage);
    scd.textContent = y.sabotageCooldown || '';
    if (!a.sab) $('sab-menu').hidden = true;
  }

  function doUse() {
    const a = state.actions;
    if (!a || !a.use) return;
    if (a.use.kind === 'task') openMini(a.use.station);
    else if (a.use.kind === 'lights') openMini('lights');
    else if (a.use.kind === 'emergency') send({ type: 'use', what: 'emergency' });
  }
  const doReport = () => { if (state.actions && state.actions.report) send({ type: 'report' }); };
  const doKill = () => { if (state.actions && state.actions.kill) send({ type: 'kill' }); };
  const doVent = () => { if (state.actions && state.actions.vent) send({ type: 'vent' }); };
  function toggleSabMenu() {
    if (!state.actions || !state.actions.sab) return;
    $('sab-menu').hidden = !$('sab-menu').hidden;
  }
  function sabotage(kind) {
    $('sab-menu').hidden = true;
    if (state.actions && state.actions.sab) send({ type: 'sabotage', kind });
  }
  $('act-use').addEventListener('click', doUse);
  $('act-report').addEventListener('click', doReport);
  $('act-kill').addEventListener('click', doKill);
  $('act-vent').addEventListener('click', doVent);
  $('act-sab').addEventListener('click', toggleSabMenu);
  $('sab-lights').addEventListener('click', () => sabotage('lights'));
  $('sab-reactor').addEventListener('click', () => sabotage('reactor'));

  // ---------- HUD ----------

  function updateHud(d) {
    $('taskbar-fill').style.width = `${Math.round(d.taskBar * 100)}%`;
    const sab = d.phase === 'play' && d.sabotage;
    $('banner').hidden = !sab;
    if (sab) {
      if (sab.kind === 'lights') {
        $('banner').textContent = 'Lights sabotaged! Fix them in Electrical.';
      } else {
        const secs = Math.ceil(sab.ticksLeft / TICK_RATE);
        $('banner').textContent = sab.fix > 0 ? `Reactor meltdown in ${secs}s! Hold on, fixing...` : `Reactor meltdown in ${secs}s! Stand at the panel in Reactor.`;
        if (secs !== state.lastReactorSec) play('beep');
        state.lastReactorSec = secs;
      }
    }
  }

  function updateTasks() {
    const y = state.you;
    if (!y) return;
    const items = [];
    const head = (text) => {
      const li = document.createElement('li');
      li.className = 'head';
      li.textContent = text;
      return li;
    };
    if (y.role === 'imposter') items.push(head(y.alive ? 'Sabotage and kill everyone. Fake tasks:' : 'You were caught.'));
    else if (!y.alive) items.push(head('You\'re a ghost. Finish your tasks!'));
    y.tasks.forEach((t) => {
      const st = STATION_BY_ID.get(t.station);
      const li = document.createElement('li');
      li.textContent = `${ROOM_BY_ID.get(st.room).label}: ${st.label}`;
      if (t.done && y.role === 'crew') li.className = 'done';
      items.push(li);
    });
    $('task-list').replaceChildren(...items);
  }

  function updateGameHint() {
    const y = state.you;
    if (!y) return;
    $('game-hint').textContent = y.role === 'imposter'
      ? 'You\'re The Imposter: kill (Q), vent (V) and sabotage (F) without getting caught. Fake tasks at the consoles. Map: M.'
      : 'Do tasks at the yellow consoles (E), report bodies (R) and call meetings at the red button. Discuss on your voice call, then vote. Map: M.';
  }

  // ---------- Rendering the ship ----------

  const fog = document.createElement('canvas');

  function drawWorld(now) {
    const d = state.latest;
    const dpr = state.dpr;
    const rt = now - (1000 / TICK_RATE) * 1.4;
    const n0 = myN();
    const me = seatAt(n0, rt) || MAP.EMERGENCY_BUTTON;
    const alive = meAlive();
    const imp = myRole() === 'imposter';
    const target = !alive ? 4000 : imp ? VISION.imposter : (d.sabotage && d.sabotage.kind === 'lights' ? VISION.dark : VISION.crew);
    if (target > 1000 || state.vision > 1000) state.vision = target;
    else state.vision += (target - state.vision) * 0.06;
    const seen = (p) => !alive || dist(p, me) < state.vision + 20;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#02030a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.save();
    ctx.translate(VIEW_W / 2, VIEW_H / 2);
    ctx.scale(ZOOM, ZOOM);
    ctx.translate(-Math.round(me.x * 4) / 4, -Math.round(me.y * 4) / 4);
    ctx.drawImage(shipLayer, 0, 0);

    // Your task consoles glow yellow; sabotage panels flash red.
    const pulse = 0.55 + 0.45 * Math.sin(now / 250);
    if (state.you && !imp) {
      state.you.tasks.forEach((t) => {
        if (t.done) return;
        const st = STATION_BY_ID.get(t.station);
        ctx.lineWidth = 4;
        ctx.strokeStyle = `rgba(255,214,63,${dist(me, st) <= USE_RANGE ? 1 : pulse * 0.8})`;
        rr(ctx, st.x - 23, st.y - 48, 46, 38, 8);
        ctx.stroke();
      });
    }
    if (d.sabotage) {
      const p = d.sabotage.kind === 'lights' ? MAP.LIGHTS_PANEL : MAP.REACTOR_PANEL;
      ctx.lineWidth = 5;
      ctx.strokeStyle = `rgba(255,60,80,${pulse})`;
      rr(ctx, p.x - 26, p.y - 56, 52, 48, 8);
      ctx.stroke();
    }
    // Emergency button
    const eb = MAP.EMERGENCY_BUTTON;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#7c0d1c';
    ctx.beginPath();
    ctx.ellipse(eb.x, eb.y + 4, 22, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = d.buttonCooldown > 0 ? '#a0303f' : `rgb(${200 + 55 * pulse},40,60)`;
    ctx.beginPath();
    ctx.ellipse(eb.x, eb.y - 2, 17, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    d.bodies.forEach((b) => { if (seen(b)) drawBody(ctx, b.x, b.y, colourOf(b.n)); });
    const people = [];
    for (let n = 0; n < d.seats.length; n++) {
      const p = seatAt(n, rt);
      if (!p) continue;
      // Ghosts are only visible to other ghosts.
      if (!p.a && alive) continue;
      if (n === n0 || seen(p)) people.push({ n, p });
    }
    people.sort((a, b) => a.p.y - b.p.y);
    people.forEach(({ n, p }) => drawCrewmate(ctx, p.x, p.y, colourOf(n), { facing: p.f, moving: p.m, t: now + n * 97, ghost: !p.a }));
    people.forEach(({ n, p }) => {
      const colour = n === n0 && imp ? '#ff4d63' : '#fff';
      ctx.globalAlpha = p.a ? 1 : 0.6;
      nameTag(ctx, nameOf(n), p.x, p.y - (p.a ? 52 : 58), colour);
      ctx.globalAlpha = 1;
    });
    ctx.restore();

    // Darkness beyond your circle of vision.
    if (alive) {
      if (fog.width !== canvas.width || fog.height !== canvas.height) {
        fog.width = canvas.width;
        fog.height = canvas.height;
      }
      const f = fog.getContext('2d');
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const r = state.vision * ZOOM * dpr;
      f.globalCompositeOperation = 'source-over';
      f.clearRect(0, 0, fog.width, fog.height);
      f.fillStyle = 'rgba(2,4,14,0.86)';
      f.fillRect(0, 0, fog.width, fog.height);
      f.globalCompositeOperation = 'destination-out';
      const g = f.createRadialGradient(cx, cy, r * 0.72, cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      f.fillStyle = g;
      f.beginPath();
      f.arc(cx, cy, r, 0, Math.PI * 2);
      f.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(fog, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (d.sabotage && d.sabotage.kind === 'reactor') {
      ctx.fillStyle = `rgba(255,0,30,${0.08 + 0.08 * Math.sin(now / 160)})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    // Arrows at the screen edge pointing to your tasks and any sabotage.
    if (d.phase === 'play') {
      if (state.you && !imp) {
        state.you.tasks.forEach((t) => { if (!t.done) edgeArrow(STATION_BY_ID.get(t.station), me, '#ffd23f'); });
      }
      if (d.sabotage) edgeArrow(d.sabotage.kind === 'lights' ? MAP.LIGHTS_PANEL : MAP.REACTOR_PANEL, me, '#ff4d63');
    }
    if (state.showMap) drawMap(me);

    const room = MAP.roomAt(me.x, me.y);
    if ($('room-name').textContent !== room) $('room-name').textContent = room;
  }

  function edgeArrow(p, me, colour) {
    const sx = (p.x - me.x) * ZOOM;
    const sy = (p.y - me.y) * ZOOM;
    const hw = VIEW_W / 2 - 34;
    const hh = VIEW_H / 2 - 34;
    if (Math.abs(sx) < hw + 20 && Math.abs(sy) < hh + 20) return;
    const k = Math.min(hw / Math.abs(sx || 1e-6), hh / Math.abs(sy || 1e-6));
    const x = VIEW_W / 2 + sx * k;
    const y = VIEW_H / 2 + sy * k;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(sy, sx));
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -10);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawMap(me) {
    const s = 0.38;
    const ox = (VIEW_W - MAP.WIDTH * s) / 2;
    const oy = (VIEW_H - MAP.HEIGHT * s) / 2 + 12;
    ctx.fillStyle = 'rgba(0,10,40,0.78)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    ctx.fillStyle = '#6aa5e0';
    MAP.AREAS.forEach((a) => ctx.fillRect(a.x0 - 8, a.y0 - 8, a.x1 - a.x0 + 16, a.y1 - a.y0 + 16));
    ctx.fillStyle = '#1b3d6e';
    MAP.AREAS.forEach((a) => ctx.fillRect(a.x0 + 6, a.y0 + 6, a.x1 - a.x0 - 12, a.y1 - a.y0 - 12));
    ctx.font = `64px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    MAP.ROOMS.forEach((r) => ctx.fillText(r.label, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 + 20));
    const imp = myRole() === 'imposter';
    if (state.you && !imp) {
      state.you.tasks.forEach((t) => {
        if (t.done) return;
        const st = STATION_BY_ID.get(t.station);
        ctx.fillStyle = '#ffd23f';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(st.x, st.y - 20, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
    if (imp) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      MAP.VENTS.forEach((v) => ctx.fillRect(v.x - 16, v.y - 10, 32, 20));
    }
    const d = state.latest;
    if (d.sabotage) {
      const p = d.sabotage.kind === 'lights' ? MAP.LIGHTS_PANEL : MAP.REACTOR_PANEL;
      ctx.fillStyle = '#ff4d63';
      ctx.beginPath();
      ctx.arc(p.x, p.y - 20, 34, 0, Math.PI * 2);
      ctx.fill();
    }
    drawCrewmate(ctx, me.x, me.y, colourOf(myN()), { scale: 2.4, noShadow: true });
    ctx.restore();
    nameTag(ctx, 'Map (M to close)', VIEW_W / 2, 40, '#fff', 30);
  }

  // ---------- Meetings (talk on your own voice call, vote here) ----------

  function buildMeeting() {
    state.pick = null;
    state.votesShown = false;
    $('skip-votes').replaceChildren();
    const d = state.latest;
    $('tiles').replaceChildren(...state.roster.map((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.dataset.n = r.n;
      b.innerHTML = '<canvas width="68" height="76"></canvas><span class="t-name"></span><span class="votes"></span><span class="badge" hidden>VOTED</span>';
      b.querySelector('.t-name').textContent = r.n === myN() ? `${r.name} (you)` : r.name;
      const c = b.querySelector('canvas').getContext('2d');
      c.setTransform(2, 0, 0, 2, 0, 0);
      const alive = d && d.seats[r.n] && d.seats[r.n].a;
      if (alive) drawCrewmate(c, 16, 37, r.color, { scale: 0.75, noShadow: true });
      else drawBody(c, 16, 37, r.color, 0.75);
      b.addEventListener('click', () => pickTile(r.n));
      return b;
    }));
  }

  function canVote() {
    const d = state.latest;
    return d && d.phase === 'vote' && meAlive() && d.meeting && !d.meeting.voted.includes(myN());
  }

  function pickTile(n) {
    const d = state.latest;
    if (!canVote() || !d.seats[n].a) return;
    state.pick = state.pick === n ? null : n;
    play('click');
    updateMeeting(d);
  }

  $('confirm-vote').addEventListener('click', () => {
    if (canVote() && state.pick !== null) send({ type: 'vote', target: state.pick });
  });
  $('skip-btn').addEventListener('click', () => {
    if (canVote()) send({ type: 'vote', target: 'skip' });
  });

  function updateMeeting(d) {
    const m = d.meeting;
    if (!m) return;
    const secs = Math.max(0, Math.ceil(d.phaseTicks / TICK_RATE));
    $('meeting-timer').textContent = d.phase === 'discuss' ? `Voting opens in ${secs}s` : d.phase === 'vote' ? `Voting ends in ${secs}s` : 'Votes are in!';
    const what = m.reason === 'body' ? `${nameOf(m.caller)} reported ${nameOf(m.body)}'s body.` : `${nameOf(m.caller)} called an emergency meeting.`;
    let todo = '';
    if (!meAlive()) todo = 'You\'re dead: listen in, but no voting.';
    else if (d.phase === 'discuss') todo = 'Discuss on your voice call.';
    else if (d.phase === 'vote') todo = m.voted.includes(myN()) ? 'You voted. Waiting for everyone else...' : 'Tap who you think The Imposter is, or skip.';
    $('meeting-sub').textContent = `${what} ${todo}`;
    const voting = canVote();
    [...$('tiles').children].forEach((tile) => {
      const n = Number(tile.dataset.n);
      const alive = d.seats[n] && d.seats[n].a;
      tile.classList.toggle('dead', !alive);
      tile.classList.toggle('me', n === myN());
      tile.classList.toggle('caller', n === m.caller);
      tile.classList.toggle('picked', voting && state.pick === n);
      tile.disabled = !voting || !alive;
      tile.querySelector('.badge').hidden = d.phase === 'result' || !m.voted.includes(n);
    });
    $('confirm-vote').hidden = !voting || state.pick === null;
    if (voting && state.pick !== null) $('confirm-vote').textContent = `Vote ${nameOf(state.pick)}`;
    $('skip-btn').disabled = !voting;
    // Results: who voted for whom.
    if (d.phase === 'result' && m.votes && !state.votesShown) {
      state.votesShown = true;
      const dot = (voter) => {
        const s = document.createElement('span');
        s.className = 'vote-dot';
        s.style.background = colourOf(Number(voter));
        s.title = nameOf(Number(voter));
        return s;
      };
      Object.entries(m.votes).forEach(([voter, target]) => {
        if (target === 'skip') $('skip-votes').append(dot(voter));
        else {
          const tile = $('tiles').querySelector(`[data-n="${target}"] .votes`);
          if (tile) tile.append(dot(voter));
        }
      });
      if ($('skip-votes').children.length) {
        const label = document.createElement('span');
        label.className = 'skip-label';
        label.textContent = 'Skipped:';
        $('skip-votes').prepend(label);
      }
    }
  }

  // ---------- Ejection ----------

  const ejectStars = Array.from({ length: 140 }, () => ({ x: Math.random() * VIEW_W, y: Math.random() * VIEW_H, v: 0.5 + Math.random() * 3, r: Math.random() < 0.15 ? 2 : 1 }));

  function ejectText() {
    const e = state.latest && state.latest.ejection;
    if (!e) return '';
    if (e.n === null) return e.tie ? 'No one was ejected. (Tie)' : 'No one was ejected. (Skipped)';
    return e.wasImposter ? `${nameOf(e.n)} was The Imposter.` : `${nameOf(e.n)} was not The Imposter.`;
  }

  function drawEjection(now) {
    const cv = $('eject-canvas');
    const c = cv.getContext('2d');
    const t = (now - state.phaseAt) / 1000;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, VIEW_W, VIEW_H);
    c.fillStyle = '#fff';
    ejectStars.forEach((s) => {
      const x = (((s.x - t * s.v * 60) % VIEW_W) + VIEW_W) % VIEW_W;
      c.fillRect(x, s.y, s.r * 2, s.r);
    });
    const e = state.latest && state.latest.ejection;
    if (e && e.n !== null) {
      c.save();
      c.translate(-80 + t * 270, VIEW_H / 2 - 40);
      c.rotate(t * 2.2);
      drawCrewmate(c, 0, 50, colourOf(e.n), { scale: 2.2, noShadow: true });
      c.restore();
    }
    const full = ejectText();
    const shown = full.slice(0, Math.max(0, Math.floor((t - 0.6) * 24)));
    if ($('eject-text').textContent !== shown) $('eject-text').textContent = shown;
  }

  // ---------- Game over ----------

  function showGameOver(d) {
    state.phase = 'over';
    closeMini();
    setMap(false);
    ['intro', 'meeting', 'ejection', 'banner', 'splash'].forEach((id) => { $(id).hidden = true; });
    const crewWin = d.winner === 'crew';
    const imp = nameOf(d.imposter);
    const reasons = {
      ejected: `${imp} (The Imposter) was voted off the ship.`,
      tasks: `The crew finished every task. ${imp} was The Imposter.`,
      kills: `${imp} (The Imposter) took out the crew.`,
      reactor: `The reactor melted down. ${imp} was The Imposter.`,
    };
    const iWon = state.you && (state.you.role === 'imposter') !== crewWin;
    $('game-over-title').textContent = crewWin ? 'Crewmates win!' : 'Imposter wins!';
    $('game-over-title').style.color = crewWin ? '#3fd0f0' : '#ff4d63';
    $('game-over-sub').textContent = `${iWon ? 'You win! ' : 'You lose. '}${reasons[d.reason] || ''}`;
    $('standings').replaceChildren(...d.roster.map((r) => {
      const li = document.createElement('li');
      li.className = `player-item${r.role === 'imposter' ? ' imp' : ''}${r.alive ? '' : ' out'}`;
      li.style.background = `${r.color}33`;
      li.style.borderLeftColor = r.color;
      const name = document.createElement('span');
      name.textContent = r.n === myN() ? `${r.name} (you)` : r.name;
      const right = document.createElement('span');
      right.textContent = `${r.role === 'imposter' ? 'Imposter' : ''}${r.alive ? '' : ' ☠'}`;
      li.append(name, right);
      return li;
    }));
    $('game-over').hidden = false;
    music.fadeOut();
    play(iWon ? 'win' : 'lose');
    sendMove();
  }

  // ---------- Task mini-games ----------

  const mc = $('mini-canvas');
  const mctx = mc.getContext('2d');
  const MW = 480;
  const MH = 340;
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const setMiniMsg = (text) => { $('mini-msg').textContent = text; };

  function panelText(c, text, x, y, size = 26, colour = '#fff') {
    c.font = `${size}px ${FONT}`;
    c.textAlign = 'center';
    c.fillStyle = colour;
    c.fillText(text, x, y);
  }

  const MINIS = {
    wires() {
      const cols = ['#ff3b3b', '#3b7bff', '#ffd23f', '#ff4fd8'];
      const right = shuffle([0, 1, 2, 3]);
      const done = [false, false, false, false];
      let drag = null;
      const L = (i) => ({ x: 50, y: 60 + i * 72 });
      const R = (i) => ({ x: 430, y: 60 + right.indexOf(i) * 72 });
      const wire = (c, a, b, colour) => {
        c.lineCap = 'round';
        c.strokeStyle = '#000';
        c.lineWidth = 16;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        c.strokeStyle = colour;
        c.lineWidth = 10;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      };
      return {
        hint: 'Drag each wire to the same colour.',
        draw(c) {
          c.fillStyle = '#2a2f3f';
          c.fillRect(0, 0, MW, MH);
          for (let i = 0; i < 4; i++) {
            if (done[i]) wire(c, L(i), R(i), cols[i]);
            [L(i), R(i)].forEach((p, k) => {
              c.fillStyle = cols[i];
              c.strokeStyle = '#000';
              c.lineWidth = 3;
              c.fillRect(k ? p.x - 4 : p.x - 34, p.y - 12, 38, 24);
              c.strokeRect(k ? p.x - 4 : p.x - 34, p.y - 12, 38, 24);
            });
          }
          if (drag) wire(c, L(drag.i), drag.p, cols[drag.i]);
        },
        down(p) {
          for (let i = 0; i < 4; i++) if (!done[i] && dist(p, L(i)) < 34) drag = { i, p };
        },
        move(p) { if (drag) drag.p = p; },
        up(p) {
          if (!drag) return;
          const { i } = drag;
          drag = null;
          if (dist(p, R(i)) < 36) {
            done[i] = true;
            play('click');
            if (done.every(Boolean)) miniDone();
          }
        },
      };
    },

    swipe() {
      let x = 30;
      let drag = null;
      let ok = false;
      return {
        hint: 'Swipe the card through the reader. Not too fast, not too slow.',
        draw(c) {
          c.fillStyle = '#2a2f3f';
          c.fillRect(0, 0, MW, MH);
          c.fillStyle = '#11141e';
          c.fillRect(20, 110, 440, 100);
          c.fillStyle = ok ? '#3fdc7a' : '#ff4d63';
          c.beginPath();
          c.arc(440, 80, 10, 0, Math.PI * 2);
          c.fill();
          rr(c, x, 120, 110, 70, 8);
          c.fillStyle = '#e8ecf5';
          c.fill();
          c.strokeStyle = '#000';
          c.lineWidth = 3;
          c.stroke();
          c.fillStyle = '#3fd0f0';
          c.fillRect(x + 10, 132, 30, 36);
          panelText(c, 'ID', x + 75, 165, 30, '#2a2f3f');
        },
        down(p) {
          if (!ok && p.x >= x && p.x <= x + 110 && p.y >= 110 && p.y <= 200) drag = { dx: p.x - x, t: 0 };
        },
        move(p) {
          if (!drag) return;
          x = Math.max(30, Math.min(350, p.x - drag.dx));
          if (!drag.t && x > 50) drag.t = performance.now();
        },
        up() {
          if (!drag) return;
          const secs = drag.t ? (performance.now() - drag.t) / 1000 : 0;
          drag = null;
          let msg = '';
          if (x < 340) msg = 'Bad read. Try again.';
          else if (secs < 0.45) msg = 'Too fast. Try again.';
          else if (secs > 1.8) msg = 'Too slow. Try again.';
          if (msg) {
            setMiniMsg(msg);
            play('wrong');
            x = 30;
            return;
          }
          ok = true;
          miniDone();
        },
      };
    },

    download(st) {
      const up = /upload/i.test(st.label);
      let start = 0;
      const DUR = 4500;
      return {
        hint: up ? 'Press Upload and wait for it to finish.' : 'Press Download and wait for it to finish.',
        draw(c, now) {
          c.fillStyle = '#2a2f3f';
          c.fillRect(0, 0, MW, MH);
          [[80, 'Ship'], [400, up ? 'HQ' : 'Tablet']].forEach(([fx, label]) => {
            c.fillStyle = '#ffcf3f';
            c.strokeStyle = '#000';
            c.lineWidth = 3;
            c.fillRect(fx - 40, 70, 80, 60);
            c.strokeRect(fx - 40, 70, 80, 60);
            panelText(c, label, fx, 160, 24);
          });
          const k = start ? Math.min(1, (now - start) / DUR) : 0;
          c.fillStyle = '#11141e';
          c.fillRect(60, 200, 360, 22);
          c.fillStyle = '#3fdc7a';
          c.fillRect(60, 200, 360 * k, 22);
          if (start && k < 1) {
            for (let i = 0; i < 3; i++) {
              const f = ((now - start) / 900 + i / 3) % 1;
              c.fillStyle = '#fff';
              c.fillRect(110 + f * 250, 90 - Math.sin(f * Math.PI) * 40, 16, 20);
            }
          }
          if (!start) {
            rr(c, 175, 250, 130, 50, 10);
            c.fillStyle = '#3fd0f0';
            c.fill();
            c.stroke();
            panelText(c, up ? 'Upload' : 'Download', 240, 284, 30, '#06121a');
          } else {
            panelText(c, k < 1 ? `${Math.round(k * 100)}%` : 'Complete', 240, 284, 30);
          }
          if (k >= 1) miniDone();
        },
        down(p) {
          if (!start && p.x >= 175 && p.x <= 305 && p.y >= 250 && p.y <= 300) {
            start = performance.now();
            play('click');
          }
        },
      };
    },

    shields(st) {
      if (st.id === 'weaponsAsteroids') return MINIS.asteroids();
      const cells = [{ x: 240, y: 170 }, ...Array.from({ length: 6 }, (_, i) => ({ x: 240 + Math.cos((i * Math.PI) / 3) * 80, y: 170 + Math.sin((i * Math.PI) / 3) * 80 }))];
      const red = cells.map(() => Math.random() < 0.5);
      if (!red.some(Boolean)) red[1] = true;
      const hex = (c, x, y, r) => {
        c.beginPath();
        for (let i = 0; i < 6; i++) c.lineTo(x + Math.cos((i * Math.PI) / 3 + Math.PI / 6) * r, y + Math.sin((i * Math.PI) / 3 + Math.PI / 6) * r);
        c.closePath();
      };
      return {
        hint: 'Tap the red panels to prime the shields.',
        draw(c) {
          c.fillStyle = '#2a2f3f';
          c.fillRect(0, 0, MW, MH);
          cells.forEach((p, i) => {
            hex(c, p.x, p.y, 42);
            c.fillStyle = red[i] ? '#ff4d63' : '#eef3ff';
            c.fill();
            c.strokeStyle = '#000';
            c.lineWidth = 3;
            c.stroke();
          });
        },
        down(p) {
          const i = cells.findIndex((cell) => dist(p, cell) < 40);
          if (i < 0) return;
          red[i] = !red[i];
          play('click');
          if (!red.some(Boolean)) miniDone();
        },
      };
    },

    asteroids() {
      const NEED = 8;
      let rocks = [];
      let hit = 0;
      let last = 0;
      let spawn = 0;
      return {
        hint: `Shoot ${NEED} asteroids.`,
        draw(c, now) {
          const dt = last ? Math.min(50, now - last) : 16;
          last = now;
          spawn -= dt;
          if (spawn <= 0) {
            spawn = 550;
            rocks.push({ x: MW + 30, y: 40 + Math.random() * (MH - 80), vx: -(0.08 + Math.random() * 0.1), r: 16 + Math.random() * 12, a: 0 });
          }
          rocks.forEach((r) => { r.x += r.vx * dt; r.a += dt / 400; });
          rocks = rocks.filter((r) => r.x > -40);
          c.fillStyle = '#05070f';
          c.fillRect(0, 0, MW, MH);
          rocks.forEach((r) => {
            c.save();
            c.translate(r.x, r.y);
            c.rotate(r.a);
            c.beginPath();
            for (let i = 0; i < 8; i++) {
              const rad = r.r * (i % 2 ? 0.8 : 1);
              c.lineTo(Math.cos((i * Math.PI) / 4) * rad, Math.sin((i * Math.PI) / 4) * rad);
            }
            c.closePath();
            c.fillStyle = '#8a7f72';
            c.fill();
            c.strokeStyle = '#000';
            c.lineWidth = 3;
            c.stroke();
            c.restore();
          });
          panelText(c, `Destroyed: ${hit}/${NEED}`, 240, 30, 26, '#3fdc7a');
        },
        down(p) {
          const i = rocks.findIndex((r) => dist(p, r) < r.r + 8);
          if (i < 0) return;
          rocks.splice(i, 1);
          hit++;
          play('click');
          if (hit >= NEED) miniDone();
        },
      };
    },

    hold(st) {
      const NEED = 3000;
      let pressed = false;
      let prog = 0;
      let last = 0;
      const words = { upperFuel: 'Fill', lowerFuel: 'Fill', o2Garbage: 'Pull', storageGarbage: 'Pull', medScan: 'Scan' };
      const word = words[st.id] || 'Hold';
      return {
        hint: `Hold the ${word} button until the bar is full.`,
        draw(c, now) {
          const dt = last ? Math.min(50, now - last) : 16;
          last = now;
          if (pressed) prog = Math.min(NEED, prog + dt);
          c.fillStyle = '#2a2f3f';
          c.fillRect(0, 0, MW, MH);
          c.fillStyle = '#11141e';
          c.fillRect(70, 40, 80, 260);
          c.fillStyle = word === 'Fill' ? '#ffcf3f' : word === 'Scan' ? '#3fd0f0' : '#3fdc7a';
          const h = 260 * (prog / NEED);
          c.fillRect(70, 300 - h, 80, h);
          c.strokeStyle = '#000';
          c.lineWidth = 3;
          c.strokeRect(70, 40, 80, 260);
          c.beginPath();
          c.arc(330, 170, 70, 0, Math.PI * 2);
          c.fillStyle = pressed ? '#a0182c' : '#ff4d63';
          c.fill();
          c.stroke();
          panelText(c, word, 330, 182, 40);
          if (prog >= NEED) miniDone();
        },
        down(p) { if (dist(p, { x: 330, y: 170 }) < 72) pressed = true; },
        up() { pressed = false; },
      };
    },

    lights() {
      const on = Array.from({ length: 5 }, () => Math.random() < 0.5);
      if (on.every(Boolean)) on[2] = false;
      return {
        hint: 'Flip every switch up to turn the lights back on.',
        draw(c) {
          c.fillStyle = '#2a2f3f';
          c.fillRect(0, 0, MW, MH);
          on.forEach((v, i) => {
            const x = 80 + i * 80;
            c.fillStyle = v ? '#3fdc7a' : '#3a2a2a';
            c.beginPath();
            c.arc(x, 70, 14, 0, Math.PI * 2);
            c.fill();
            c.strokeStyle = '#000';
            c.lineWidth = 3;
            c.stroke();
            c.fillStyle = '#11141e';
            c.fillRect(x - 18, 120, 36, 150);
            rr(c, x - 24, v ? 128 : 200, 48, 62, 6);
            c.fillStyle = '#d9dde8';
            c.fill();
            c.stroke();
          });
        },
        down(p) {
          const i = on.findIndex((_, k) => Math.abs(p.x - (80 + k * 80)) < 30 && p.y > 110 && p.y < 280);
          if (i < 0) return;
          on[i] = !on[i];
          play('click');
          if (on.every(Boolean)) miniDone();
        },
      };
    },
  };

  function openMini(id) {
    const st = id === 'lights' ? { id: 'lights', label: 'Fix Lights', type: 'lights' } : STATION_BY_ID.get(id);
    if (!st) return;
    const game = MINIS[st.type](st);
    state.mini = { st, game, doneAt: 0 };
    $('mini-title').textContent = st.room ? `${st.label} (${ROOM_BY_ID.get(st.room).label})` : st.label;
    setMiniMsg(game.hint || '');
    $('minigame').hidden = false;
    $('sab-menu').hidden = true;
    sendMove();
  }

  function closeMini() {
    if (!state.mini) return;
    state.mini = null;
    $('minigame').hidden = true;
    sendMove();
  }

  function miniDone() {
    const m = state.mini;
    if (!m || m.doneAt) return;
    m.doneAt = performance.now();
    if (m.st.id === 'lights') {
      setMiniMsg('Lights fixed!');
      send({ type: 'use', what: 'lights' });
    } else {
      setMiniMsg('Task complete!');
      send({ type: 'task', station: m.st.id });
    }
    setTimeout(() => { if (state.mini === m) closeMini(); }, 700);
  }

  const miniPoint = (e) => {
    const r = mc.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * MW) / r.width, y: ((e.clientY - r.top) * MH) / r.height };
  };
  mc.addEventListener('pointerdown', (e) => {
    const m = state.mini;
    if (!m || m.doneAt) return;
    mc.setPointerCapture(e.pointerId);
    if (m.game.down) m.game.down(miniPoint(e));
  });
  mc.addEventListener('pointermove', (e) => {
    const m = state.mini;
    if (m && !m.doneAt && m.game.move) m.game.move(miniPoint(e));
  });
  const miniUp = (e) => {
    const m = state.mini;
    if (m && !m.doneAt && m.game.up) m.game.up(miniPoint(e));
  };
  mc.addEventListener('pointerup', miniUp);
  mc.addEventListener('pointercancel', miniUp);
  $('mini-close').addEventListener('click', closeMini);

  // ---------- Main loop ----------

  function frame(now) {
    requestAnimationFrame(frame);
    drawSlots(now);
    if (!state.playing || !state.latest) return;
    if (state.mini) {
      mctx.setTransform(2, 0, 0, 2, 0, 0);
      state.mini.game.draw(mctx, now);
    }
    if (state.phase === 'ejection') drawEjection(now);
    updateActions();
    drawWorld(now);
  }

  buildSlots();
  renderSlots();
  requestAnimationFrame(frame);
  enterRoomFromUrl();
  // Redraw the ship's room labels once the handwriting font has loaded.
  if (document.fonts) document.fonts.load(`44px ${FONT}`).then(() => { shipLayer = null; if (state.playing) buildShip(); }).catch(() => {});

  // Debug aid: ?debug exposes the client state.
  if (DEBUG) window.__amongDebug = { state, send, socket, openMini, closeMini, showGameOver, play };
})();

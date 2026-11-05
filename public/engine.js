// Authoritative Among Mates game engine, following the rules of Among Us. Runs in the host's browser
// (window.AmongmatesEngine) and in Node for tests (require). It knows nothing about networking: the
// caller supplies broadcast(event, data) and send(playerId, event, data).
//
// 2-8 real players; NPC crewmates fill the ship up to 15. There's 1 Imposter: a random real player
// once there are 4 or more of them, otherwise an NPC. Real players can join mid-round (they take
// over an NPC's seat) and a player who leaves mid-round hands their seat back to an NPC.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./map.js'));
  else root.AmongmatesEngine = factory(root.AmongmatesMap);
})(typeof self !== 'undefined' ? self : this, (MAP) => {
  const TICK_RATE = 20;
  const sec = (s) => Math.round(s * TICK_RATE);
  const MAX_PLAYERS = 8;
  const MIN_PLAYERS = 2;
  const SEATS = 15;
  const REAL_IMPOSTER_FROM = 4; // with fewer real players, an NPC is the Imposter
  const TASKS_EACH = 5;
  const SPEED = 7.5; // walking, px per tick
  const RUN = 2; // holding Shift runs at double speed
  const GHOST_SPEED = 8.6;
  const NPC_VISION = 280; // how far a bot notices who's around
  const RADIUS = 12;
  const KILL_RANGE = 75;
  const REPORT_RANGE = 110;
  const USE_RANGE = 70;
  const VENT_RANGE = 55;
  const KILL_COOLDOWN = sec(22);
  const FIRST_KILL_COOLDOWN = sec(12);
  const SABOTAGE_COOLDOWN = sec(30);
  const BUTTON_COOLDOWN = sec(15);
  const REACTOR_TIME = sec(40);
  const REACTOR_FIX = sec(3);
  const INTRO = sec(4);
  const DISCUSS = sec(15);
  const VOTE = sec(30);
  const RESULT = sec(5);
  const EJECT = sec(5);
  const WITNESS_RANGE = 320;
  const NPC_SEE_BODY = 170;
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  const COLORS = [
    ['Mint', '#56c6a9'], ['Red', '#d8262b'], ['Blue', '#2747d6'], ['Green', '#1d8f3a'], ['Pink', '#ef5cbe'], ['Orange', '#f08a1c'],
    ['Yellow', '#f1e04c'], ['Black', '#3d4550'], ['White', '#d9e2ee'], ['Purple', '#7a3dc8'], ['Brown', '#7a5230'],
    ['Cyan', '#3ee0d0'], ['Lime', '#69e04a'], ['Maroon', '#7a2a3e'], ['Rose', '#f0bfd2'], ['Tan', '#c9b48a'],
  ].map(([label, hex]) => ({ label, hex }));
  const NAMES = [
    'NOVA', 'LUNA', 'VEGA', 'ZETA', 'MARS', 'ORION', 'COMET', 'ASTRO', 'PLUTO', 'TITAN', 'ATLAS', 'RIGEL',
    'ROVER', 'PROBE', 'ORBIT', 'QUARK', 'PIXEL', 'BLIP', 'ZORP', 'GIZMO', 'SPUD', 'MOCHI', 'BOBA', 'DUSTY',
    'ECHO', 'FIZZ', 'GLOW', 'HALO', 'IGGY', 'JUNO', 'KIWI', 'LUMO', 'MIRA', 'NEON', 'OPAL', 'PIPS', 'QUILL',
    'RUBY', 'TOFU', 'VOLT', 'WISP', 'YUKI', 'ZIGGY', 'BEAN', 'COSMO', 'DOT', 'FLUX', 'GUS',
  ].filter((n) => n.length >= 4 && n.length <= 5);

  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const within = (a, b, r) => dist2(a, b) <= r * r;

  function generateRoomCode(isTaken = () => false) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      if (!isTaken(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  const EMPTY_MOVE = { up: false, down: false, left: false, right: false };

  class GameRoom {
    /**
     * @param {string} code room code
     * @param {object} hooks broadcast(event, data), send(playerId, event, data), optional
     *   setInterval/clearInterval, random, and allowSolo (let 1 player start, for testing)
     */
    constructor(code, hooks) {
      this.code = code;
      this.broadcast = hooks.broadcast;
      this.send = hooks.send;
      this.setInterval = hooks.setInterval || ((fn, ms) => setInterval(fn, ms));
      this.clearInterval = hooks.clearInterval || ((id) => clearInterval(id));
      this.random = hooks.random || Math.random;
      this.allowSolo = !!hooks.allowSolo;
      this.hostId = null;
      this.players = new Map(); // real players: id -> { id, number, name, color }
      this.started = false;
      this.loop = null;
      this.seats = [];
      this.bodies = [];
      this.events = [];
      this.tick = 0;
    }

    get size() {
      return this.players.size;
    }

    rand(n) {
      return Math.floor(this.random() * n);
    }

    // ---------- Lobby ----------

    // Adds a player without messaging anyone; call announceJoin() after acknowledging the joiner.
    join(id, preferredName) {
      if (this.players.has(id)) return { ok: false, error: 'Already in this room.' };
      if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'This ship is full (max 8 players)!' };
      const taken = new Set([...this.players.values()].map((p) => p.number));
      let number = 1;
      while (taken.has(number)) number++;
      let name;
      let color;
      if (this.started) {
        // Mid-round: take over an NPC's seat (alive crew first), keeping its name and colour so the
        // round carries on seamlessly.
        const seat = this.pickSeatForJoiner();
        if (!seat) return { ok: false, error: 'This ship is full (max 8 players)!' };
        seat.kind = 'player';
        seat.playerId = id;
        seat.input = { ...EMPTY_MOVE };
        seat.npc = null;
        name = seat.name;
        color = seat.color;
      } else {
        const used = new Set([...this.players.values()].map((p) => p.name));
        const names = NAMES.filter((n) => !used.has(n));
        name = names.includes(preferredName) ? preferredName : names[this.rand(names.length)];
        const usedColors = new Set([...this.players.values()].map((p) => p.color));
        color = COLORS.find((c) => !usedColors.has(c.hex)).hex;
      }
      this.players.set(id, { id, number, name, color });
      if (!this.hostId) this.hostId = id;
      return { ok: true, payload: { playerId: id, ...this.lobbyPayload() } };
    }

    pickSeatForJoiner() {
      const npcs = this.seats.filter((s) => s.kind === 'npc');
      return npcs.find((s) => s.alive && s.role === 'crew')
        || npcs.find((s) => s.role === 'crew')
        || npcs.find((s) => s.alive)
        || npcs[0];
    }

    announceJoin(id) {
      this.broadcastLobby();
      if (this.started) {
        this.send(id, 'gameStarted', this.gamePayload());
        this.sendPrivate(this.seatOf(id));
      }
    }

    leave(id) {
      if (!this.players.delete(id)) return;
      if (this.started) {
        // Their seat carries on as an NPC (keeping its role), so the round isn't ruined.
        const seat = this.seatOf(id);
        if (seat) {
          seat.kind = 'npc';
          seat.playerId = null;
          seat.input = { ...EMPTY_MOVE };
          seat.npc = this.newNpcState();
          if (this.meeting && this.meeting.votes[seat.n] === undefined && seat.alive) this.npcPlanVote(seat);
        }
      }
      if (this.players.size === 0) {
        this.stopLoop();
        this.started = false;
        return;
      }
      if (this.hostId === id) this.hostId = this.players.keys().next().value;
      this.broadcastLobby();
    }

    // ---------- Starting a round ----------

    start(requesterId, options = {}) {
      if (this.started || !this.players.has(requesterId)) return false;
      const solo = options && options.solo && this.allowSolo;
      if (this.players.size < MIN_PLAYERS && !solo) return false;
      const real = [...this.players.values()].sort((a, b) => a.number - b.number);
      const usedNames = new Set(real.map((p) => p.name));
      const usedColors = new Set(real.map((p) => p.color));
      const npcNames = NAMES.filter((n) => !usedNames.has(n)).sort(() => this.random() - 0.5);
      const npcColors = COLORS.filter((c) => !usedColors.has(c.hex));
      this.seats = [];
      for (let i = 0; i < SEATS; i++) {
        const p = real[i];
        const spawn = MAP.SPAWNS[i];
        this.seats.push({
          n: i,
          kind: p ? 'player' : 'npc',
          playerId: p ? p.id : null,
          name: p ? p.name : npcNames[i - real.length],
          color: p ? p.color : npcColors[i - real.length].hex,
          x: spawn.x,
          y: spawn.y,
          facing: spawn.x > MAP.EMERGENCY_BUTTON.x ? -1 : 1,
          moving: false,
          alive: true,
          role: 'crew',
          tasks: [],
          emergencyLeft: 1,
          input: { ...EMPTY_MOVE },
          killCooldown: 0,
          ventCooldown: 0,
          witnessed: new Set(),
          seen: new Map(), // bots: seat n -> { tick, x, y } of when they last saw them
          sus: {}, // bots: how suspicious each seat is
          npc: p ? null : this.newNpcState(),
        });
      }
      // The Imposter: a real player once there are enough of them, otherwise an NPC.
      const pool = real.length >= REAL_IMPOSTER_FROM ? this.seats.filter((s) => s.kind === 'player') : this.seats.filter((s) => s.kind === 'npc');
      const imposter = pool[this.rand(pool.length)];
      imposter.role = 'imposter';
      imposter.killCooldown = FIRST_KILL_COOLDOWN;
      // Everyone gets tasks (the Imposter's are fake and don't count).
      this.seats.forEach((s) => {
        const picks = [...MAP.STATIONS].sort(() => this.random() - 0.5).slice(0, TASKS_EACH);
        s.tasks = picks.map((st) => ({ station: st.id, done: false }));
      });
      this.bodies = [];
      this.sabotage = null;
      this.sabotageCooldown = sec(15);
      this.buttonCooldown = BUTTON_COOLDOWN;
      this.meeting = null;
      this.ejection = null;
      this.phase = 'intro';
      this.phaseTicks = INTRO;
      this.tick = 0;
      this.events = [];
      this.started = true;
      this.broadcast('gameStarted', this.gamePayload());
      this.seats.forEach((s) => this.sendPrivate(s));
      this.stopLoop();
      this.loop = this.setInterval(() => this.gameTick(), 1000 / TICK_RATE);
      return true;
    }

    newNpcState() {
      return { path: null, goal: null, wait: this.rand(sec(2)), mode: 'idle', reportIn: -1, stuck: 0, lastX: 0, lastY: 0, voteAt: -1, voteFor: null, onWaitDone: null };
    }

    // ---------- Input ----------

    /**
     * { type: 'move', up, down, left, right }   which direction keys are held
     * { type: 'task', station }                 finished a task's mini-game
     * { type: 'use', what: 'emergency'|'lights' } press the emergency button / fix the lights
     * { type: 'report' }  { type: 'kill' }  { type: 'vent' }
     * { type: 'sabotage', kind: 'lights'|'reactor' }
     * { type: 'vote', target: seatNumber|'skip' }
     */
    input(id, msg) {
      if (!this.started || !msg || typeof msg !== 'object') return;
      const seat = this.seatOf(id);
      if (!seat) return;
      const play = this.phase === 'play';
      switch (msg.type) {
        case 'move':
          seat.input = { up: msg.up === true, down: msg.down === true, left: msg.left === true, right: msg.right === true, run: msg.run === true };
          break;
        case 'task':
          if (play) this.completeTask(seat, msg.station);
          break;
        case 'use':
          if (!play || !seat.alive) break;
          if (msg.what === 'emergency') this.pressButton(seat);
          else if (msg.what === 'lights') this.fixLights(seat);
          break;
        case 'report':
          if (play) this.report(seat);
          break;
        case 'kill':
          if (play) this.tryKill(seat);
          break;
        case 'vent':
          if (play) this.vent(seat);
          break;
        case 'sabotage':
          if (play) this.startSabotage(seat, msg.kind);
          break;
        case 'vote':
          if (this.phase === 'vote') this.castVote(seat, msg.target);
          break;
        default:
      }
    }

    // ---------- Actions ----------

    completeTask(seat, stationId) {
      if (seat.role !== 'crew') return false;
      const task = seat.tasks.find((t) => t.station === stationId && !t.done);
      const station = MAP.STATIONS.find((s) => s.id === stationId);
      if (!task || !station || !within(seat, station, USE_RANGE + 25)) return false;
      task.done = true;
      this.sendPrivate(seat);
      this.events.push({ type: 'taskDone', n: seat.n });
      this.checkWin();
      return true;
    }

    pressButton(seat) {
      if (seat.emergencyLeft <= 0 || this.buttonCooldown > 0) return false;
      if (this.sabotage && this.sabotage.kind === 'reactor') return false;
      if (!within(seat, MAP.EMERGENCY_BUTTON, USE_RANGE + 20)) return false;
      seat.emergencyLeft--;
      this.sendPrivate(seat);
      this.callMeeting(seat, 'emergency');
      return true;
    }

    fixLights(seat) {
      if (!this.sabotage || this.sabotage.kind !== 'lights' || !within(seat, MAP.LIGHTS_PANEL, USE_RANGE + 20)) return false;
      this.sabotage = null;
      this.events.push({ type: 'fixed', kind: 'lights' });
      return true;
    }

    report(seat) {
      if (!seat.alive) return false;
      const body = this.bodies.find((b) => within(seat, b, REPORT_RANGE));
      if (!body) return false;
      this.callMeeting(seat, 'body', body.n);
      return true;
    }

    tryKill(seat) {
      if (seat.role !== 'imposter' || !seat.alive || seat.killCooldown > 0) return false;
      const target = this.seats
        .filter((s) => s.alive && s.role === 'crew' && within(seat, s, KILL_RANGE))
        .sort((a, b) => dist2(seat, a) - dist2(seat, b))[0];
      if (!target) return false;
      this.kill(seat, target);
      return true;
    }

    kill(killer, victim) {
      victim.alive = false;
      victim.moving = false;
      victim.input = { ...EMPTY_MOVE };
      this.bodies.push({ n: victim.n, x: victim.x, y: victim.y });
      killer.killCooldown = KILL_COOLDOWN;
      // The killer jumps onto the body, like in Among Us.
      killer.x = victim.x;
      killer.y = victim.y;
      // Nearby NPCs saw it: they'll report the body and vote for the killer.
      this.seats.forEach((s) => {
        if (s.kind !== 'npc' || !s.alive || s.role !== 'crew' || !within(s, victim, WITNESS_RANGE)) return;
        s.witnessed.add(killer.n);
        if (s.npc && s.npc.reportIn < 0) s.npc.reportIn = sec(1) + this.rand(sec(1));
      });
      // Who was each bot seeing around the victim in the last few seconds? They're now suspects.
      this.seats.forEach((s) => {
        if (s.kind !== 'npc' || !s.alive || s.role !== 'crew') return;
        s.seen.forEach((p, n) => {
          if (n === victim.n || this.tick - p.tick > sec(12)) return;
          const d = Math.hypot(p.x - victim.x, p.y - victim.y);
          if (d < 320) s.sus[n] = (s.sus[n] || 0) + (d < 160 ? 3 : 2);
        });
      });
      this.events.push({ type: 'kill', killer: killer.n, victim: victim.n, x: victim.x, y: victim.y });
      this.sendPrivate(killer);
      if (victim.kind === 'player') this.sendPrivate(victim);
      this.checkWin();
    }

    vent(seat) {
      if (seat.role !== 'imposter' || !seat.alive || seat.ventCooldown > 0) return false;
      const here = MAP.VENTS.find((v) => within(seat, v, VENT_RANGE));
      if (!here) return false;
      const group = MAP.VENTS.filter((v) => v.group === here.group);
      const next = group[(group.indexOf(here) + 1) % group.length];
      seat.x = next.x;
      seat.y = next.y;
      seat.ventCooldown = sec(0.6);
      // Bots who see someone pop in or out of a vent know exactly who it is.
      this.seats.forEach((s) => {
        if (s.kind === 'npc' && s.alive && s.role === 'crew' && (within(s, here, NPC_VISION) || within(s, next, NPC_VISION))) s.witnessed.add(seat.n);
      });
      this.events.push({ type: 'vent', n: seat.n, from: here.id, to: next.id });
      return true;
    }

    startSabotage(seat, kind) {
      if (seat.role !== 'imposter' || !seat.alive || this.sabotage || this.sabotageCooldown > 0) return false;
      if (kind !== 'lights' && kind !== 'reactor') return false;
      this.sabotage = { kind, ticksLeft: kind === 'reactor' ? REACTOR_TIME : -1, fix: 0 };
      this.sabotageCooldown = SABOTAGE_COOLDOWN;
      // Some NPCs head off to fix it.
      this.seats.forEach((s) => {
        if (s.kind === 'npc' && s.alive && s.role === 'crew' && this.random() < (kind === 'reactor' ? 0.35 : 0.2)) {
          s.npc.mode = 'fix';
          s.npc.path = null;
        }
      });
      this.events.push({ type: 'sabotage', kind });
      return true;
    }

    // ---------- Meetings ----------

    callMeeting(caller, reason, bodyN = null) {
      this.meeting = { caller: caller.n, reason, body: bodyN, votes: {}, tally: null, ejected: null };
      this.sabotage = null;
      this.phase = 'discuss';
      this.phaseTicks = DISCUSS;
      this.seats.forEach((s) => {
        s.input = { ...EMPTY_MOVE };
        s.moving = false;
        if (s.npc) {
          s.npc.path = null;
          s.npc.reportIn = -1;
        }
      });
      this.events.push({ type: 'meeting', reason, caller: caller.n, body: bodyN });
    }

    castVote(seat, target) {
      if (!seat.alive || this.meeting.votes[seat.n] !== undefined) return false;
      if (target !== 'skip') {
        const t = this.seats[target];
        if (!Number.isInteger(target) || !t || !t.alive) return false;
      }
      this.meeting.votes[seat.n] = target;
      this.events.push({ type: 'voted', n: seat.n });
      if (this.seats.every((s) => !s.alive || this.meeting.votes[s.n] !== undefined)) this.phaseTicks = 0;
      return true;
    }

    // How suspicious this bot finds each living seat: an eyewitness is sure, otherwise it's whoever
    // it saw hanging around the victim just before the kill.
    npcSuspects(seat) {
      const scores = {};
      this.seats.forEach((o) => {
        if (!o.alive || o.n === seat.n) return;
        let score = seat.witnessed.has(o.n) ? 10 : 0;
        score += seat.sus[o.n] || 0;
        if (score > 0) scores[o.n] = score;
      });
      return Object.entries(scores).map(([n, score]) => ({ n: Number(n), score })).sort((a, b) => b.score - a.score);
    }

    // Who has the most votes so far (not counting skips), and how many.
    voteLeader(excludeN) {
      const counts = {};
      Object.values(this.meeting.votes).forEach((t) => { if (t !== 'skip' && t !== excludeN) counts[t] = (counts[t] || 0) + 1; });
      let leader = null;
      let count = 0;
      Object.entries(counts).forEach(([t, c]) => {
        if (c > count) {
          leader = Number(t);
          count = c;
        }
      });
      return { leader, count, cast: Object.keys(this.meeting.votes).length };
    }

    // Bots vote like people: anyone sure of who did it votes early, the rest listen to the room and
    // pile on to the front runner (or follow their hunch), otherwise they skip.
    npcDecideVote(seat) {
      const { leader, count, cast } = this.voteLeader(seat.n);
      const leaderOk = leader !== null && this.seats[leader] && this.seats[leader].alive;
      if (seat.role === 'imposter') {
        // Blend in: go with the crowd, or push suspicion onto a random crewmate.
        if (leaderOk && count >= 1) return leader;
        const crew = this.seats.filter((s) => s.alive && s.role === 'crew');
        return crew.length && this.random() < 0.45 ? crew[this.rand(crew.length)].n : 'skip';
      }
      const suspects = this.npcSuspects(seat);
      const top = suspects[0];
      if (top && top.score >= 4) return top.n;
      if (leaderOk && count >= 2 && this.random() < Math.min(0.92, 0.45 + 0.12 * count + 0.02 * cast)) return leader;
      if (top && top.score >= 1.5 && this.random() < 0.65) return top.n;
      if (leaderOk && count >= 1 && this.random() < 0.35) return leader;
      return 'skip';
    }

    npcPlanVote(seat) {
      const top = seat.role === 'crew' ? this.npcSuspects(seat)[0] : null;
      const sure = top && top.score >= 4;
      seat.npc.voteFor = this.npcDecideVote(seat);
      // Eyewitnesses speak up first; everyone else waits to see which way the room is leaning.
      const after = sure ? sec(1) + this.rand(sec(4)) : sec(6) + this.rand(sec(18));
      seat.npc.voteAt = Math.max(sec(2), this.phaseTicks - after);
    }

    finishVote() {
      const counts = {};
      Object.values(this.meeting.votes).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
      let best = null;
      let bestCount = 0;
      let tie = false;
      Object.entries(counts).forEach(([t, c]) => {
        if (c > bestCount) {
          best = t;
          bestCount = c;
          tie = false;
        } else if (c === bestCount) {
          tie = true;
        }
      });
      const ejected = !tie && best !== null && best !== 'skip' ? Number(best) : null;
      this.meeting.tally = counts;
      this.meeting.ejected = ejected;
      this.meeting.tie = tie;
      this.phase = 'result';
      this.phaseTicks = RESULT;
    }

    eject() {
      const n = this.meeting.ejected;
      const seat = n === null ? null : this.seats[n];
      if (seat) {
        seat.alive = false;
        if (seat.kind === 'player') this.sendPrivate(seat);
      }
      this.ejection = { n, wasImposter: !!seat && seat.role === 'imposter', tie: this.meeting.tie };
      this.phase = 'ejection';
      this.phaseTicks = EJECT;
    }

    resumePlay() {
      this.meeting = null;
      this.ejection = null;
      this.bodies = [];
      this.phase = 'play';
      this.buttonCooldown = BUTTON_COOLDOWN;
      // Everyone back around the Cafeteria table.
      this.seats.forEach((s, i) => {
        if (s.alive) {
          s.x = MAP.SPAWNS[i].x;
          s.y = MAP.SPAWNS[i].y;
        }
        s.seen.clear();
        Object.keys(s.sus).forEach((n) => { s.sus[n] /= 2; });
        if (s.role === 'imposter') s.killCooldown = KILL_COOLDOWN;
        if (s.npc) Object.assign(s.npc, this.newNpcState());
      });
      this.seats.forEach((s) => this.sendPrivate(s));
      if (!this.checkWin()) this.events.push({ type: 'resume' });
    }

    // ---------- Winning ----------

    totals() {
      const crew = this.seats.filter((s) => s.role === 'crew');
      const total = crew.reduce((t, s) => t + s.tasks.length, 0);
      const done = crew.reduce((t, s) => t + s.tasks.filter((x) => x.done).length, 0);
      return { total, done };
    }

    checkWin() {
      if (!this.started) return true;
      const imposter = this.seats.find((s) => s.role === 'imposter');
      const crewAlive = this.seats.filter((s) => s.alive && s.role === 'crew').length;
      const { total, done } = this.totals();
      let result = null;
      if (!imposter.alive) result = { winner: 'crew', reason: 'ejected' };
      else if (done >= total) result = { winner: 'crew', reason: 'tasks' };
      else if (crewAlive <= 1) result = { winner: 'imposter', reason: 'kills' };
      if (!result) return false;
      // A meeting's ejection screen finishes first.
      if (this.phase === 'result') return false;
      this.endGame(result.winner, result.reason);
      return true;
    }

    endGame(winner, reason) {
      this.stopLoop();
      const events = this.flushEvents();
      this.started = false;
      this.phase = 'over';
      const imposter = this.seats.find((s) => s.role === 'imposter');
      this.broadcast('gameOver', { winner, reason, imposter: imposter.n, roster: this.roster(), events });
      this.broadcastLobby();
    }

    // ---------- Game loop ----------

    gameTick() {
      this.tick++;
      this.events = this.events || [];
      if (this.phase === 'intro') {
        if (--this.phaseTicks <= 0) this.phase = 'play';
      } else if (this.phase === 'play') {
        this.stepPlay();
      } else if (this.phase === 'discuss') {
        if (--this.phaseTicks <= 0) {
          this.phase = 'vote';
          this.phaseTicks = VOTE;
          this.seats.forEach((s) => { if (s.kind === 'npc' && s.alive) this.npcPlanVote(s); });
        }
      } else if (this.phase === 'vote') {
        this.seats.forEach((s) => {
          if (s.kind === 'npc' && s.alive && s.npc && s.npc.voteAt >= 0 && this.phaseTicks <= s.npc.voteAt && this.meeting.votes[s.n] === undefined) {
            this.castVote(s, this.npcDecideVote(s));
          }
        });
        if (--this.phaseTicks <= 0) this.finishVote();
      } else if (this.phase === 'result') {
        if (--this.phaseTicks <= 0) this.eject();
      } else if (this.phase === 'ejection') {
        if (--this.phaseTicks <= 0) this.resumePlay();
      }
      if (this.started) this.broadcastState();
    }

    stepPlay() {
      if (this.buttonCooldown > 0) this.buttonCooldown--;
      if (this.sabotageCooldown > 0 && !this.sabotage) this.sabotageCooldown--;
      this.seats.forEach((s) => {
        if (s.killCooldown > 0 && s.alive) s.killCooldown--;
        if (s.ventCooldown > 0) s.ventCooldown--;
        if (s.kind === 'npc') this.stepNpc(s);
        if (this.tick % 5 === 0 && s.kind === 'npc' && s.alive && s.role === 'crew') this.npcLook(s);
        this.move(s);
      });
      // Reactor meltdown: someone has to stand at the panel for a few seconds.
      if (this.sabotage && this.sabotage.kind === 'reactor') {
        const fixing = this.seats.some((s) => s.alive && within(s, MAP.REACTOR_PANEL, USE_RANGE + 10));
        this.sabotage.fix = fixing ? this.sabotage.fix + 1 : 0;
        if (this.sabotage.fix >= REACTOR_FIX) {
          this.sabotage = null;
          this.events.push({ type: 'fixed', kind: 'reactor' });
        } else if (--this.sabotage.ticksLeft <= 0) {
          this.endGame('imposter', 'reactor');
          return;
        }
      }
      if (this.tick % 10 === 0) this.seats.forEach((s) => { if (s.kind === 'player') this.sendPrivate(s, true); });
    }

    move(s) {
      if (s.npcStep) {
        // NPCs head straight for their next waypoint, sliding along walls if needed.
        const { dx, dy, ghost } = s.npcStep;
        s.npcStep = null;
        s.moving = true;
        if (Math.abs(dx) > 0.5) s.facing = Math.sign(dx);
        if (ghost) {
          s.x += dx;
          s.y += dy;
        } else if (MAP.isWalkable(s.x + dx, s.y + dy, RADIUS)) {
          s.x += dx;
          s.y += dy;
        } else {
          if (MAP.isWalkable(s.x + dx, s.y, RADIUS)) s.x += dx;
          if (MAP.isWalkable(s.x, s.y + dy, RADIUS)) s.y += dy;
        }
        return;
      }
      const { up, down, left, right } = s.input;
      let dx = (right ? 1 : 0) - (left ? 1 : 0);
      let dy = (down ? 1 : 0) - (up ? 1 : 0);
      s.moving = (dx !== 0 || dy !== 0) && (s.alive || s.kind === 'player');
      if (!s.moving) return;
      if (dx) s.facing = dx;
      const len = Math.hypot(dx, dy);
      const speed = (s.alive ? SPEED : GHOST_SPEED) * (s.input.run ? RUN : 1);
      dx = (dx / len) * speed;
      dy = (dy / len) * speed;
      if (!s.alive) {
        // Ghosts float through walls.
        s.x = Math.max(20, Math.min(MAP.WIDTH - 20, s.x + dx));
        s.y = Math.max(20, Math.min(MAP.HEIGHT - 20, s.y + dy));
        return;
      }
      // Running moves in small steps, so nobody slips through a wall.
      const steps = Math.ceil(speed / SPEED);
      for (let i = 0; i < steps; i++) {
        if (MAP.isWalkable(s.x + dx / steps, s.y, RADIUS)) s.x += dx / steps;
        if (MAP.isWalkable(s.x, s.y + dy / steps, RADIUS)) s.y += dy / steps;
      }
    }

    // ---------- NPCs ----------

    stepNpc(s) {
      const npc = s.npc;
      s.input = { ...EMPTY_MOVE };
      if (!s.alive) {
        this.stepGhostNpc(s);
        return;
      }
      // Report a body it saw (or happens to walk past).
      if (s.role === 'crew') {
        if (npc.reportIn > 0) npc.reportIn--;
        const body = this.bodies.find((b) => within(s, b, NPC_SEE_BODY));
        if (body && npc.reportIn < 0) npc.reportIn = sec(0.8) + this.rand(sec(1));
        if (npc.reportIn === 0) {
          npc.reportIn = -1;
          const near = this.bodies.find((b) => within(s, b, WITNESS_RANGE + 80));
          if (near) {
            this.callMeeting(s, 'body', near.n);
            return;
          }
        }
      }
      // The Imposter NPC strikes when it catches a crewmate alone.
      if (s.role === 'imposter' && s.killCooldown <= 0) {
        const target = this.seats.find((t) => t.alive && t.role === 'crew' && within(s, t, KILL_RANGE));
        if (target) {
          const witnesses = this.seats.filter((o) => o.alive && o.role === 'crew' && o !== target && within(o, target, WITNESS_RANGE));
          if (!witnesses.length) {
            this.kill(s, target);
            npc.goal = null;
            npc.path = null;
            return;
          }
        }
        if (!this.sabotage && this.sabotageCooldown <= 0 && this.random() < 0.002) this.startSabotage(s, this.random() < 0.4 ? 'reactor' : 'lights');
      }
      if (npc.wait > 0) {
        npc.wait--;
        // Finished the task it was standing at.
        if (npc.wait === 0 && npc.onWaitDone) {
          const done = npc.onWaitDone;
          npc.onWaitDone = null;
          done();
        }
        return;
      }
      if (!npc.path || !npc.path.length) {
        if (npc.goal) {
          this.npcArrived(s);
          return;
        }
        this.npcPickGoal(s);
        return;
      }
      // Walk towards the next waypoint.
      const wp = npc.path[0];
      const dx = wp.x - s.x;
      const dy = wp.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d <= SPEED) {
        npc.path.shift();
        if (MAP.isWalkable(wp.x, wp.y, RADIUS)) {
          s.x = wp.x;
          s.y = wp.y;
        }
        return;
      }
      s.npcStep = { dx: (dx / d) * SPEED, dy: (dy / d) * SPEED };
      // Unstick if it hasn't moved for a while.
      if (Math.abs(s.x - npc.lastX) + Math.abs(s.y - npc.lastY) < 1) {
        if (++npc.stuck > sec(1.5)) {
          npc.path = MAP.findPath(s, npc.goal || wp);
          npc.stuck = 0;
        }
      } else {
        npc.stuck = 0;
      }
      npc.lastX = s.x;
      npc.lastY = s.y;
    }

    // Remember who's around (and where), and be wary of anyone standing over a body.
    npcLook(s) {
      this.seats.forEach((o) => {
        if (o === s || !o.alive || !within(s, o, NPC_VISION)) return;
        s.seen.set(o.n, { tick: this.tick, x: o.x, y: o.y });
        if (this.bodies.some((b) => within(o, b, 90) && within(s, b, NPC_VISION))) {
          s.sus[o.n] = Math.min(6, (s.sus[o.n] || 0) + 0.5);
        }
      });
    }

    // A dead crewmate NPC floats (through walls) from task to task, like a player's ghost.
    stepGhostNpc(s) {
      const npc = s.npc;
      if (s.role !== 'crew') return;
      if (npc.wait > 0) {
        if (--npc.wait === 0 && npc.onWaitDone) {
          const done = npc.onWaitDone;
          npc.onWaitDone = null;
          done();
        }
        return;
      }
      if (!npc.goal || !npc.goal.station) {
        const task = s.tasks.find((t) => !t.done);
        if (!task) return;
        const st = MAP.STATIONS.find((x) => x.id === task.station);
        npc.goal = { x: st.x, y: st.y, station: st.id };
        npc.path = null;
      }
      const dx = npc.goal.x - s.x;
      const dy = npc.goal.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d <= GHOST_SPEED) {
        s.x = npc.goal.x;
        s.y = npc.goal.y;
        this.npcArrived(s);
        return;
      }
      s.npcStep = { dx: (dx / d) * GHOST_SPEED, dy: (dy / d) * GHOST_SPEED, ghost: true };
    }

    npcPickGoal(s) {
      const npc = s.npc;
      let goal = null;
      if (npc.mode === 'fix' && this.sabotage) {
        goal = this.sabotage.kind === 'reactor' ? { ...MAP.REACTOR_PANEL, kind: 'reactor' } : { ...MAP.LIGHTS_PANEL, kind: 'lights' };
      } else if (s.role === 'imposter' && this.random() < 0.5) {
        // Hunt: follow a random crewmate.
        const crew = this.seats.filter((t) => t.alive && t.role === 'crew');
        const prey = crew[this.rand(crew.length)];
        if (prey) goal = { x: prey.x, y: prey.y, hunt: true };
      } else {
        npc.mode = 'idle';
        const todo = s.tasks.filter((t) => !t.done);
        if (todo.length && this.random() < 0.85) {
          const task = todo[this.rand(todo.length)];
          const st = MAP.STATIONS.find((x) => x.id === task.station);
          goal = { x: st.x, y: st.y, station: st.id };
        } else {
          const room = MAP.ROOMS[this.rand(MAP.ROOMS.length)];
          goal = { x: (room.x0 + room.x1) / 2, y: (room.y0 + room.y1) / 2 };
        }
      }
      npc.goal = goal;
      npc.path = MAP.findPath(s, goal) || [];
      if (!npc.path.length) npc.goal = null;
    }

    npcArrived(s) {
      const npc = s.npc;
      const goal = npc.goal;
      npc.goal = null;
      if (goal.station) {
        // Spend a moment on the task. (The Imposter just pretends.)
        const station = goal.station;
        npc.wait = sec(4) + this.rand(sec(5));
        // Ghosts finish their tasks too (and the Imposter's are fake, so they never count).
        npc.onWaitDone = () => this.completeTask(s, station);
      } else if (goal.hunt) {
        npc.wait = sec(0.5);
      } else if (goal.kind === 'lights') {
        this.fixLights(s);
        npc.mode = 'idle';
      } else if (goal.kind === 'reactor') {
        npc.wait = this.sabotage ? sec(4) : 0;
        npc.mode = 'idle';
      } else {
        npc.wait = sec(1) + this.rand(sec(4));
      }
    }

    // ---------- Payloads ----------

    seatOf(id) {
      return this.seats.find((s) => s.playerId === id);
    }

    roster() {
      return this.seats.map((s) => ({ n: s.n, name: s.name, color: s.color, alive: s.alive, role: this.phase === 'over' ? s.role : undefined }));
    }

    lobbyPayload() {
      const players = [...this.players.values()]
        .map((p) => ({ id: p.id, number: p.number, name: p.name, color: p.color }))
        .sort((a, b) => a.number - b.number);
      return { roomCode: this.code, hostId: this.hostId, started: this.started, players };
    }

    gamePayload() {
      return {
        tickRate: TICK_RATE,
        roster: this.roster(),
        ...this.stateFields(),
        ...this.lobbyPayload(),
      };
    }

    stateFields() {
      const { total, done } = this.totals();
      const m = this.meeting;
      return {
        phase: this.phase,
        phaseTicks: this.phaseTicks,
        seats: this.seats.map((s) => ({ n: s.n, x: Math.round(s.x), y: Math.round(s.y), f: s.facing, m: s.moving, a: s.alive })),
        bodies: this.bodies.map((b) => ({ ...b })),
        taskBar: total ? done / total : 0,
        sabotage: this.sabotage ? { kind: this.sabotage.kind, ticksLeft: this.sabotage.ticksLeft, fix: this.sabotage.fix } : null,
        buttonCooldown: this.buttonCooldown,
        meeting: m && {
          caller: m.caller,
          reason: m.reason,
          body: m.body,
          voted: Object.keys(m.votes).map(Number),
          // Who voted for whom is only revealed once voting closes.
          tally: m.tally,
          votes: this.phase === 'result' ? m.votes : null,
          ejected: this.phase === 'result' ? m.ejected : null,
        },
        ejection: this.ejection,
      };
    }

    broadcastState() {
      const events = this.flushEvents();
      this.broadcast('state', { ...this.stateFields(), events });
    }

    flushEvents() {
      const events = this.events || [];
      this.events = [];
      return events;
    }

    // What only this player should know: their role, tasks and cooldowns.
    sendPrivate(seat, quiet = false) {
      if (!seat || seat.kind !== 'player' || !seat.playerId) return;
      const data = {
        n: seat.n,
        role: seat.role,
        alive: seat.alive,
        tasks: seat.tasks.map((t) => ({ ...t })),
        killCooldown: Math.ceil(seat.killCooldown / TICK_RATE),
        sabotageCooldown: Math.ceil((this.sabotageCooldown || 0) / TICK_RATE),
        emergencyLeft: seat.emergencyLeft,
      };
      const key = JSON.stringify(data);
      if (quiet && seat.lastPrivate === key) return;
      seat.lastPrivate = key;
      this.send(seat.playerId, 'you', data);
    }

    broadcastLobby() {
      this.broadcast('lobbyUpdate', this.lobbyPayload());
    }

    stopLoop() {
      if (this.loop !== null) this.clearInterval(this.loop);
      this.loop = null;
    }

    destroy() {
      this.stopLoop();
      this.started = false;
    }
  }

  return {
    GameRoom,
    generateRoomCode,
    TICK_RATE,
    MAX_PLAYERS,
    MIN_PLAYERS,
    SEATS,
    REAL_IMPOSTER_FROM,
    TASKS_EACH,
    KILL_RANGE,
    KILL_COOLDOWN,
    FIRST_KILL_COOLDOWN,
    USE_RANGE,
    REPORT_RANGE,
    VENT_RANGE,
    REACTOR_TIME,
    COLORS,
    NAMES,
    sec,
  };
});

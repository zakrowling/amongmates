const test = require('node:test');
const assert = require('node:assert/strict');
const MAP = require('../public/map.js');
const {
  GameRoom, generateRoomCode, TICK_RATE, SEATS, MAX_PLAYERS, TASKS_EACH, KILL_RANGE, KILL_COOLDOWN,
  FIRST_KILL_COOLDOWN, REACTOR_TIME, NAMES, sec,
} = require('../public/engine.js');

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A room with a manual clock that records every message it sends.
function makeRoom(seed = 1, extra = {}) {
  const sent = [];
  let tickFn = null;
  const room = new GameRoom('TEST', {
    broadcast: (ev, data) => sent.push({ to: '*', ev, data }),
    send: (to, ev, data) => sent.push({ to, ev, data }),
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    random: seeded(seed),
    ...extra,
  });
  const run = (n = 1) => { for (let i = 0; i < n && tickFn; i++) tickFn(); };
  const last = (ev, to) => [...sent].reverse().find((m) => m.ev === ev && (!to || m.to === to));
  const events = (type) => sent.filter((m) => m.ev === 'state' || m.ev === 'gameOver').flatMap((m) => m.data.events || []).filter((e) => !type || e.type === type);
  return { room, sent, run, last, events, isRunning: () => tickFn !== null };
}

function started(players = 2, seed = 1, opts) {
  const ctx = makeRoom(seed, opts && opts.hooks);
  for (let i = 1; i <= players; i++) ctx.room.join(`p${i}`);
  ctx.room.start('p1', opts && opts.start);
  ctx.run(sec(4) + 1); // past the role reveal
  return ctx;
}

const seat = (room, id) => room.seatOf(id);
const imposterOf = (room) => room.seats.find((s) => s.role === 'imposter');
// Freeze NPCs (so tests control everything) by making them all wait a long time.
const freezeNpcs = (room) => room.seats.forEach((s) => { if (s.npc) s.npc.wait = 1e9; });

// ---------- Map ----------

test('every room, task, vent and button is walkable and reachable from the Cafeteria', () => {
  const points = [
    ...MAP.STATIONS, ...MAP.VENTS, MAP.EMERGENCY_BUTTON, MAP.LIGHTS_PANEL, MAP.REACTOR_PANEL, ...MAP.SPAWNS,
    ...MAP.ROOMS.map((r) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })),
  ];
  for (const p of points) {
    assert.ok(MAP.isWalkable(p.x, p.y, 12), `walkable at ${p.x},${p.y}`);
    assert.ok(MAP.findPath(MAP.SPAWNS[0], p), `reachable ${p.x},${p.y}`);
  }
  assert.ok(!MAP.isWalkable(5, 5), 'outside the ship is not walkable');
  assert.equal(MAP.roomAt(MAP.EMERGENCY_BUTTON.x, MAP.EMERGENCY_BUTTON.y), 'Cafeteria');
});

// ---------- Lobby ----------

test('room codes, unique 4-5 letter names, up to 8 players', () => {
  assert.match(generateRoomCode(), /^[A-HJ-NP-Z]{4}$/);
  assert.ok(NAMES.every((n) => n.length >= 4 && n.length <= 5));
  const { room } = makeRoom();
  for (let i = 1; i <= MAX_PLAYERS; i++) assert.ok(room.join(`p${i}`).ok);
  const names = [...room.players.values()].map((p) => p.name);
  assert.equal(new Set(names).size, MAX_PLAYERS);
  assert.equal(new Set([...room.players.values()].map((p) => p.color)).size, MAX_PLAYERS);
  assert.match(room.join('p9').error, /full/);
});

test('it takes 2 players to start (1 only with the solo test switch)', () => {
  const solo = makeRoom();
  solo.room.join('p1');
  assert.equal(solo.room.start('p1'), false);
  assert.equal(solo.room.start('p1', { solo: true }), false, 'solo needs the test switch');
  const test1 = makeRoom(1, { allowSolo: true });
  test1.room.join('p1');
  assert.equal(test1.room.start('p1', { solo: true }), true);
  const duo = makeRoom();
  duo.room.join('p1');
  duo.room.join('p2');
  assert.equal(duo.room.start('stranger'), false);
  assert.equal(duo.room.start('p2'), true);
});

test('NPCs fill the ship to 15, each with a unique name and colour', () => {
  const { room, last } = started(3);
  assert.equal(room.seats.length, SEATS);
  assert.equal(room.seats.filter((s) => s.kind === 'player').length, 3);
  assert.equal(new Set(room.seats.map((s) => s.name)).size, SEATS);
  assert.equal(new Set(room.seats.map((s) => s.color)).size, SEATS);
  const payload = last('gameStarted').data;
  assert.equal(payload.roster.length, SEATS);
  assert.ok(payload.roster.every((r) => r.role === undefined), 'nobody is told who the Imposter is');
  assert.ok(room.seats.every((s) => s.tasks.length === TASKS_EACH));
});

test('with under 4 players an NPC is the Imposter; from 4 it is a real player; always exactly 1', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const small = started(3, seed);
    assert.equal(small.room.seats.filter((s) => s.role === 'imposter').length, 1);
    assert.equal(imposterOf(small.room).kind, 'npc');
    const big = started(4, seed);
    assert.equal(big.room.seats.filter((s) => s.role === 'imposter').length, 1);
    assert.equal(imposterOf(big.room).kind, 'player');
  }
});

test('each player is told only their own role and tasks', () => {
  const { room, last } = started(4);
  const imp = imposterOf(room);
  assert.equal(last('you', imp.playerId).data.role, 'imposter');
  const crew = room.seats.find((s) => s.kind === 'player' && s.role === 'crew');
  const mine = last('you', crew.playerId).data;
  assert.equal(mine.role, 'crew');
  assert.equal(mine.tasks.length, TASKS_EACH);
  assert.ok(!JSON.stringify(last('state').data).includes('imposter'), 'the shared state never names the Imposter');
});

// ---------- Moving ----------

test('players move with their keys and walls stop them', () => {
  const { room, run } = started(2);
  const me = seat(room, 'p1');
  me.x = 1220;
  me.y = 200;
  room.input('p1', { type: 'move', right: true });
  run(10);
  assert.ok(me.x > 1250, 'moved right');
  room.input('p1', { type: 'move', up: true });
  run(100);
  assert.ok(MAP.isWalkable(me.x, me.y), 'stopped at the wall');
  assert.ok(me.y < 120);
});

// ---------- Killing, reporting, meetings ----------

function setupKill(players = 4, seed = 3) {
  const ctx = started(players, seed);
  freezeNpcs(ctx.room);
  const imp = imposterOf(ctx.room);
  const victim = ctx.room.seats.find((s) => s.role === 'crew' && s.kind === 'player');
  // Put them alone together in Electrical.
  ctx.room.seats.forEach((s, i) => { s.x = MAP.SPAWNS[i].x; s.y = MAP.SPAWNS[i].y; });
  Object.assign(imp, { x: 700, y: 1080 });
  Object.assign(victim, { x: 740, y: 1080 });
  return { ...ctx, imp, victim };
}

test('the Imposter kills a crewmate in range once the cooldown is over, leaving a body', () => {
  const { room, run, imp, victim } = setupKill();
  room.input(imp.playerId, { type: 'kill' });
  assert.equal(victim.alive, true, 'not before the first cooldown');
  imp.killCooldown = 0;
  victim.x = imp.x + KILL_RANGE + 30;
  room.input(imp.playerId, { type: 'kill' });
  assert.equal(victim.alive, true, 'not out of range');
  victim.x = imp.x + 40;
  room.input(imp.playerId, { type: 'kill' });
  assert.equal(victim.alive, false);
  assert.equal(room.bodies.length, 1);
  assert.equal(imp.killCooldown, KILL_COOLDOWN);
  run(1);
  assert.equal(room.bodies[0].n, victim.n);
  // Crewmates can't kill.
  const crew = room.seats.find((s) => s.role === 'crew' && s.alive && s.kind === 'player');
  crew.x = imp.x;
  crew.y = imp.y;
  room.input(crew.playerId, { type: 'kill' });
  assert.ok(imp.alive);
});

test('reporting a body calls a meeting; votes eject the Imposter and the crew wins', () => {
  const { room, run, last, imp, victim } = setupKill();
  imp.killCooldown = 0;
  room.input(imp.playerId, { type: 'kill' });
  const reporter = room.seats.find((s) => s.kind === 'player' && s.alive && s.role === 'crew');
  Object.assign(reporter, { x: victim.x + 30, y: victim.y });
  room.input(reporter.playerId, { type: 'report' });
  assert.equal(room.phase, 'discuss');
  assert.equal(room.meeting.reason, 'body');
  run(sec(15));
  assert.equal(room.phase, 'vote');
  // Every living seat votes the Imposter (NPCs are made to agree here).
  room.seats.filter((s) => s.alive).forEach((s) => room.castVote(s, s === imp ? 'skip' : imp.n));
  run(1);
  assert.equal(room.phase, 'result');
  assert.equal(room.meeting.ejected, imp.n);
  run(sec(5) + 1);
  assert.equal(room.phase, 'ejection');
  assert.equal(room.ejection.wasImposter, true);
  run(sec(5) + 1);
  const over = last('gameOver').data;
  assert.equal(over.winner, 'crew');
  assert.equal(over.reason, 'ejected');
  assert.equal(over.imposter, imp.n);
});

test('a tied or skipped vote ejects no one; dead crewmates cannot vote', () => {
  const { room, run, imp, victim } = setupKill();
  imp.killCooldown = 0;
  room.input(imp.playerId, { type: 'kill' });
  const me = room.seats.find((s) => s.kind === 'player' && s.alive && s.role === 'crew');
  me.x = MAP.EMERGENCY_BUTTON.x;
  me.y = MAP.EMERGENCY_BUTTON.y;
  room.buttonCooldown = 0;
  room.input(me.playerId, { type: 'use', what: 'emergency' });
  assert.equal(room.meeting.reason, 'emergency');
  run(sec(15));
  assert.equal(room.castVote(victim, me.n), false, 'the dead do not vote');
  room.seats.filter((s) => s.alive).forEach((s) => room.castVote(s, 'skip'));
  run(1);
  assert.equal(room.meeting.ejected, null);
  run(sec(10) + 2);
  assert.equal(room.phase, 'play');
  assert.equal(room.bodies.length, 0, 'bodies are cleared after a meeting');
  assert.equal(me.emergencyLeft, 0);
  me.x = MAP.EMERGENCY_BUTTON.x;
  me.y = MAP.EMERGENCY_BUTTON.y;
  room.buttonCooldown = 0;
  room.input(me.playerId, { type: 'use', what: 'emergency' });
  assert.equal(room.phase, 'play', 'only one emergency meeting each');
});

test('the Imposter wins once only one crewmate is left', () => {
  const { room, last } = setupKill(4, 5);
  const imp = imposterOf(room);
  const crew = room.seats.filter((s) => s.role === 'crew');
  crew.slice(1).forEach((c) => { c.alive = false; });
  crew[0].x = imp.x + 10;
  crew[0].y = imp.y;
  crew[0].alive = true;
  crew.slice(2).forEach((c) => { c.alive = false; });
  // Two crew left; kill one.
  crew[1].alive = true;
  Object.assign(crew[1], { x: imp.x + 20, y: imp.y });
  imp.killCooldown = 0;
  room.input(imp.playerId, { type: 'kill' });
  assert.equal(last('gameOver').data.winner, 'imposter');
});

test('crewmates win by finishing every task (ghosts keep helping)', () => {
  const { room, last } = started(2, 7);
  freezeNpcs(room);
  const me = seat(room, room.seats.find((s) => s.kind === 'player' && s.role === 'crew').playerId);
  me.alive = false; // a ghost can still do tasks
  room.seats.filter((s) => s.role === 'crew' && s !== me).forEach((s) => s.tasks.forEach((t) => { t.done = true; }));
  me.tasks.forEach((t, i) => {
    const st = MAP.STATIONS.find((x) => x.id === t.station);
    me.x = st.x;
    me.y = st.y;
    if (i < me.tasks.length - 1) assert.ok(room.completeTask(me, t.station));
  });
  assert.equal(room.started, true);
  const lastTask = me.tasks[me.tasks.length - 1];
  room.input(me.playerId, { type: 'task', station: lastTask.station });
  assert.equal(last('gameOver').data.winner, 'crew');
  assert.equal(last('gameOver').data.reason, 'tasks');
});

test('tasks only count at the right station, and not for the Imposter', () => {
  const { room } = started(4, 9);
  freezeNpcs(room);
  const crew = room.seats.find((s) => s.kind === 'player' && s.role === 'crew');
  const t = crew.tasks[0];
  crew.x = MAP.EMERGENCY_BUTTON.x;
  crew.y = MAP.EMERGENCY_BUTTON.y;
  const st = MAP.STATIONS.find((x) => x.id === t.station);
  if (st.room !== 'cafeteria') assert.equal(room.completeTask(crew, t.station), false, 'too far away');
  crew.x = st.x;
  crew.y = st.y;
  assert.equal(room.completeTask(crew, t.station), true);
  assert.equal(room.completeTask(crew, t.station), false, 'already done');
  const imp = imposterOf(room);
  const fake = MAP.STATIONS.find((x) => x.id === imp.tasks[0].station);
  imp.x = fake.x;
  imp.y = fake.y;
  assert.equal(room.completeTask(imp, fake.id), false, 'Imposter tasks are fake');
});

// ---------- Sabotage and vents ----------

test('reactor meltdown wins for the Imposter unless someone holds the panel', () => {
  const ctx = started(4, 11);
  freezeNpcs(ctx.room);
  const imp = imposterOf(ctx.room);
  ctx.room.sabotageCooldown = 0;
  ctx.room.input(imp.playerId, { type: 'sabotage', kind: 'reactor' });
  assert.equal(ctx.room.sabotage.kind, 'reactor');
  ctx.run(REACTOR_TIME + 2);
  assert.equal(ctx.last('gameOver').data.reason, 'reactor');

  const fix = started(4, 11);
  freezeNpcs(fix.room);
  const imp2 = imposterOf(fix.room);
  fix.room.sabotageCooldown = 0;
  fix.room.input(imp2.playerId, { type: 'sabotage', kind: 'reactor' });
  const hero = fix.room.seats.find((s) => s.kind === 'player' && s.role === 'crew');
  Object.assign(hero, { x: MAP.REACTOR_PANEL.x, y: MAP.REACTOR_PANEL.y });
  fix.run(sec(3) + 1);
  assert.equal(fix.room.sabotage, null);
  assert.equal(fix.room.started, true);
});

test('lights sabotage is fixed at the Electrical panel; vents move the Imposter along the group', () => {
  const { room } = started(4, 13);
  freezeNpcs(room);
  const imp = imposterOf(room);
  room.sabotageCooldown = 0;
  room.input(imp.playerId, { type: 'sabotage', kind: 'lights' });
  assert.equal(room.sabotage.kind, 'lights');
  const crew = room.seats.find((s) => s.kind === 'player' && s.role === 'crew');
  Object.assign(crew, { x: MAP.LIGHTS_PANEL.x, y: MAP.LIGHTS_PANEL.y });
  room.input(crew.playerId, { type: 'use', what: 'lights' });
  assert.equal(room.sabotage, null);

  const vent = MAP.VENTS[0];
  Object.assign(imp, { x: vent.x, y: vent.y });
  room.input(imp.playerId, { type: 'vent' });
  const group = MAP.VENTS.filter((v) => v.group === vent.group);
  assert.deepEqual([imp.x, imp.y], [group[1].x, group[1].y]);
  room.input(crew.playerId, { type: 'vent' });
  assert.deepEqual([crew.x, crew.y], [MAP.LIGHTS_PANEL.x, MAP.LIGHTS_PANEL.y], 'crewmates cannot vent');
});

// ---------- Joining and leaving mid-round ----------

test('joining mid-round takes over an NPC seat without interrupting anyone', () => {
  const { room, last } = started(2, 15);
  const before = room.seats.filter((s) => s.kind === 'npc').length;
  assert.ok(room.join('late').ok);
  room.announceJoin('late');
  const mine = seat(room, 'late');
  assert.ok(mine);
  assert.equal(mine.role, 'crew');
  assert.equal(room.seats.filter((s) => s.kind === 'npc').length, before - 1);
  assert.equal(room.seats.length, SEATS);
  assert.equal(last('gameStarted', 'late').data.phase, 'play');
  assert.equal(last('you', 'late').data.n, mine.n);
});

test('a player leaving mid-round hands their seat to an NPC (even the Imposter)', () => {
  const { room, run } = started(4, 17);
  const imp = imposterOf(room);
  room.leave(imp.playerId);
  assert.equal(imp.kind, 'npc');
  assert.equal(imp.role, 'imposter');
  assert.ok(imp.npc);
  run(sec(2));
  assert.equal(room.started, true);
});

// ---------- NPCs ----------

test('NPC crewmates walk to their tasks and finish them', () => {
  const { room, run } = started(2, 19);
  run(sec(60));
  const busy = room.seats.filter((s) => s.kind === 'npc' && s.role === 'crew' && s.tasks.some((t) => t.done));
  assert.ok(busy.length >= 3, `NPCs got tasks done (${busy.length})`);
  assert.ok(room.seats.every((s) => MAP.isWalkable(s.x, s.y) || !s.alive), 'nobody walked through walls');
});

test('a dead NPC crewmate keeps doing its tasks as a ghost', () => {
  const { room, run } = started(2, 23);
  const ghost = room.seats.find((s) => s.kind === 'npc' && s.role === 'crew');
  ghost.alive = false;
  ghost.tasks.forEach((t) => { t.done = false; });
  room.bodies = [];
  // Nobody calls meetings in the meantime.
  room.seats.forEach((s) => { if (s !== ghost && s.npc) s.npc.wait = 1e9; });
  room.sabotageCooldown = 1e9;
  run(sec(180));
  assert.ok(ghost.tasks.every((t) => t.done), `ghost finished ${ghost.tasks.filter((t) => t.done).length}/${ghost.tasks.length}`);
});

test('an NPC that sees the kill reports it and votes the killer out', () => {
  const { room, run, imp, victim } = setupKill(4, 21);
  const witness = room.seats.find((s) => s.kind === 'npc' && s.role === 'crew');
  Object.assign(witness, { x: victim.x + 150, y: victim.y });
  witness.npc.wait = 0;
  imp.killCooldown = 0;
  room.input(imp.playerId, { type: 'kill' });
  assert.ok(witness.witnessed.has(imp.n));
  run(sec(3));
  assert.notEqual(room.phase, 'play', 'the witness reported it');
  run(sec(15) + 1);
  room.npcPlanVote(witness);
  assert.equal(witness.npc.voteFor, imp.n);
});

test('holding Shift runs at double speed', () => {
  const { room, run } = started(2, 5);
  freezeNpcs(room);
  const me = seat(room, 'p1');
  Object.assign(me, { x: 1220, y: 160 });
  room.input('p1', { type: 'move', right: true });
  run(4);
  const walked = me.x - 1220;
  Object.assign(me, { x: 1220, y: 160 });
  room.input('p1', { type: 'move', right: true, run: true });
  run(4);
  assert.equal(me.x - 1220, walked * 2);
});

test('bots pile on to the front runner, and suspect whoever they saw near the victim', () => {
  const { room, run } = started(2, 9);
  freezeNpcs(room);
  const crew = room.seats.filter((s) => s.kind === 'npc' && s.role === 'crew');
  const [bot, suspect] = crew;
  bot.seen.set(suspect.n, { tick: room.tick, x: 1000, y: 1000 });
  room.kill(imposterOf(room), Object.assign(crew[2], { x: 1050, y: 1000 }));
  assert.ok(room.npcSuspects(bot).some((x) => x.n === suspect.n), 'seen near the victim');
  room.callMeeting(crew[3], 'emergency');
  run(sec(15) + 1);
  assert.equal(room.phase, 'vote');
  // Three votes against one crewmate: an undecided bot joins in almost every time.
  const target = crew[5];
  [crew[6], crew[7], crew[8]].forEach((s) => room.castVote(s, target.n));
  let joined = 0;
  for (let i = 0; i < 50; i++) if (room.npcDecideVote(crew[9]) === target.n) joined++;
  assert.ok(joined > 35, `joined ${joined}/50`);
});

test('a whole game plays out on its own and ends with a winner', () => {
  for (const seed of [1, 2, 3]) {
    const ctx = makeRoom(seed, { allowSolo: true });
    ctx.room.join('p1');
    ctx.room.start('p1', { solo: true });
    // The one real player just stands still; NPCs play.
    ctx.run(sec(60 * 30));
    const over = ctx.last('gameOver');
    assert.ok(over, `seed ${seed}: the game finished`);
    assert.ok(['crew', 'imposter'].includes(over.data.winner));
    assert.equal(ctx.isRunning(), false);
  }
});

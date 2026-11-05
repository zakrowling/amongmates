// Peer-to-peer networking for Among Mates. No game server is needed:
// - The host's browser runs the authoritative GameRoom from engine.js and registers the PeerJS
//   id `amongmates-v1-<ROOMCODE>`, so the 4-letter room code is all mates need to connect.
// - Joiners open a WebRTC data channel to the host and only send input; the host streams state back.
// - Link rooms (e.g. /amongmates/mate): the first visitor hosts, later visitors join. If the host leaves,
//   the remaining players hand hosting to the next player, so the room lives while anyone is in it.
// The API mirrors the Socket.IO calls client.js used: net.on(event, fn) and net.emit(event, ...args, ack).
(function () {
  const PEER_PREFIX = 'amongmates-v1-';
  const CONNECT_TIMEOUT_MS = 12000;
  const SERVER_UNREACHABLE =
    "Couldn't reach the PeerJS matchmaking server. A work network, VPN or ad blocker may be blocking it.";
  const HOST_UNREACHABLE =
    "Found the room but couldn't connect to the host. A firewall or VPN may be blocking peer-to-peer connections.";
  const ENTER_ROOM_DEADLINE_MS = 45000; // a crashed host's ID can stay reserved on the PeerJS server for a while
  const HANDOVER_STAGGER_MS = 1500;
  // A link room whose host can't be reached (a crashed or frozen tab still holding the name, or a host
  // on a network nobody can connect to) would block the name. Instead everyone falls through, in the
  // same order, to backup rooms NAME_2, NAME_3... ('_' can't appear in typed room names, so these never
  // clash with a real room). Players still see the room as NAME.
  const MAX_ROOM_SLOTS = 4;
  const slotCode = (code, slot) => (slot > 1 ? `${code}_${slot}` : code);
  const splitSlot = (peerCode) => {
    const m = /^(.*)_(\d+)$/.exec(peerCode);
    return m ? [m[1], Number(m[2])] : [peerCode, 1];
  };
  const ROOM_NAME_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,14}[A-Z0-9])$/;

  // ICE servers: Google STUN for direct connections, plus TURN relays from config.js when configured.
  let iceServersPromise = null;
  function getIceServers() {
    if (iceServersPromise) return iceServersPromise;
    iceServersPromise = (async () => {
      const stun = [{ urls: 'stun:stun.l.google.com:19302' }];
      const url = (window.AMONGMATES_CONFIG || {}).turnCredentialsUrl;
      if (!url) return stun;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        const relays = await res.json();
        return Array.isArray(relays) ? [...stun, ...relays] : stun;
      } catch (err) {
        console.warn('Relay (TURN) credentials unavailable; using direct connections only.', err);
        return stun;
      }
    })();
    return iceServersPromise;
  }
  let iceServers = null;
  const peerOptions = () => ({ debug: 0, config: { iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] } });

  function normaliseRoomName(name) {
    const upper = String(name || '').trim().toUpperCase();
    return ROOM_NAME_RE.test(upper) ? upper : null;
  }
  const { GameRoom, generateRoomCode } = window.AmongmatesEngine;

  // Browsers throttle timers in background tabs to ~1/s; a worker timer keeps the host's game loop at full speed.
  function createTicker() {
    try {
      const src = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      let callback = null;
      worker.onmessage = () => callback && callback();
      return {
        setInterval(fn, ms) { callback = fn; worker.postMessage(ms); return 1; },
        clearInterval() { callback = null; worker.postMessage(0); },
        stop() { worker.terminate(); },
      };
    } catch {
      return {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
        stop() {},
      };
    }
  }

  function createNet() {
    const handlers = {};
    let mode = null; // 'host' | 'client' | null
    let peer = null;
    let room = null;
    let ticker = null;
    let hostConn = null;
    let localId = null;
    let lastLobby = null; // client only: latest lobby, used to decide who takes over hosting
    const conns = new Map(); // host only: playerId -> DataConnection

    function dispatch(ev, data) {
      (handlers[ev] || []).forEach((fn) => fn(data));
    }

    function teardown() {
      const old = { peer, room, ticker, hostConn, conns: [...conns.values()] };
      mode = null;
      peer = null;
      room = null;
      ticker = null;
      hostConn = null;
      localId = null;
      lastLobby = null;
      conns.clear();
      if (old.room) old.room.destroy();
      if (old.ticker) old.ticker.stop();
      old.conns.forEach((c) => c.close());
      if (old.hostConn) old.hostConn.close();
      if (old.peer) old.peer.destroy();
    }

    // ---------- Host ----------

    // The host's own view gets a copy so the UI never mutates engine state.
    function deliverLocal(ev, data) {
      dispatch(ev, typeof structuredClone === 'function' ? structuredClone(data) : JSON.parse(JSON.stringify(data)));
    }

    function hostSend(id, ev, data) {
      if (id === localId) return deliverLocal(ev, data);
      const conn = conns.get(id);
      if (conn && conn.open) conn.send({ ev, data });
    }

    function hostBroadcast(ev, data) {
      deliverLocal(ev, data);
      conns.forEach((conn) => { if (conn.open) conn.send({ ev, data }); });
    }

    function acceptConnection(conn) {
      conn.on('data', (msg) => {
        if (!room || !msg || typeof msg !== 'object') return;
        const id = conn.peer;
        if (msg.ev === 'joinRoom') {
          const res = room.join(id, typeof msg.name === 'string' ? msg.name : undefined);
          conn.send({ ack: msg.ack, res: res.ok ? { ok: true, ...res.payload } : res });
          if (res.ok) {
            conns.set(id, conn);
            room.announceJoin(id);
          } else {
            setTimeout(() => conn.close(), 500);
          }
          return;
        }
        if (!conns.has(id)) return;
        const args = Array.isArray(msg.args) ? msg.args : [];
        if (msg.ev === 'startGame') room.start(id, args[0]);
        else if (msg.ev === 'input') room.input(id, args[0]);
        else if (msg.ev === 'leaveRoom') conn.close();
      });
      conn.on('close', () => {
        if (conns.get(conn.peer) !== conn) return;
        conns.delete(conn.peer);
        if (room) room.leave(conn.peer);
      });
      conn.on('error', (err) => console.warn('Player connection error', err));
    }

    function createRoom(ack, attempt = 0, fixedCode = null, preferredName) {
      teardown();
      const code = fixedCode || generateRoomCode();
      dispatch('status', fixedCode ? 'Opening the room...' : 'Connecting to the matchmaking server...');
      const p = new Peer(PEER_PREFIX + code, peerOptions());
      peer = p;
      const timer = setTimeout(() => {
        if (peer !== p || mode === 'host') return;
        teardown();
        ack({ ok: false, error: SERVER_UNREACHABLE });
      }, CONNECT_TIMEOUT_MS);

      p.on('open', (id) => {
        if (peer !== p) return;
        clearTimeout(timer);
        mode = 'host';
        localId = id;
        ticker = createTicker();
        room = new GameRoom(splitSlot(code)[0], {
          broadcast: hostBroadcast,
          send: hostSend,
          setInterval: ticker.setInterval,
          clearInterval: ticker.clearInterval,
          // ?debug lets one person start a round on their own, for testing.
          allowSolo: /[?&]debug\b/.test(location.search),
        });
        const res = room.join(localId, preferredName);
        ack({ ok: true, ...res.payload });
        room.announceJoin(localId);
      });
      p.on('connection', acceptConnection);
      // Losing the signalling server doesn't drop existing players; reconnect so new mates can still join.
      p.on('disconnected', () => { if (peer === p && !p.destroyed) p.reconnect(); });
      p.on('error', (err) => {
        if (peer !== p) return;
        if (mode === 'host') return console.warn('PeerJS error', err);
        clearTimeout(timer);
        if (err.type === 'unavailable-id') {
          if (fixedCode) {
            teardown();
            return ack({ ok: false, taken: true, error: 'That room is busy. Try again in a moment.' });
          }
          if (attempt < 5) return createRoom(ack, attempt + 1, null, preferredName);
        }
        teardown();
        const unreachable = ['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type);
        ack({ ok: false, error: unreachable ? SERVER_UNREACHABLE : `Couldn't create a room (${err.type || err.message}).` });
      });
    }

    // ---------- Client ----------

    function joinRoom(code, ack, preferredName) {
      teardown();
      let settled = false;
      let stage = 'server'; // 'server' until PeerJS opens, then 'host' until the host answers
      dispatch('status', 'Connecting to the matchmaking server...');
      const p = new Peer(peerOptions());
      peer = p;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!res.ok) teardown();
        ack(res);
      };
      const timer = setTimeout(
        () => finish({ ok: false, timeout: stage, error: stage === 'server' ? SERVER_UNREACHABLE : HOST_UNREACHABLE }),
        CONNECT_TIMEOUT_MS,
      );

      p.on('open', () => {
        if (peer !== p) return;
        stage = 'host';
        dispatch('status', 'Looking for the room...');
        const conn = p.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        hostConn = conn;
        conn.on('open', () => {
          dispatch('status', 'Joining...');
          conn.send({ ev: 'joinRoom', ack: 1, name: preferredName });
        });
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.ack) {
            if (msg.res && msg.res.ok) {
              mode = 'client';
              localId = p.id;
              lastLobby = msg.res;
            }
            return finish(msg.res || { ok: false, error: 'Unexpected reply from host.' });
          }
          if (!msg.ev || mode !== 'client') return;
          if (msg.ev === 'lobbyUpdate' || msg.ev === 'gameStarted') lastLobby = msg.data;
          dispatch(msg.ev, msg.data);
        });
        conn.on('close', () => {
          if (hostConn !== conn) return;
          if (mode === 'client') return handOver(code);
          teardown();
          finish({ ok: false, error: 'The host closed the connection.' });
        });
      });
      p.on('error', (err) => {
        if (peer !== p) return;
        if (err.type === 'peer-unavailable') return finish({ ok: false, notFound: true, error: 'Room not found!' });
        if (mode === 'client') return handOver(code);
        const unreachable = ['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type);
        finish({ ok: false, error: unreachable ? SERVER_UNREACHABLE : `Couldn't connect (${err.type || err.message}).` });
      });
    }

    // ---------- Link rooms and host handover ----------

    // Join the room if someone is hosting it, otherwise become its host. If the room's host can't be
    // reached, move on to the next backup slot rather than giving up.
    function enterRoom(code, ack, preferredName, deadline = Date.now() + ENTER_ROOM_DEADLINE_MS, slot = 1) {
      const peerCode = slotCode(code, slot);
      const nextSlot = () => {
        if (slot >= MAX_ROOM_SLOTS) return ack({ ok: false, error: HOST_UNREACHABLE });
        dispatch('status', "Couldn't reach the room's host. Opening a backup room...");
        enterRoom(code, ack, preferredName, Date.now() + ENTER_ROOM_DEADLINE_MS, slot + 1);
      };
      joinRoom(peerCode, (res) => {
        // Success, a real refusal (e.g. full), or PeerJS itself unreachable: nothing more to try.
        if (res.ok || res.timeout === 'server' || !(res.notFound || res.timeout)) return ack(res);
        // Someone holds this slot but we can't reach them: skip it.
        if (res.timeout === 'host') return nextSlot();
        createRoom((hostRes) => {
          if (hostRes.ok || !hostRes.taken) return ack(hostRes);
          if (Date.now() > deadline) return nextSlot();
          // Someone else claimed the room at the same moment; join them instead.
          dispatch('status', 'Someone just opened the room. Joining them...');
          setTimeout(() => enterRoom(code, ack, preferredName, deadline, slot), 800 + Math.random() * 700);
        }, 0, peerCode, preferredName);
      }, preferredName);
    }

    // The host left: the lowest-numbered remaining player re-hosts first and everyone else rejoins them.
    function handOver(code) {
      const me = localId;
      const lobby = lastLobby;
      teardown();
      const others = ((lobby && lobby.players) || [])
        .filter((p) => p.id !== lobby.hostId)
        .sort((a, b) => a.number - b.number);
      const rank = Math.max(0, others.findIndex((p) => p.id === me));
      const myName = (((lobby && lobby.players) || []).find((p) => p.id === me) || {}).name;
      dispatch('reconnecting', 'The host left. Reconnecting...');
      const [base, slot] = splitSlot(code);
      setTimeout(() => {
        enterRoom(base, (res) => {
          if (res.ok) dispatch('rejoined', res);
          else dispatch('disconnect', res.error || 'The room has closed.');
        }, myName, undefined, slot);
      }, rank * HANDOVER_STAGGER_MS + Math.random() * 300);
    }

    // ---------- Public API ----------

    function emit(ev, ...args) {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      // Connecting needs the relay settings first (fetched once, usually before anyone clicks).
      if (!iceServers && (ev === 'createRoom' || ev === 'joinRoom' || ev === 'enterRoom')) {
        return getIceServers().then((servers) => {
          iceServers = servers;
          emit(ev, ...args, ack);
        });
      }
      if (ev === 'createRoom') return createRoom(ack);
      if (ev === 'joinRoom') return joinRoom(String(args[0] || '').trim().toUpperCase(), ack);
      if (ev === 'enterRoom') {
        const name = normaliseRoomName(args[0]);
        if (!name) return ack({ ok: false, error: 'Room names are 2-16 letters, numbers or dashes.' });
        return enterRoom(name, ack);
      }
      if (ev === 'leaveRoom') return teardown();

      if (mode === 'host' && room) {
        if (ev === 'startGame') room.start(localId, args[0]);
        else if (ev === 'input') room.input(localId, args[0]);
      } else if (mode === 'client' && hostConn && hostConn.open) {
        hostConn.send({ ev, args });
      }
    }

    window.addEventListener('pagehide', teardown);

    return {
      on(ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
      },
      emit,
      get isHost() {
        return mode === 'host';
      },
    };
  }

  getIceServers().then((servers) => { iceServers = servers; });

  window.AmongmatesNet = { createNet, normaliseRoomName };
})();

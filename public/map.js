// The Among Mates spaceship: rooms joined by corridors, plus task stations, vents and the
// emergency button. Shared by the host's engine, every player's renderer and the Node tests.
// The walkable area is the union of the room and corridor rectangles; walls are drawn around it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AmongmatesMap = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const WIDTH = 2400;
  const HEIGHT = 1460;
  const WALL = 10; // wall thickness inside each rectangle's edge

  // [id, label, x0, y0, x1, y1, floor colour]
  const ROOMS = [
    ['upperEngine', 'Upper Engine', 120, 120, 460, 420, '#4a5468'],
    ['reactor', 'Reactor', 40, 560, 330, 880, '#4f4a68'],
    ['lowerEngine', 'Lower Engine', 120, 1020, 460, 1320, '#4a5468'],
    ['security', 'Security', 470, 560, 690, 820, '#4d5a5a'],
    ['medbay', 'MedBay', 620, 250, 880, 530, '#4a6466'],
    ['cafeteria', 'Cafeteria', 960, 80, 1480, 560, '#5b6475'],
    ['weapons', 'Weapons', 1720, 100, 2060, 400, '#535a6e'],
    ['o2', 'O2', 1640, 560, 1880, 760, '#4a6458'],
    ['navigation', 'Navigation', 2060, 580, 2360, 900, '#4b5670'],
    ['shields', 'Shields', 1800, 1040, 2200, 1340, '#565472'],
    ['comms', 'Communications', 1360, 1140, 1640, 1400, '#4e566a'],
    ['storage', 'Storage', 960, 820, 1340, 1300, '#5a5a52'],
    ['admin', 'Admin', 1440, 640, 1700, 900, '#56506a'],
    ['electrical', 'Electrical', 620, 940, 880, 1200, '#5a5446'],
  ].map(([id, label, x0, y0, x1, y1, floor]) => ({ id, label, x0, y0, x1, y1, floor }));

  // Corridors overlap the rooms they join, so the walkable area is continuous.
  const CORRIDORS = [
    [420, 180, 1000, 290], // Upper Engine - MedBay - Cafeteria
    [220, 380, 330, 1060], // Upper Engine - Reactor - Lower Engine
    [300, 640, 510, 750], // Reactor corridor - Security
    [420, 1100, 1000, 1210], // Lower Engine - Electrical - Storage
    [1160, 520, 1270, 860], // Cafeteria - Storage
    [1440, 190, 1760, 300], // Cafeteria - Weapons
    [1900, 360, 2010, 720], // Weapons - O2/Navigation
    [1840, 620, 2100, 720], // O2 - Navigation
    [2100, 860, 2210, 1080], // Navigation - Shields
    [1600, 1180, 1840, 1290], // Shields - Communications
    [1300, 1180, 1400, 1290], // Storage - Communications
    [1300, 820, 1480, 930], // Storage - Admin
  ].map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }));

  const AREAS = [...ROOMS, ...CORRIDORS];

  // Crewmate tasks. type picks the mini-game: wires, swipe, download, shields (click targets) or hold.
  const STATIONS = [
    ['elecWires', 'Fix Wiring', 'wires', 'electrical', 690, 1000],
    ['storageWires', 'Fix Wiring', 'wires', 'storage', 1020, 880],
    ['adminWires', 'Fix Wiring', 'wires', 'admin', 1640, 700],
    ['adminSwipe', 'Swipe Card', 'swipe', 'admin', 1500, 850],
    ['cafDownload', 'Download Data', 'download', 'cafeteria', 1420, 140],
    ['commsUpload', 'Upload Data', 'download', 'comms', 1580, 1200],
    ['navDownload', 'Download Data', 'download', 'navigation', 2300, 650],
    ['shieldsPrime', 'Prime Shields', 'shields', 'shields', 2140, 1280],
    ['weaponsAsteroids', 'Clear Asteroids', 'shields', 'weapons', 2000, 160],
    ['upperFuel', 'Fuel Engine', 'hold', 'upperEngine', 180, 180],
    ['lowerFuel', 'Fuel Engine', 'hold', 'lowerEngine', 180, 1260],
    ['o2Garbage', 'Empty Garbage', 'hold', 'o2', 1820, 620],
    ['storageGarbage', 'Empty Garbage', 'hold', 'storage', 1280, 1240],
    ['medScan', 'Submit Scan', 'hold', 'medbay', 700, 470],
  ].map(([id, label, type, room, x, y]) => ({ id, label, type, room, x, y }));

  const EMERGENCY_BUTTON = { x: 1220, y: 320 };
  const LIGHTS_PANEL = { x: 830, y: 1000, room: 'electrical' };
  const REACTOR_PANEL = { x: 90, y: 720, room: 'reactor' };

  // Vents in the same group are joined: the Imposter hops along the group in order.
  const VENTS = [
    ['ueVent', 'A', 410, 370],
    ['reactorVent', 'A', 90, 620],
    ['leVent', 'A', 410, 1070],
    ['medVent', 'B', 830, 480],
    ['secVent', 'B', 640, 770],
    ['elecVent', 'B', 830, 1150],
    ['cafVent', 'C', 1430, 510],
    ['adminVent', 'C', 1650, 850],
    ['weaponsVent', 'D', 1770, 360],
    ['navVent', 'D', 2310, 850],
    ['shieldsVent', 'D', 1850, 1090],
  ].map(([id, group, x, y]) => ({ id, group, x, y }));

  // Everyone starts in a ring around the Cafeteria table.
  const SPAWNS = Array.from({ length: 15 }, (_, i) => {
    const a = (i / 15) * Math.PI * 2 - Math.PI / 2;
    return { x: Math.round(EMERGENCY_BUTTON.x + Math.cos(a) * 160), y: Math.round(EMERGENCY_BUTTON.y + Math.sin(a) * 150) };
  });

  const inside = (a, x, y) => x >= a.x0 + WALL && x <= a.x1 - WALL && y >= a.y0 + WALL && y <= a.y1 - WALL;
  const pointWalkable = (x, y) => AREAS.some((a) => inside(a, x, y));

  // Can a crewmate (feet at x, y, radius r) stand here?
  function isWalkable(x, y, r = 12) {
    return pointWalkable(x, y) && pointWalkable(x - r, y) && pointWalkable(x + r, y)
      && pointWalkable(x, y - r * 0.5) && pointWalkable(x, y + r * 0.5);
  }

  function roomAt(x, y) {
    const room = ROOMS.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    return room ? room.label : 'Hallway';
  }

  // ---------- Paths for NPCs (grid search over the walkable area) ----------

  const CELL = 20;
  const COLS = Math.ceil(WIDTH / CELL);
  const ROWS = Math.ceil(HEIGHT / CELL);
  let grid = null;
  function navGrid() {
    if (grid) return grid;
    grid = new Uint8Array(COLS * ROWS);
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (isWalkable(cx * CELL + CELL / 2, cy * CELL + CELL / 2, 14)) grid[cy * COLS + cx] = 1;
      }
    }
    return grid;
  }

  function nearestOpenCell(x, y) {
    const g = navGrid();
    const cx0 = Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL)));
    const cy0 = Math.max(0, Math.min(ROWS - 1, Math.floor(y / CELL)));
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = cx0 + dx;
          const cy = cy0 + dy;
          if (cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS && g[cy * COLS + cx]) return cy * COLS + cx;
        }
      }
    }
    return -1;
  }

  // Waypoints (cell centres) from one point to another, or null if there's no way through.
  function findPath(from, to) {
    const g = navGrid();
    const start = nearestOpenCell(from.x, from.y);
    const goal = nearestOpenCell(to.x, to.y);
    if (start < 0 || goal < 0) return null;
    const prev = new Int32Array(COLS * ROWS).fill(-1);
    prev[start] = start;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      if (c === goal) break;
      const cx = c % COLS;
      const cy = (c - cx) / COLS;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const n = ny * COLS + nx;
        if (!g[n] || prev[n] !== -1) continue;
        prev[n] = c;
        queue.push(n);
      }
    }
    if (prev[goal] === -1) return null;
    const cells = [];
    for (let c = goal; c !== start; c = prev[c]) cells.push(c);
    cells.reverse();
    // Keep only the corners, so NPCs walk in straight lines.
    const points = [];
    let lastDir = null;
    cells.forEach((c, i) => {
      const next = cells[i + 1];
      const dir = next === undefined ? null : next - c;
      if (dir !== lastDir || next === undefined) points.push({ x: (c % COLS) * CELL + CELL / 2, y: Math.floor(c / COLS) * CELL + CELL / 2 });
      lastDir = dir;
    });
    points.push({ x: to.x, y: to.y });
    return points;
  }

  return {
    WIDTH, HEIGHT, WALL, ROOMS, CORRIDORS, AREAS, STATIONS, EMERGENCY_BUTTON, LIGHTS_PANEL, REACTOR_PANEL,
    VENTS, SPAWNS, isWalkable, roomAt, findPath, CELL,
  };
});

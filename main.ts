// Sokoban solver: push-optimal, room by room.
//
// Strategy
// --------
// Generated levels are a 1-wide hallway with 1-4 rooms off it (3-4 boxes and
// as many goals per room). A box pushed into the hallway can never come back,
// so every box stays in its room and the level's push-optimum P* is the sum of
// the rooms' optima. We therefore
//   1. cut the hallway's dead squares out of the floor and flood-fill the rest
//      to find the rooms,
//   2. solve each room push-optimally with a breadth-first search over pushes
//      (one BFS layer = one more push, so the first solved state found is
//      push-optimal), pruning dead squares and frozen 2x2 blocks,
//   3. stitch the rooms together, walking the player through the hallway
//      between doors, and replay-verify every solution before writing it.
//
// Determinism: no clock reads, no randomness, fixed iteration order everywhere.
// The search budget is counted in states, never in time, so two runs produce
// byte-identical output.
//
// Local run:
//   MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/sokoban-out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (states expanded), never the clock.
const ROOM_MAX_STATES = 250_000;
const WHOLE_MAX_STATES = 300_000;
const MOVE_ASTAR_MAX = 100_000;
// Global cap across the whole run, so a pathological set cannot eat the 60 s wall.
const GLOBAL_MAX_STATES = 2_000_000;

let globalStates = 0;

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goals: number[];
  boxes: number[]; // sorted
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Squares from which a box can be pushed onto some goal, found by pulling a
// box back from the goals over open floor (ignoring other boxes). A box on any
// other square is dead: it can never reach a goal.
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d; // square the box is pulled back to
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood-fill the player's reachable region with `occupied` boxes in the way.
// `seen`/`stamp` mark the region; returns the region's lowest square, which
// names the region (two states with the same boxes and the same reachable
// region are the same state whatever square the player stands on).
function reachRegion(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const nb = [p - w, p + w, p - 1, p + 1];
    for (const q of nb) {
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and
// boxes with a box off its goal: no push can ever move a box out of it.
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// Shortest walk from `from` to `to` around walls and boxes, as lowercase move
// letters. Throws if unreachable (callers only ask for reachable squares).
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target unreachable');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p] + s;
  return s;
}

function endOfWalk(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// Push-optimal BFS for one (sub-)level: states are box positions + the
// player's reachable region; each transition is one push. The queue is in
// push order, so the first solved state dequeued is push-optimal.
// Returns { pushes, moves } or null if the state budget runs out / unsolvable.
function solvePushOptimal(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Numeric state key: region-low in base `size`, then each box. Exact while
  // size ** (boxes + 1) < 2 ** 53, which holds for rooms (<= 5 boxes); fall
  // back to a string key for larger box counts (whole-level fallback).
  const useNumeric = level.boxes.length <= 5;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!useNumeric) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1]; // box square before the push that made this state
  const pushTo: number[] = [-1]; // box square after it
  const index = new Map<number | string, number>();

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reachRegion(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow), 0);

  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    if (globalStates >= GLOBAL_MAX_STATES) return null;
    const boxes = statesBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    reachRegion(level, occupied, statesPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // Player must be able to stand on the pushing square (b - d), the
        // target must be free floor and a live square.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reachRegion(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        globalStates++;
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(b); // after the push the player stands on b
        parent.push(head);
        pushFrom.push(b);
        pushTo.push(t);
        if (solved(next!)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Reconstruct: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[2];
    player = from;
    boxes = statesBoxes[s]!.slice();
  }
  return { pushes: path.length, moves };
}

// Move-based A* (fewest moves, not fewest pushes) as a last-resort fallback:
// any solved level still scores 500 * P* / pushes > 0. Same shape as a plain
// A* over steps, with a nearest-goal Manhattan estimate.
function solveMoveAStar(level: Level, maxExpansions: number): string | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = (b: number): number =>
    Math.min(...goals.map((g) => Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w))));
  const est = (bs: number[]): number => bs.reduce((a, b) => a + dist(b), 0);
  const key = (p: number, bs: number[]): string => `${p}:${bs.join(',')}`;

  const sp: number[] = [level.player];
  const sb: number[][] = [level.boxes.slice()];
  const sg: number[] = [0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const best = new Map<string, number>([[key(level.player, level.boxes), 0]]);
  const heap: [number, number, number][] = [[est(level.boxes), 0, 0]];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  while (heap.length > 0 && expanded < maxExpansions && globalStates < GLOBAL_MAX_STATES) {
    const [, g, s] = heapPop();
    if (best.get(key(sp[s]!, sb[s]!)) !== s) continue;
    const bs = sb[s]!;
    if (bs.every((b) => goal[b])) {
      let moves = '';
      for (let t = s; t > 0; t = parent[t]!) moves = step[t] + moves;
      return moves;
    }
    expanded++;
    globalStates++;
    const p = sp[s]!;
    for (const [dx, dy, letter] of DIRS) {
      const d = dy * w + dx;
      const q = p + d;
      if (wall[q]) continue;
      let nb = bs;
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (wall[q + d] || bs.includes(q + d)) continue;
        nb = bs.slice();
        nb[at] = q + d;
        nb.sort((a, b) => a - b);
      }
      const k = key(q, nb);
      const seenIdx = best.get(k);
      if (seenIdx !== undefined && sg[seenIdx]! <= g + 1) continue;
      const t = sp.length;
      sp.push(q);
      sb.push(nb);
      sg.push(g + 1);
      parent.push(s);
      step.push(letter);
      best.set(k, t);
      heapPush([g + 1 + est(nb), g + 1, t]);
    }
  }
  return null;
}

// The level's rooms: cut the dead squares of the player's row (the hallway:
// a box there reaches no goal) out of the floor, and each remaining part that
// holds a box is a room. Null when a box starts in the hallway, a goal lies
// outside every part, or some part holds a different number of boxes and goals.
interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve one level room by room in the given room order. Other rooms' boxes
// stand as walls (on their goals once their room is done); the player walks
// on from where the last room left it. Returns null if any room fails.
function solveRoomsInOrder(level: Level, rooms: Room[], order: number[]): { pushes: number; moves: string } | null {
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done = new Set<number>();
  for (const ri of order) {
    const room = rooms[ri]!;
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const other = rooms[oj]!;
      for (const b of done.has(oj) ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, ROOM_MAX_STATES);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOfWalk(level.w, player, solved.moves);
    done.add(ri);
  }
  return { pushes, moves };
}

// Solve one whole level: rooms in scan order, then reversed order (in case a
// room's exit gets blocked by an earlier room's finished boxes), then a
// whole-level push BFS, then a move-based A* for any solution at all.
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms !== null && rooms.length > 0) {
    const orders: number[][] = [rooms.map((_, i) => i)];
    if (rooms.length > 1) orders.push(rooms.map((_, i) => rooms.length - 1 - i));
    for (const order of orders) {
      const solved = solveRoomsInOrder(level, rooms, order);
      if (solved !== null && verify(level, solved.moves)) return solved.moves;
    }
  }
  const whole = solvePushOptimal(level, WHOLE_MAX_STATES);
  if (whole !== null && verify(level, whole.moves)) return whole.moves;
  const any = solveMoveAStar(level, MOVE_ASTAR_MAX);
  if (any !== null && verify(level, any)) return any;
  return '';
}

// Replay-verify a move string on the level: every step legal, every box on a
// goal at the end. Returns false for an empty string on an unsolved level.
function verify(level: Level, moves: string): boolean {
  const { w, wall, goals } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  let pushed = false;
  for (const ch of moves) {
    const dir = DIRS.find(([, , letter]) => letter === ch.toLowerCase());
    if (!dir) return false;
    const d = dir[1] * w + dir[0];
    const next = player + d;
    if (wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
      pushed = true;
    }
    player = next;
  }
  if (!pushed && level.boxes.length > 0) {
    // Empty (or push-free) answer only counts if the level starts solved.
    if (!level.boxes.every((b) => goal[b])) return false;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return false;
  return true;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const level = parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  const moves = solveLevel(level);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}

# Sokoban Solver — push-optimal, room by room

A solver for make.fun's `sokoban-solver-01` competition. It answers a whole
set of 5 levels in one run (`node main.ts`, Node 22, no dependencies, no
network) and writes `solution.txt` per instance.

## How it works

Generated levels are a 1-wide hallway with 1–4 rooms off it (3–4 boxes and as
many goals per room). A box pushed into the hallway can never come back, so
every box stays in its room and the level's push-optimum P\* is the sum of the
rooms' optima. The solver exploits that:

1. **Find the rooms.** Cut the hallway's dead squares (squares a box can never
   be pushed to a goal from) out of the floor and flood-fill the rest; each
   part holding boxes is a room.
2. **Solve each room push-optimally.** Breadth-first search over *pushes*
   (one BFS layer = one more push, so the first solved state found is
   push-optimal). A state is the box positions plus the player's reachable
   region; pruning drops dead squares (computed by pulling a box back from
   the goals) and frozen 2×2 blocks of walls/boxes. Other rooms' boxes stand
   as walls while a room is solved.
3. **Stitch.** The player walks through the hallway between doors (shortest
   walks); each push is expanded into the walk to the pushing square plus the
   push step. Rooms are tried in scan order, then reversed order.
4. **Verify.** Every solution is replayed on the full level before it is
   written; an unverified solution is never emitted.

Fallbacks, in order, if a room's search fails: a whole-level push BFS, then a
move-based A\* for any solution at all (a non-optimal solution still scores).
If everything fails the level gets an empty (valid, 0-point) answer rather
than an illegal one.

Determinism: no clock reads, no randomness, fixed iteration order; all search
budgets are counted in states, never in time — two runs produce byte-identical
output.

## Results

- Practice set: **score 1,000,000** — all 5 instances at exactly P\*
  (i001 13, i002 16, i003 29, i004 47, i005 60 pushes), ~1 s for the set.
- Three freshly drawn sets (generator seeds never seen during development):
  **1,000,000 each**, every instance exactly at P\*, 0.6–0.8 s per set.

## Files

- `main.ts` — the whole solver (entry point, run as `node main.ts`).
- `LICENSE` — MIT (starter licence).

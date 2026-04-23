import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Facing } from '../utils/characterImageLoader';
import { canAgentStandAt, resolveAgentMove, type MasksApi } from '../utils/agentCollision';
import type { RoomState } from './useGrid';
import type { Agent, UseAgentsApi } from './useAgents';

/**
 * Autonomous wander engine for agents.
 *
 * Drives every agent with `autonomous === true` through a simple per-agent
 * state machine — walking in a chosen direction for a random window, then
 * idling, then re-rolling a direction with "momentum" (most of the time the
 * agent keeps going the same way, occasionally it turns). Collision is
 * handled via the same `resolveAgentMove` the WASD loop uses, so agents
 * slide along walls and respect pixel-accurate masks.
 *
 * Orthogonal to the WASD loop: the two only interact through the agents'
 * public `row` / `col` / `facing` / `animFrame` state. When the user pauses
 * an agent (hover, click, terminal-open, WASD), this hook leaves it alone
 * entirely — no frames get produced for it until `resumeAgent` is called.
 *
 * Takeover timer: any keypress-driven takeover calls `kickTakeoverTimer` on
 * every frame the user is driving; when the user stops, a grace window
 * elapses and wandering resumes from wherever the agent ended up.
 */

const WANDER_SPEED = 1.6;
const WALK_MIN_MS = 3000;
const WALK_MAX_MS = 10000;
const IDLE_MIN_MS = 2000;
const IDLE_MAX_MS = 5000;
const TURN_PROBABILITY = 0.3;
const FACINGS: Facing[] = ['down', 'left', 'right', 'up'];

const DIR_VEC: Record<Facing, { dr: number; dc: number }> = {
  up: { dr: -1, dc: 0 },
  down: { dr: 1, dc: 0 },
  left: { dr: 0, dc: -1 },
  right: { dr: 0, dc: 1 },
};

interface WanderState {
  mode: 'walking' | 'idle';
  facing: Facing;
  modeEndsAt: number;
  stuckFrames: number;
  paused: boolean;
  resumeAt: number;
  animClock: number;
}

export interface UseWanderLoopApi {
  /** Halt wandering for `agentId` until `resumeAgent` is called. Idempotent. */
  pauseAgent: (agentId: string) => void;
  /** Schedule wandering to resume after `delayMs` (0 = immediately). */
  resumeAgent: (agentId: string, delayMs?: number) => void;
  /** Mark the agent paused and bump the auto-resume clock to `now + graceMs`.
   *  Call this on every WASD frame so the timer keeps refreshing. */
  kickTakeoverTimer: (agentId: string, graceMs?: number) => void;
}

export interface UseWanderLoopDeps {
  agentsApi: UseAgentsApi;
  roomRef: { current: RoomState };
  masksRef: { current: MasksApi };
  /** Only runs while this ref evaluates truthy — typically `activeTab === 'live'`. */
  enabledRef: { current: boolean };
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickRandomFacing(exclude?: Facing): Facing {
  if (!exclude) return FACINGS[Math.floor(Math.random() * FACINGS.length)];
  const options = FACINGS.filter((f) => f !== exclude);
  return options[Math.floor(Math.random() * options.length)];
}

export function useWanderLoop(deps: UseWanderLoopDeps): UseWanderLoopApi {
  const { agentsApi, roomRef, masksRef, enabledRef } = deps;

  // Stable refs so the RAF callback never closes over stale props.
  const agentsApiRef = useRef(agentsApi);
  agentsApiRef.current = agentsApi;

  const statesRef = useRef<Map<string, WanderState>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  // ── Public API (stable identities so consumers can safely use them
  //    inside useEffect deps) ───────────────────────────────────────────────
  const pauseAgent = useCallback((agentId: string) => {
    const states = statesRef.current;
    const s = states.get(agentId);
    const wasActive = !!s && !s.paused;
    if (s) {
      s.paused = true;
      s.resumeAt = Number.POSITIVE_INFINITY;
    } else {
      states.set(agentId, {
        mode: 'idle',
        facing: 'down',
        modeEndsAt: performance.now(),
        stuckFrames: 0,
        paused: true,
        resumeAt: Number.POSITIVE_INFINITY,
        animClock: 0,
      });
    }
    // Snap to idle frame **once**, at the pause transition. Doing this
    // every RAF (as we used to) races with any external driver that sets
    // animFrame on the same agent — most visibly the WASD loop, which
    // cycles 0→1→2→1 at 6 Hz. Per-frame reset-to-1 collapsed that cycle
    // into a 60 Hz flicker between the WASD value and 1, making the
    // sprite look jittery / absurdly fast. One-shot reset gives us the
    // "clean mid-stride freeze" for hover pauses without racing anyone.
    if (wasActive) {
      agentsApiRef.current.setAnimFrame(agentId, 1);
    }
  }, []);

  const resumeAgent = useCallback((agentId: string, delayMs = 0) => {
    const s = statesRef.current.get(agentId);
    if (!s) return;
    s.resumeAt = performance.now() + Math.max(0, delayMs);
    // `paused` flag clears inside the frame loop once `resumeAt` fires, so
    // an outside caller can't accidentally un-pause during an in-flight
    // action (kickTakeoverTimer would be racing with resumeAgent otherwise).
  }, []);

  const kickTakeoverTimer = useCallback((agentId: string, graceMs = 5000) => {
    const states = statesRef.current;
    let s = states.get(agentId);
    if (!s) {
      s = {
        mode: 'idle',
        facing: 'down',
        modeEndsAt: performance.now(),
        stuckFrames: 0,
        paused: true,
        resumeAt: performance.now() + graceMs,
        animClock: 0,
      };
      states.set(agentId, s);
      return;
    }
    s.paused = true;
    s.resumeAt = performance.now() + graceMs;
    // Intentionally does NOT touch animFrame — the takeover path exists
    // because an external driver (WASD loop) is about to start writing
    // to it, and racing that driver is exactly the jitter bug we're
    // trying to avoid. Whoever kicked us owns the animation.
  }, []);

  const api = useMemo<UseWanderLoopApi>(
    () => ({ pauseAgent, resumeAgent, kickTakeoverTimer }),
    [pauseAgent, resumeAgent, kickTakeoverTimer]
  );

  // ── RAF frame ───────────────────────────────────────────────────────────
  useEffect(() => {
    const step = (now: number) => {
      const prev = lastFrameRef.current || now;
      const dt = Math.min(0.1, (now - prev) / 1000);
      lastFrameRef.current = now;

      const enabled = enabledRef.current;
      const api = agentsApiRef.current;
      const room = roomRef.current;
      const masks = masksRef.current;
      const states = statesRef.current;

      // Drop state entries for agents that no longer exist (e.g. removed
      // via the agent context menu). Without this the map would leak.
      const validIds = new Set(api.agents.map((a) => a.id));
      for (const id of states.keys()) {
        if (!validIds.has(id)) states.delete(id);
      }

      if (enabled) {
        for (const agent of api.agents) {
          processAgent(agent, now, dt, states, api, room, masks);
        }
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);

    const onVisibility = () => {
      if (document.hidden) {
        // Freeze all animation clocks when the tab hides so agents don't
        // teleport on return after the browser throttled rAF.
        lastFrameRef.current = 0;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // Deps intentionally empty — all inputs are refs so the loop keeps
    // a stable identity and doesn't restart when agents / room change.
  }, [agentsApi, roomRef, masksRef, enabledRef]);

  return api;
}

/** Advance a single agent's wander state by `dt` seconds. */
function processAgent(
  agent: Agent,
  now: number,
  dt: number,
  states: Map<string, WanderState>,
  api: UseAgentsApi,
  room: RoomState,
  masks: MasksApi,
): void {
  if (!agent.autonomous) {
    // If the user turned wander off, drop any ephemeral state so the next
    // re-enable starts with a clean slate.
    states.delete(agent.id);
    return;
  }

  let s = states.get(agent.id);
  if (!s) {
    s = {
      mode: 'idle',
      facing: agent.facing,
      // Start in a brief idle so freshly-spawned agents don't immediately
      // charge in a random direction.
      modeEndsAt: now + randomRange(400, 1200),
      stuckFrames: 0,
      paused: false,
      resumeAt: 0,
      animClock: 0,
    };
    states.set(agent.id, s);
  }

  // Auto-resume from takeover / hover pause once the grace window expires.
  if (s.paused && now >= s.resumeAt) {
    s.paused = false;
    // Force a fresh mode decision so the agent doesn't walk off in whatever
    // direction the previous driver left them facing for 10 more seconds.
    s.mode = 'idle';
    s.modeEndsAt = now + randomRange(300, 900);
  }

  if (s.paused) {
    // Deliberately do NOT touch `animFrame` here. See `pauseAgent` /
    // `kickTakeoverTimer` — the idle frame is snapped once at the pause
    // transition (for hover pauses) and the takeover caller is expected
    // to own animFrame for its duration (for WASD). Resetting per frame
    // races that external writer and produces a 60 Hz flicker.
    return;
  }

  // Mode transitions ───────────────────────────────────────────────────────
  if (now >= s.modeEndsAt) {
    if (s.mode === 'walking') {
      s.mode = 'idle';
      s.modeEndsAt = now + randomRange(IDLE_MIN_MS, IDLE_MAX_MS);
      if (agent.animFrame !== 1) api.setAnimFrame(agent.id, 1);
    } else {
      s.mode = 'walking';
      // Momentum: keep current facing 70% of the time, otherwise pick a new
      // one. This makes the agent feel intentional — long strolls in one
      // direction with occasional changes — rather than jittery random.
      if (Math.random() < TURN_PROBABILITY) {
        s.facing = pickRandomFacing(s.facing);
      }
      s.modeEndsAt = now + randomRange(WALK_MIN_MS, WALK_MAX_MS);
      s.stuckFrames = 0;
    }
  }

  if (s.mode === 'idle') {
    if (agent.animFrame !== 1) api.setAnimFrame(agent.id, 1);
    return;
  }

  // Walking ────────────────────────────────────────────────────────────────
  const dir = DIR_VEC[s.facing];
  const stepX = dir.dc * WANDER_SPEED * dt;
  const stepY = dir.dr * WANDER_SPEED * dt;
  const next = resolveAgentMove(agent.row, agent.col, stepY, stepX, room, masks);
  const moved = Math.hypot(next.row - agent.row, next.col - agent.col) > 1e-5;

  if (!moved) {
    // Blocked → try a different direction on the next tick. A short
    // threshold avoids frame-by-frame direction flapping when the agent
    // legitimately paused for a single frame (e.g., collision slide).
    s.stuckFrames += 1;
    if (s.stuckFrames >= 2) {
      // Pick a direction that actually has room. If all are blocked, fall
      // back to idle so the state machine doesn't burn CPU retrying.
      const candidates = FACINGS.filter((f) => f !== s!.facing);
      let foundFree: Facing | null = null;
      for (const f of candidates.sort(() => Math.random() - 0.5)) {
        const v = DIR_VEC[f];
        const probeRow = agent.row + v.dr * 0.25;
        const probeCol = agent.col + v.dc * 0.25;
        if (canAgentStandAt(probeRow, probeCol, room, masks)) {
          foundFree = f;
          break;
        }
      }
      if (foundFree) {
        s.facing = foundFree;
        s.stuckFrames = 0;
        // Don't reset `modeEndsAt` — still consuming the same walk window.
      } else {
        s.mode = 'idle';
        s.modeEndsAt = now + randomRange(IDLE_MIN_MS, IDLE_MAX_MS);
        if (agent.animFrame !== 1) api.setAnimFrame(agent.id, 1);
        return;
      }
    }
    if (agent.animFrame !== 1) api.setAnimFrame(agent.id, 1);
    return;
  }

  s.stuckFrames = 0;
  s.animClock += dt;
  const cyclePos = Math.floor((s.animClock * 5) % 4);
  const animFrame: 0 | 1 | 2 = (cyclePos === 0 ? 0 : cyclePos === 2 ? 2 : 1) as 0 | 1 | 2;

  api.moveAgent(agent.id, next.row, next.col, s.facing, animFrame);
}

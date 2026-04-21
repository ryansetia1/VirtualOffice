import { useCallback, useEffect, useRef, useState } from 'react';
import type { Facing } from '../utils/characterImageLoader';

export type { Facing };

export interface Agent {
  id: string;
  nickname: string;
  folderName: string;
  spriteId: number;
  row: number;
  col: number;
  facing: Facing;
  animFrame: 0 | 1 | 2;
  createdAt: number;
  /**
   * Shell command to run automatically when the terminal first opens for
   * this agent. Empty/undefined → no auto-command.
   */
  startCommand?: string;
  /**
   * Suffix appended to `startCommand` when the agent has a previous
   * conversation. Example: if startCommand is `claude` and continueCommand
   * is `--continue`, the terminal will run `claude --continue` on resume.
   */
  continueCommand?: string;
  /**
   * Optional regex source (no delimiters/flags) used to detect that the
   * resumed session has no prior conversation and should fall back to the
   * plain start command. If empty, a sensible default regex is used.
   */
  noConversationPattern?: string;
  /**
   * Flips to `true` after a terminal session for this agent exits. Enables
   * the continue-command flow on subsequent opens. Reset to `false` when
   * the fallback-detection fires, so the next open starts clean.
   */
  hasPreviousConversation?: boolean;
  /**
   * When true, the agent wanders the room autonomously on the live tab —
   * random-walking with momentum and occasional idle pauses. Hover, click,
   * WASD, or an open terminal suspends the wander; resumes after a short
   * idle window. New agents default to `true`; migrated (older) agents
   * default to `false` to avoid surprising the user.
   */
  autonomous?: boolean;
}

const STORAGE_KEY = 'virtualOffice_agents';

interface StoredState {
  agents: Agent[];
  activeAgentId: string | null;
}

let nextAgentId = 1;

function genId(): string {
  return `a${nextAgentId++}`;
}

function syncCounter(agents: Agent[]) {
  for (const a of agents) {
    const m = a.id?.match(/^a(\d+)$/);
    if (m) nextAgentId = Math.max(nextAgentId, parseInt(m[1], 10) + 1);
  }
}

function loadStored(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { agents: [], activeAgentId: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { agents: [], activeAgentId: null };
    const agents: Agent[] = Array.isArray(parsed.agents) ? parsed.agents.map(normalizeAgent).filter(Boolean) as Agent[] : [];
    syncCounter(agents);
    // Deliberately ignore any persisted `activeAgentId` — every cold start
    // begins with no agent selected so the camera is free and agents wander
    // unattended until the user explicitly picks one to follow / drive.
    return { agents, activeAgentId: null };
  } catch {
    return { agents: [], activeAgentId: null };
  }
}

function normalizeAgent(raw: unknown): Agent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.folderName !== 'string' || typeof r.nickname !== 'string') return null;
  const facing: Facing = (['down', 'left', 'right', 'up'] as const).includes(r.facing as Facing)
    ? (r.facing as Facing)
    : 'down';
  const animFrame = r.animFrame === 0 || r.animFrame === 2 ? (r.animFrame as 0 | 2) : 1;
  return {
    id: r.id,
    nickname: r.nickname,
    folderName: r.folderName,
    spriteId: typeof r.spriteId === 'number' ? r.spriteId : 0,
    row: typeof r.row === 'number' ? r.row : 1,
    col: typeof r.col === 'number' ? r.col : 1,
    facing,
    animFrame,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    startCommand: typeof r.startCommand === 'string' ? r.startCommand : undefined,
    continueCommand: typeof r.continueCommand === 'string' ? r.continueCommand : undefined,
    noConversationPattern: typeof r.noConversationPattern === 'string' ? r.noConversationPattern : undefined,
    hasPreviousConversation: typeof r.hasPreviousConversation === 'boolean' ? r.hasPreviousConversation : false,
    // Migrated agents default to `false` — users who created agents before
    // wandering existed shouldn't suddenly see them scatter on reload.
    autonomous: typeof r.autonomous === 'boolean' ? r.autonomous : false,
  };
}

function saveStored(state: StoredState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

export interface AddAgentInput {
  nickname: string;
  folderName: string;
  spriteId: number;
  row: number;
  col: number;
  startCommand?: string;
  continueCommand?: string;
  noConversationPattern?: string;
}

export interface AgentCommandsInput {
  startCommand?: string;
  continueCommand?: string;
  noConversationPattern?: string;
}

export interface UseAgentsApi {
  agents: Agent[];
  activeAgentId: string | null;
  setActive: (id: string | null) => void;
  addAgent: (input: AddAgentInput) => Agent;
  renameAgent: (id: string, nickname: string) => void;
  setSpriteId: (id: string, spriteId: number) => void;
  setAgentCommands: (id: string, commands: AgentCommandsInput) => void;
  setHasPreviousConversation: (id: string, value: boolean) => void;
  setAgentAutonomous: (id: string, value: boolean) => void;
  moveAgent: (id: string, row: number, col: number, facing?: Facing, animFrame?: 0 | 1 | 2) => void;
  setFacing: (id: string, facing: Facing) => void;
  setAnimFrame: (id: string, animFrame: 0 | 1 | 2) => void;
  removeAgent: (id: string) => void;
  getAgent: (id: string) => Agent | undefined;
  hasFolder: (folderName: string) => boolean;
}

export function useAgents(): UseAgentsApi {
  const [stored] = useState<StoredState>(loadStored);
  const [agents, setAgents] = useState<Agent[]>(stored.agents);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(stored.activeAgentId);

  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return; }
    saveStored({ agents, activeAgentId });
  }, [agents, activeAgentId]);

  const setActive = useCallback((id: string | null) => {
    setActiveAgentId(id);
  }, []);

  const addAgent = useCallback((input: AddAgentInput): Agent => {
    const agent: Agent = {
      id: genId(),
      nickname: input.nickname,
      folderName: input.folderName,
      spriteId: input.spriteId,
      row: input.row,
      col: input.col,
      facing: 'down',
      animFrame: 1,
      createdAt: Date.now(),
      startCommand: input.startCommand?.trim() || undefined,
      continueCommand: input.continueCommand?.trim() || undefined,
      noConversationPattern: input.noConversationPattern?.trim() || undefined,
      hasPreviousConversation: false,
      // Newly created agents wander by default so the office feels alive
      // from the moment the user spawns someone in.
      autonomous: true,
    };
    setAgents((prev) => [...prev, agent]);
    setActiveAgentId(agent.id);
    return agent;
  }, []);

  const renameAgent = useCallback((id: string, nickname: string) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, nickname } : a)));
  }, []);

  const setSpriteId = useCallback((id: string, spriteId: number) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, spriteId } : a)));
  }, []);

  const setAgentCommands = useCallback((id: string, commands: AgentCommandsInput) => {
    setAgents((prev) => prev.map((a) => (
      a.id === id
        ? {
            ...a,
            startCommand: commands.startCommand?.trim() || undefined,
            continueCommand: commands.continueCommand?.trim() || undefined,
            noConversationPattern: commands.noConversationPattern?.trim() || undefined,
          }
        : a
    )));
  }, []);

  const setHasPreviousConversation = useCallback((id: string, value: boolean) => {
    setAgents((prev) => prev.map((a) => (
      a.id === id && a.hasPreviousConversation !== value
        ? { ...a, hasPreviousConversation: value }
        : a
    )));
  }, []);

  const setAgentAutonomous = useCallback((id: string, value: boolean) => {
    setAgents((prev) => prev.map((a) => (
      a.id === id && (a.autonomous ?? false) !== value
        ? { ...a, autonomous: value }
        : a
    )));
  }, []);

  const moveAgent = useCallback((id: string, row: number, col: number, facing?: Facing, animFrame?: 0 | 1 | 2) => {
    setAgents((prev) => prev.map((a) => {
      if (a.id !== id) return a;
      return {
        ...a,
        row,
        col,
        facing: facing ?? a.facing,
        animFrame: animFrame ?? a.animFrame,
      };
    }));
  }, []);

  const setFacing = useCallback((id: string, facing: Facing) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, facing } : a)));
  }, []);

  const setAnimFrame = useCallback((id: string, animFrame: 0 | 1 | 2) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, animFrame } : a)));
  }, []);

  const removeAgent = useCallback((id: string) => {
    setAgents((prev) => prev.filter((a) => a.id !== id));
    setActiveAgentId((cur) => (cur === id ? null : cur));
  }, []);

  const getAgent = useCallback((id: string) => agents.find((a) => a.id === id), [agents]);

  const hasFolder = useCallback(
    (folderName: string) => agents.some((a) => a.folderName.toLowerCase() === folderName.toLowerCase()),
    [agents]
  );

  return {
    agents,
    activeAgentId,
    setActive,
    addAgent,
    renameAgent,
    setSpriteId,
    setAgentCommands,
    setHasPreviousConversation,
    setAgentAutonomous,
    moveAgent,
    setFacing,
    setAnimFrame,
    removeAgent,
    getAgent,
    hasFolder,
  };
}

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
    const activeAgentId = typeof parsed.activeAgentId === 'string' && agents.some((a) => a.id === parsed.activeAgentId)
      ? parsed.activeAgentId
      : null;
    syncCounter(agents);
    return { agents, activeAgentId };
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
}

export interface UseAgentsApi {
  agents: Agent[];
  activeAgentId: string | null;
  setActive: (id: string | null) => void;
  addAgent: (input: AddAgentInput) => Agent;
  renameAgent: (id: string, nickname: string) => void;
  setSpriteId: (id: string, spriteId: number) => void;
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
    moveAgent,
    setFacing,
    setAnimFrame,
    removeAgent,
    getAgent,
    hasFolder,
  };
}

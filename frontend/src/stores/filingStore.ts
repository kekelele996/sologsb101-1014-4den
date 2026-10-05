/**
 * 林业站备案状态管理（Zustand）
 * 维护备案记录、备案版本与保存状态；备案侧独立保存，
 * 写失败时只重试备案侧本身（withRetry），不牵连项目部侧数据。
 * 对账（栽植面积/树种 vs 备案）在上报前按地块实时派生。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Filing, FilingDraft } from '../types/filing';
import {
  createFilingVersion,
  initDatabase,
  listFilings,
} from '../utils/db';
import { withRetry } from '../utils/async';
import { reconcilePlot, getCurrentFiling, type ReconcileResult } from '../utils/filing';
import { usePlotStore } from './plotStore';

export type FilingSaveState = 'idle' | 'saving' | 'error' | 'saved';

interface FilingStoreState {
  filings: Filing[];
  loading: boolean;
  saveState: FilingSaveState;
  saveError: string;
  /** 最近一次保存的备案草稿，用于失败后只重试备案侧 */
  lastDraft: FilingDraft | null;
  init: () => Promise<void>;
  createFiling: (draft: FilingDraft) => Promise<Filing | null>;
  retrySave: () => Promise<Filing | null>;
  currentFilingOf: (plotId: string) => Filing | null;
  filingStateOf: (plotId: string) => 'filed' | 'unfiled';
  reconcileOf: (plotId: string) => ReconcileResult;
}

let subscribed = false;

export const useFilingStore = create<FilingStoreState>((set, get) => ({
  filings: [],
  loading: true,
  saveState: 'idle',
  saveError: '',
  lastDraft: null,

  async init() {
    await initDatabase();
    if (subscribed) return;
    subscribed = true;
    liveQuery(async () => listFilings()).subscribe({
      next: (filings) => set({ filings, loading: false }),
      error: () => set({ loading: false }),
    });
  },

  async createFiling(draft) {
    set({ saveState: 'saving', saveError: '', lastDraft: draft });
    try {
      // 备案侧独立保存：内部对「备案事务 + 作废旧版本」重试，失败只重试备案侧
      const row = await withRetry(() => createFilingVersion(draft), {
        retries: 3,
        baseDelayMs: 300,
      });
      set({ saveState: 'saved', saveError: '', lastDraft: null });
      return row;
    } catch (error) {
      set({
        saveState: 'error',
        saveError: error instanceof Error ? error.message : '备案保存失败',
      });
      return null;
    }
  },

  async retrySave() {
    const draft = get().lastDraft;
    if (draft === null) return null;
    return get().createFiling(draft);
  },

  currentFilingOf(plotId) {
    return getCurrentFiling(get().filings, plotId);
  },

  filingStateOf(plotId) {
    return get().currentFilingOf(plotId) === null ? 'unfiled' : 'filed';
  },

  reconcileOf(plotId) {
    const { plots, seedlings, plantings } = usePlotStore.getState();
    const plot = plots.find((item) => item.id === plotId);
    const filing = getCurrentFiling(get().filings, plotId);
    if (plot === undefined) {
      return {
        ok: false,
        plotId,
        hasFiling: filing !== null,
        filing,
        differences: [],
        projectAreaMu: 0,
        projectSpecies: null,
      };
    }
    return reconcilePlot(plot, seedlings, plantings, filing);
  },
}));

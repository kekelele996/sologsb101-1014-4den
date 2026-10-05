/**
 * 验收状态管理（Zustand）—— 项目部侧
 * 维护验收筛选条件、批量选中的记录与成活率等级草稿；
 * 成活率派生值统一由 hooks/useSurvivalRate 的纯函数产出，避免口径分散。
 *
 * 上报工作流（与林业站备案两侧分开）：
 * - reportSurveys：上报前按地块跟备案对账，符合才上报（冻结原值 + 依据版本）；
 *   栽植面积或树种不符的验收记录挂起并写明差在哪，不上报。
 * - recalcSurvey：备案改动后已失效（stale）的验收按当前栽植重算，恢复未上报。
 * - 已上报（reported）的记录冻结原值，备案再改也不动，界面标出依据哪一版。
 */
import { create } from 'zustand';
import type { RateLevel, Survey, SurveyDraft } from '../types/survey';
import {
  db,
  holdSurveys,
  initDatabase,
  listUnreportedSurveysByPlot,
  markSurveyReported,
  patchSurveyGrades,
  putSurvey,
  recalcSurvey,
  removeSurvey,
} from '../utils/db';
import { getFilingByPlot } from '../utils/stationDb';
import { toFilingBasis } from '../types/filing';
import type { SurvivalSummary } from '../hooks/useSurvivalRate';
import { uuid } from '../utils/id';
import { calcSurvivalRate, rateLevel } from '../utils/rate';
import { reconcilePlotWithFiling, type PlotReconcileResult } from '../utils/reconcile';
import { usePlotStore } from './plotStore';

/** 验收筛选条件（地块 + 等级 + 关键字 + 日期区间 + 上报状态） */
export interface SurveyFilters {
  plotId: string | 'all';
  level: RateLevel | 'all';
  workflow: Survey['workflow'] | 'all';
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: SurveyFilters = { plotId: 'all', level: 'all', workflow: 'all', keyword: '', from: '', to: '' };

export interface ReportBatchResult {
  reported: number;
  held: number;
  /** 每个涉及地块的对账结果，供页面逐条展示差异 */
  reconciles: Array<{ plotId: string; result: PlotReconcileResult }>;
}

interface SurveyStoreState {
  filters: SurveyFilters;
  /** 批量操作选中的验收记录 id */
  selectedIds: string[];
  /** 批量调整使用的目标等级 */
  gradeDraft: RateLevel;
  /** 每次写操作后的版本号，页面据此重新拉取列表 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<SurveyFilters>) => void;
  resetFilters: () => void;
  setSelectedIds: (ids: string[]) => void;
  setGradeDraft: (level: RateLevel) => void;
  createSurvey: (draft: SurveyDraft) => Promise<Survey>;
  updateSurvey: (surveyId: string, draft: SurveyDraft) => Promise<void>;
  deleteSurvey: (surveyId: string) => Promise<void>;
  /** 批量调整成活率等级（人工复核；已上报记录冻结、不参与） */
  bulkApplyGrade: (level: RateLevel) => Promise<number>;
  /**
   * 上报前对账并上报：按地块分组核对备案。
   * 对得上的验收记录上报冻结；对不上的挂起并写明差异。只处理未上报记录。
   */
  reportSurveys: (surveyIds: string[]) => Promise<ReportBatchResult>;
  /** 失效重算：按当前栽植总株数重算并恢复未上报 */
  recalc: (surveyId: string) => Promise<void>;
  /** 按最新测次生成补植计划（回写地块缺株数） */
  generateReplant: (plotId: string) => Promise<string>;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  rateStats: () => { total: number; warnCount: number; avgRate: number };
}

function totalPlantedOf(plotId: string): number {
  return usePlotStore
    .getState()
    .plantings.filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
}

export const useSurveyStore = create<SurveyStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  selectedIds: [],
  gradeDraft: 'good',
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setGradeDraft(level) {
    set({ gradeDraft: level });
  },

  async createSurvey(draft) {
    const total = totalPlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    const stamp = new Date().toISOString();
    const row: Survey = {
      id: uuid('survey'),
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      grade: rateLevel(survivalRate),
      gradeManual: false,
      workflow: 'draft',
      reportedRate: null,
      reportedAliveCount: null,
      reportedTotalCount: null,
      basis: null,
      reportedAt: null,
      discrepancies: [],
      staleReason: '',
      staleFromVersion: null,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSurvey(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateSurvey(surveyId, draft) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    if (existing.workflow === 'reported') {
      throw new Error('该验收结论已上报并冻结，不能修改；如需更正请在林业站侧变更备案后重算新版本。');
    }
    const total = totalPlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    // 编辑即重新核对：挂起 / 失效记录编辑后回到草稿，旧差异与失效标记清空，待下次上报再对账
    await putSurvey({
      ...existing,
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      workflow: 'draft',
      discrepancies: [],
      staleReason: '',
      staleFromVersion: null,
    });
    set({ revision: get().revision + 1 });
  },

  async deleteSurvey(surveyId) {
    const existing = await db.surveys.get(surveyId);
    if (existing?.workflow === 'reported') {
      throw new Error('该验收结论已上报，不能删除。');
    }
    await removeSurvey(surveyId);
    set({ selectedIds: get().selectedIds.filter((id) => id !== surveyId), revision: get().revision + 1 });
  },

  async bulkApplyGrade(level) {
    const ids = get().selectedIds;
    if (ids.length === 0) return 0;
    // 人工复核只改写等级标注，不改写实测成活率数值；已上报记录冻结，不参与
    const affected = await patchSurveyGrades(ids, level);
    set({
      revision: get().revision + 1,
      lastMessage:
        affected === ids.length
          ? `已批量调整 ${affected} 条验收记录的成活率等级`
          : `已调整 ${affected} 条；已上报记录冻结，跳过 ${ids.length - affected} 条`,
    });
    return affected;
  },

  async reportSurveys(surveyIds) {
    const { plots, plantings, seedlings } = usePlotStore.getState();
    const rows = (await db.surveys.bulkGet(surveyIds)).filter((row): row is Survey => row !== undefined);
    const targets = rows.filter((row) => row.workflow !== 'reported');
    const byPlot = new Map<string, Survey[]>();
    targets.forEach((row) => {
      byPlot.set(row.plotId, [...(byPlot.get(row.plotId) ?? []), row]);
    });

    const reconciles: ReportBatchResult['reconciles'] = [];
    let reported = 0;
    let held = 0;

    for (const [plotId, plotSurveys] of byPlot) {
      const plot = plots.find((item) => item.id === plotId);
      if (plot === undefined) continue;
      const filing = await getFilingByPlot(plotId);
      const result = reconcilePlotWithFiling({ plot, filing, plantings, seedlings });
      reconciles.push({ plotId, result });
      const ids = plotSurveys.map((row) => row.id);
      if (result.ok && filing !== undefined) {
        const total = totalPlantedOf(plotId);
        for (const survey of plotSurveys) {
          // 依据当前最新版备案冻结
          const basis = toFilingBasis(filing, {
            version: filing.currentVersion,
            areaMu: filing.areaMu,
            species: filing.species,
            filedAt: filing.filedAt,
          });
          await markSurveyReported(survey.id, { basis, totalCount: total });
          reported += 1;
        }
      } else {
        await holdSurveys(ids, result.discrepancies);
        held += ids.length;
      }
    }

    set({
      revision: get().revision + 1,
      lastMessage:
        held === 0
          ? `已上报 ${reported} 条验收结论，成活率与备案依据已冻结。`
          : `${reported} 条已上报；${held} 条因栽植面积 / 树种与备案不符已挂起，详见差异说明。`,
    });
    return { reported, held, reconciles };
  },

  async recalc(surveyId) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    if (existing.workflow === 'reported') {
      throw new Error('已上报的验收结论冻结保留原值，不能重算。');
    }
    const total = totalPlantedOf(existing.plotId);
    await recalcSurvey(surveyId, total);
    set({ revision: get().revision + 1, lastMessage: '已按当前栽植总株数重算成活率，恢复为未上报。' });
  },

  async generateReplant(plotId) {
    const summary = get().summaryOf(plotId);
    const plot = usePlotStore.getState().plots.find((row) => row.id === plotId);
    if (!plot) return '地块不存在，无法生成补植计划';
    const missing = summary.suggestReplant;
    if (missing <= 0) return '该地块当前无缺株，无需生成补植计划';
    const species = usePlotStore.getState().seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄';
    const stamp = new Date().toISOString();
    await db.replants.put({
      id: uuid('replant'),
      plotId,
      missingCount: missing,
      planDate: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      species,
      state: '待补植',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    });
    set({ revision: get().revision + 1, lastMessage: `已为「${plot.name}」生成补植计划：缺株 ${missing} 株` });
    return `已生成补植计划：缺株 ${missing} 株`;
  },

  summaryOf(plotId) {
    return usePlotStore.getState().summaryOf(plotId);
  },

  rateStats() {
    const { summaries } = usePlotStore.getState();
    const list = Object.values(summaries);
    const withSurvey = list.filter((item) => item.latest !== null);
    if (withSurvey.length === 0) return { total: 0, warnCount: 0, avgRate: 0 };
    const sum = withSurvey.reduce((acc, item) => acc + item.latestRate, 0);
    return {
      total: withSurvey.length,
      warnCount: withSurvey.filter((item) => item.warn).length,
      avgRate: Math.round((sum / withSurvey.length) * 10) / 10,
    };
  },
}));

/** 供页面在非 store 上下文按地块取未上报记录（上报按钮批量场景） */
export async function fetchUnreportedByPlot(plotId: string): Promise<Survey[]> {
  return listUnreportedSurveysByPlot(plotId);
}

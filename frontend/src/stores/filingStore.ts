/**
 * 林业站侧状态管理（Zustand）—— 与项目部 plotStore/surveyStore 分开
 * 维护备案当前值、版本流水、历史补录失败、站侧写入死信；
 * 备案改动后在这里编排：站侧新版本落库 → 项目部未上报验收失效（已上报留原值）。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { BackfillFailure, Filing, FilingDraft, FilingRevision } from '../types/filing';
import type { SeedlingSpecies } from '../types/seedling';
import {
  changeFiling,
  clearStationWriteFailure,
  initStationDatabase,
  listBackfillFailures,
  listFilingRevisions,
  listFilings,
  registerFiling,
  stationDb,
  type StationWriteFailure,
} from '../utils/stationDb';
import { db, invalidateUnreportedSurveys } from '../utils/db';
import { backfillOnePlot, ensureHistoryFilings, seedStationDatabase, type BackfillOutcome } from '../utils/filingBackfill';

interface FilingStoreState {
  filings: Filing[];
  revisions: FilingRevision[];
  backfillFailures: BackfillFailure[];
  writeFailures: StationWriteFailure[];
  ready: boolean;
  loading: boolean;
  error: string;
  /** 每次写操作后的版本号，页面据此刷新 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  /** 为单个缺备案地块补录历史备案（手动重试入口），返回是否成功 */
  backfillPlot: (plotId: string) => Promise<boolean>;
  /** 全量补录历史备案（升级引导） */
  backfillAll: () => Promise<BackfillOutcome>;
  /** 新登记备案（项目部地块尚在等待备案的场景） */
  register: (draft: FilingDraft) => Promise<Filing>;
  /** 备案改动（面积 / 树种），并联动失效项目部未上报验收 */
  change: (
    filingNo: string,
    input: { areaMu?: number; species?: SeedlingSpecies[]; filedAt: string; changeNote: string },
  ) => Promise<{ filing: Filing; invalidated: number; changes: string[] }>;
  revisionListOf: (filingNo: string) => FilingRevision[];
  filingOfPlot: (plotId: string) => Filing | undefined;
  dismissWriteFailure: (id: string) => Promise<void>;
}

let subscribed = false;

export const useFilingStore = create<FilingStoreState>((set, get) => ({
  filings: [],
  revisions: [],
  backfillFailures: [],
  writeFailures: [],
  ready: false,
  loading: true,
  error: '',
  revision: 0,
  lastMessage: '',

  async init() {
    set({ loading: true, error: '' });
    try {
      // 项目部库先就绪（其演示播种可能已完成），再处理站侧
      await db.open();
      await initStationDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [filings, revisions, backfillFailures, writeFailures] = await Promise.all([
            listFilings(),
            listFilingRevisions(),
            listBackfillFailures(),
            stationDb.stationWriteFailures.toArray(),
          ]);
          return {
            filings,
            revisions: revisions.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.version - a.version),
            backfillFailures,
            writeFailures,
          };
        }).subscribe({
          next: ({ filings, revisions, backfillFailures, writeFailures }) => {
            set({
              filings,
              revisions,
              backfillFailures,
              writeFailures,
              ready: true,
              loading: false,
              error: '',
            });
          },
          error: (err: unknown) => {
            set({
              ready: true,
              loading: false,
              error: err instanceof Error ? err.message : '读取林业站备案失败',
            });
          },
        });
      }
      // 先播站侧演示备案：仅当项目部库为演示地块（含固定 id）且站侧为空时执行，
      // 内含「上报冻结 / 备案变更致失效」教学场景；真实升级数据不含固定 id，会被跳过。
      await seedStationDatabase();
      // 再做升级引导：为仍没有备案的现有地块补历史备案（已有演示备案的地块自动跳过）
      const outcome = await ensureHistoryFilings();
      const msgParts: string[] = [];
      if (outcome.filled > 0) msgParts.push(`补录历史备案 ${outcome.filled} 份`);
      if (outcome.failed > 0) msgParts.push(`${outcome.failed} 个地块补录失败（只读保留，可重试）`);
      set({
        revision: get().revision + 1,
        lastMessage: msgParts.length > 0 ? msgParts.join('；') : get().lastMessage,
      });
    } catch (err) {
      set({
        ready: true,
        loading: false,
        error: err instanceof Error ? err.message : '林业站侧初始化失败',
      });
    }
  },

  async backfillPlot(plotId) {
    const plot = await db.plots.get(plotId);
    if (plot === undefined) return false;
    const [plantings, seedlings] = await Promise.all([db.plantings.toArray(), db.seedlings.toArray()]);
    const ok = await backfillOnePlot(plot, plantings, seedlings);
    set({
      revision: get().revision + 1,
      lastMessage: ok ? `已为「${plot.name}」补录历史备案` : `「${plot.name}」仍无法自动补录备案，已只读保留`,
    });
    return ok;
  },

  async backfillAll() {
    const outcome = await ensureHistoryFilings();
    set({
      revision: get().revision + 1,
      lastMessage: `补录完成：成功 ${outcome.filled} 份，失败 ${outcome.failed} 个，跳过已有备案 ${outcome.skipped} 个`,
    });
    return outcome;
  },

  async register(draft) {
    const result = await registerFiling({
      filingNo: draft.filingNo.trim(),
      plotId: draft.plotId,
      areaMu: draft.areaMu,
      species: draft.species,
      filedAt: draft.filedAt,
      changeNote: draft.changeNote.trim() || '林业站首版备案',
      source: 'formal',
    });
    set({ revision: get().revision + 1, lastMessage: `备案 ${result.filing.filingNo} 已登记（v1）` });
    return result.filing;
  },

  async change(filingNo, input) {
    // 1）站侧产生新版本（站侧存不上只重试它自己，项目部数据不动）
    const result = await changeFiling(filingNo, input);
    // 2）项目部侧：未上报验收结论失效；已上报的保留原值、依据版本不动
    const invalidated = await invalidateUnreportedSurveys(result.filing.plotId, {
      filingNo,
      prevVersion: result.prevVersion,
      nextVersion: result.filing.currentVersion,
      changes: result.changes,
    });
    set({
      revision: get().revision + 1,
      lastMessage:
        `备案 ${filingNo} 已变更为 v${result.filing.currentVersion}（${result.changes.join('；')}）；` +
        `项目部 ${invalidated} 条未上报验收已失效待重算，已上报结论保留原值。`,
    });
    return { filing: result.filing, invalidated, changes: result.changes };
  },

  revisionListOf(filingNo) {
    return get()
      .revisions.filter((row) => row.filingNo === filingNo)
      .sort((a, b) => b.version - a.version);
  },

  filingOfPlot(plotId) {
    return get().filings.find((row) => row.plotId === plotId);
  },

  async dismissWriteFailure(id) {
    await clearStationWriteFailure(id);
    set({ revision: get().revision + 1 });
  },
}));

/**
 * IndexedDB 持久化层（Dexie 封装）—— 项目部侧
 * - 数据库名：gbmangrove（与林业站侧 gbmangrove-station 物理分开，各自保存）
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑
 * - v3：验收记录增加上报 / 挂起 / 失效 / 备案依据字段，支撑「上报前对账」
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { ReconcileDiscrepancy, Survey, SurveyWorkflow } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { FilingBasis } from '../types/filing';
import { rateLevel } from './rate';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';
import { clearStationData, removeFilingForPlot } from './stationDb';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：验收记录增加上报工作流索引 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade, workflow',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // v3 迁移：旧验收记录没有上报概念，一律按「未上报」补齐工作流字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.workflow !== 'string') row.workflow = 'draft';
          if (row.reportedRate === undefined) row.reportedRate = null;
          if (row.reportedAliveCount === undefined) row.reportedAliveCount = null;
          if (row.reportedTotalCount === undefined) row.reportedTotalCount = null;
          if (row.basis === undefined) row.basis = null;
          if (row.reportedAt === undefined) row.reportedAt = null;
          if (!Array.isArray(row.discrepancies)) row.discrepancies = [];
          if (typeof row.staleReason !== 'string') row.staleReason = '';
          if (row.staleFromVersion === undefined) row.staleFromVersion = null;
        });
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/**
 * 删除地块并级联清理：
 * - 项目部侧：苗木批次、栽植、验收、补植计划同一事务清理；
 * - 林业站侧：该地块备案 / 版本流水 / 补录失败由站侧独立重试，存不上只重试它自己，
 *   不阻断项目部侧删除（两侧各自保存）。
 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
  try {
    await removeFilingForPlot(id);
  } catch {
    // 站侧清理失败已由站侧重试 / 死信队列兜底，不回滚项目部侧删除
  }
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

/** 取某地块尚未上报（草稿 / 挂起 / 失效）的验收记录 */
export async function listUnreportedSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await listSurveysByPlot(plotId);
  return rows.filter((row) => row.workflow !== 'reported');
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核）；已上报的记录冻结，不参与调整 */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .filter((row) => row.workflow !== 'reported')
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
  return next.length;
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------ 验收上报 / 挂起 / 失效 / 重算（v3） ------------------------ */

/** 挂起：对账不符的验收记录写入差异明细，未上报不删除 */
export async function holdSurveys(ids: string[], discrepancies: ReconcileDiscrepancy[]): Promise<void> {
  if (ids.length === 0) return;
  const stamp = nowIso();
  await db.surveys.where('id').anyOf(ids).modify((row: Survey) => {
    if (row.workflow === 'reported') return;
    row.workflow = 'held' satisfies SurveyWorkflow;
    row.discrepancies = discrepancies;
    row.staleReason = '';
    row.staleFromVersion = null;
    row.updatedAt = stamp;
  });
}

export interface MarkReportedInput {
  basis: FilingBasis;
  /** 上报口径的栽植总株数（冻结，后续栽植变化不影响已上报结论） */
  totalCount: number;
}

/** 上报：冻结当时成活率 / 成活株数 / 总株数 / 依据版本 */
export async function markSurveyReported(surveyId: string, input: MarkReportedInput): Promise<void> {
  const row = await db.surveys.get(surveyId);
  if (row === undefined || row.workflow === 'reported') return;
  const stamp = nowIso();
  await db.surveys.update(surveyId, {
    workflow: 'reported' satisfies SurveyWorkflow,
    reportedRate: row.survivalRate,
    reportedAliveCount: row.aliveCount,
    reportedTotalCount: input.totalCount,
    basis: input.basis,
    reportedAt: stamp,
    discrepancies: [],
    staleReason: '',
    staleFromVersion: null,
    updatedAt: stamp,
  });
}

export interface InvalidateUnreportedInput {
  filingNo: string;
  prevVersion: number;
  nextVersion: number;
  /** 备案变更项，如「面积 46.5 → 50 亩」 */
  changes: string[];
}

/**
 * 备案改动后：该地块所有「未上报」（草稿 / 挂起 / 已失效）的验收结论置为失效，
 * 等项目部按新备案重算；已上报的记录原样保留、不在此处理。
 * @returns 被置为失效的记录数
 */
export async function invalidateUnreportedSurveys(plotId: string, input: InvalidateUnreportedInput): Promise<number> {
  const reason = `备案 ${input.filingNo} 由 v${input.prevVersion} 变更为 v${input.nextVersion}：${input.changes.join('；')}`;
  const rows = await listUnreportedSurveysByPlot(plotId);
  const stamp = nowIso();
  const next = rows.map((row) => ({
    ...row,
    workflow: 'stale' as SurveyWorkflow,
    staleReason: reason,
    staleFromVersion: row.basis?.version ?? input.prevVersion,
    discrepancies: [],
    updatedAt: stamp,
  }));
  if (next.length > 0) await db.surveys.bulkPut(next);
  return next.length;
}

/**
 * 失效重算：按当前栽植总株数重新计算成活率并恢复为草稿（未上报）状态。
 * 已上报的记录不允许重算（结论冻结）。
 */
export async function recalcSurvey(surveyId: string, totalCount: number): Promise<Survey | undefined> {
  const existing = await db.surveys.get(surveyId);
  if (existing === undefined || existing.workflow === 'reported') return existing;
  const rate = totalCount > 0
    ? Math.round(Math.min(100, Math.max(0, (existing.aliveCount / totalCount) * 100)) * 10) / 10
    : 0;
  const updated: Survey = {
    ...existing,
    survivalRate: rate,
    grade: existing.gradeManual ? existing.grade : rateLevel(rate),
    workflow: 'draft',
    staleReason: '',
    staleFromVersion: null,
    discrepancies: [],
    updatedAt: nowIso(),
  };
  await db.surveys.put(updated);
  return updated;
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 * 已上报的验收结论冻结，补植回写不改其原值。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    if (latest.workflow === 'reported') return;
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
}

/** 兜底旧版存档 / 手工导出的验收行，补齐 v3 工作流字段 */
function normalizeSurvey(row: Partial<Survey>): Survey {
  return {
    ...(row as Survey),
    workflow: typeof row.workflow === 'string' ? (row.workflow as SurveyWorkflow) : 'draft',
    reportedRate: typeof row.reportedRate === 'number' ? row.reportedRate : null,
    reportedAliveCount: typeof row.reportedAliveCount === 'number' ? row.reportedAliveCount : null,
    reportedTotalCount: typeof row.reportedTotalCount === 'number' ? row.reportedTotalCount : null,
    basis: row.basis ?? null,
    reportedAt: typeof row.reportedAt === 'string' ? row.reportedAt : null,
    discrepancies: Array.isArray(row.discrepancies) ? row.discrepancies : [],
    staleReason: typeof row.staleReason === 'string' ? row.staleReason : '',
    staleFromVersion: typeof row.staleFromVersion === 'number' ? row.staleFromVersion : null,
  };
}

/** 导出整库快照（仅项目部侧；林业站侧备案另行导出，两侧分开） */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...normalizeSurvey(row), revision: ROW_REVISION })));
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/**
 * 清空全部数据并重新灌入演示数据。
 * 项目部库清空重灌；林业站侧备案库一并清空，由调用方（filingStore.init / 重新检测）
 * 重新执行历史补录与站侧演示播种。站侧清空失败只重试站侧自己，不阻断项目部重置。
 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
  });
  await seedDatabase();
  try {
    await clearStationData();
  } catch {
    // 站侧清空失败已由 withStationRetry / 死信队列兜底
  }
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants };
}

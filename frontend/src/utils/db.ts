/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Filing, FilingDraft } from '../types/filing';
import { rateLevel, calcSurvivalRate } from './rate';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';
import { getDominantSpecies, reconcilePlot } from './filing';

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
  filings!: Table<Filing, string>;

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
            row.revision = ROW_REVISION;
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

    // ---------- v3：林业站备案分账 + 验收上报/失效/依据版本 ----------
    this.version(3)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade, reportState, stale',
        replants: 'id, plotId, planDate, state, species',
        // 备案表：按地块 + 版本号/状态检索
        filings: 'id, plotId, version, status, filingNo, filedAt',
      })
      .upgrade(async (tx) => {
        // 迁移 1：验收记录补齐「上报 / 备案依据 / 失效」字段（旧数据一律视为未上报、未失效）
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.reportState !== 'string') row.reportState = 'draft';
          if (typeof row.reportedAt !== 'string') row.reportedAt = '';
          if (typeof row.basedOnFilingId !== 'string') row.basedOnFilingId = '';
          if (typeof row.basedOnFilingVersion !== 'number') row.basedOnFilingVersion = null;
          if (typeof row.basedOnFilingNo !== 'string') row.basedOnFilingNo = '';
          if (typeof row.filingAreaMuSnapshot !== 'number') row.filingAreaMuSnapshot = null;
          if (typeof row.filingSpeciesSnapshot !== 'string') row.filingSpeciesSnapshot = '';
          if (typeof row.stale !== 'boolean') row.stale = false;
          row.revision = ROW_REVISION;
        });

        // 迁移 2：为现有地块补建历史备案（按地块面积与主植树种）；
        // 补不上的（无苗木批次、无法确定树种）跳过，地块保留只读，待人工补备案。
        const plots = await tx.table('plots').toArray();
        const seedlings = await tx.table('seedlings').toArray();
        const plantings = await tx.table('plantings').toArray();
        const stamp = nowIso();
        for (const plot of plots) {
          const exists = await tx.table('filings').where('plotId').equals(plot.id).count();
          if (exists > 0) continue;
          const species = getDominantSpecies(seedlings, plantings, plot.id);
          if (species === null) continue; // 补不上：只读留着
          await tx.table('filings').put({
            id: uuid('filing'),
            plotId: plot.id,
            filingNo: `备-${String(plot.name ?? plot.id).slice(0, 8)}-历史`,
            filingAreaMu: plot.areaMu,
            filingSpecies: species,
            version: 1,
            status: '有效',
            filedAt: typeof plot.createdAt === 'string' ? plot.createdAt.slice(0, 10) : today(),
            note: '升级时按现有地块补建的历史备案',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
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

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划与林业站备案 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.filings], async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.filings.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
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

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
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

/* ------------------------------- 林业站备案 ------------------------------- */

export async function listFilings(): Promise<Filing[]> {
  return db.filings.toArray();
}

export async function listFilingsByPlot(plotId: string): Promise<Filing[]> {
  const rows = await db.filings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.version - a.version);
}

export async function getCurrentFilingRow(plotId: string): Promise<Filing | null> {
  const rows = await db.filings.where('plotId').equals(plotId).toArray();
  let current: Filing | null = null;
  for (const row of rows) {
    if (row.status !== '有效') continue;
    if (current === null || row.version > current.version) current = row;
  }
  return current;
}

/**
 * 新建 / 变更备案（生成新版本）。
 * 备案侧独立保存：新备案写入与旧备案作废在同一事务内，失败时由调用方重试本侧；
 * 项目部侧的「未上报验收失效」在备案保存成功后单独执行，不回滚备案。
 */
export async function createFilingVersion(draft: FilingDraft): Promise<Filing> {
  const rows = await db.filings.where('plotId').equals(draft.plotId).toArray();
  const maxVersion = rows.reduce((acc, row) => Math.max(acc, row.version), 0);
  const nextVersion = maxVersion + 1;
  const stamp = nowIso();
  const row: Filing = {
    id: uuid('filing'),
    plotId: draft.plotId,
    filingNo: draft.filingNo.trim() || `备-${draft.plotId}-${nextVersion}`,
    filingAreaMu: draft.filingAreaMu,
    filingSpecies: draft.filingSpecies,
    version: nextVersion,
    status: '有效',
    filedAt: draft.filedAt || today(),
    note: draft.note.trim(),
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };

  // 备案侧独立事务：作废旧版本 + 写入新版本
  await db.transaction('rw', db.filings, async () => {
    await db.filings
      .where('plotId')
      .equals(draft.plotId)
      .and((item) => item.id !== row.id)
      .modify({ status: '已作废', updatedAt: nowIso() });
    await db.filings.put(row);
  });

  // 项目部侧：备案改动后，未上报的验收结论失效（独立操作，失败不影响已保存的备案）
  await markDraftSurveysStale(draft.plotId);

  return row;
}

/** 备案改动后，把地块下所有未上报的验收结论标记为失效（已上报的不动） */
export async function markDraftSurveysStale(plotId: string): Promise<void> {
  await db.surveys
    .where('plotId')
    .equals(plotId)
    .and((row) => row.reportState === 'draft')
    .modify({ stale: true, updatedAt: nowIso() });
}

/**
 * 重算失效的未上报验收结论：按当前栽植株数重算成活率并解除失效标记。
 * 已上报的结论冻结原值，不参与重算。
 */
export async function recalcSurvey(surveyId: string): Promise<Survey | null> {
  const survey = await db.surveys.get(surveyId);
  if (!survey || survey.reportState === 'reported') return null;
  const plantings = await db.plantings.where('plotId').equals(survey.plotId).toArray();
  const total = plantings.reduce((acc, row) => acc + row.count, 0);
  const rate = calcSurvivalRate(survey.aliveCount, total);
  const next: Survey = {
    ...survey,
    survivalRate: rate,
    grade: survey.gradeManual ? survey.grade : rateLevel(rate),
    stale: false,
    updatedAt: nowIso(),
  };
  await db.surveys.put(next);
  return next;
}

export interface ReportSurveyResult {
  ok: boolean;
  message: string;
  survey?: Survey;
}

/**
 * 上报验收结论。
 * 上报前按地块与备案对账：未备案 / 账实不符 / 结论失效的一律挂起并写明原因；
 * 上报后冻结成活率与备案依据版本，备案后续改动不再影响已上报结论。
 */
export async function reportSurvey(surveyId: string): Promise<ReportSurveyResult> {
  const survey = await db.surveys.get(surveyId);
  if (!survey) return { ok: false, message: '验收记录不存在' };
  if (survey.reportState === 'reported') return { ok: false, message: '该测次已上报，不能重复上报' };
  if (survey.stale) return { ok: false, message: '验收结论已失效，请先重算后再上报' };

  const plot = await db.plots.get(survey.plotId);
  if (!plot) return { ok: false, message: '地块不存在，无法上报' };

  const filing = await getCurrentFilingRow(survey.plotId);
  if (!filing) {
    return { ok: false, message: '该地块暂无有效备案，请先到林业站备案后再上报' };
  }

  const [seedlings, plantings] = await Promise.all([db.seedlings.toArray(), db.plantings.toArray()]);
  const reconcile = reconcilePlot(plot, seedlings, plantings, filing);
  if (!reconcile.ok) {
    const reasons = reconcile.differences.map((item) => item.detail).join('；');
    return { ok: false, message: `与备案不符，已挂起：${reasons}` };
  }

  // 对账通过：按当前栽植株数重算一版作为上报原值并冻结
  const total = plantings
    .filter((row) => row.plotId === survey.plotId)
    .reduce((acc, row) => acc + row.count, 0);
  const rate = calcSurvivalRate(survey.aliveCount, total);
  const next: Survey = {
    ...survey,
    reportState: 'reported',
    reportedAt: nowIso(),
    survivalRate: rate,
    grade: survey.gradeManual ? survey.grade : rateLevel(rate),
    stale: false,
    basedOnFilingId: filing.id,
    basedOnFilingVersion: filing.version,
    basedOnFilingNo: filing.filingNo,
    filingAreaMuSnapshot: filing.filingAreaMu,
    filingSpeciesSnapshot: filing.filingSpecies,
    updatedAt: nowIso(),
  };
  await db.surveys.put(next);
  return {
    ok: true,
    message: `已上报第 ${next.round} 测次，成活率 ${next.survivalRate}%，依据备案 ${filing.filingNo}（v${filing.version}）`,
    survey: next,
  };
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
  filings: Filing[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, filings] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.filings.toArray(),
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
    filings,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.filings], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.filings.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.filings.bulkPut((snapshot.filings ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.filings], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.filings.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, filings] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.filings.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, filings };
}

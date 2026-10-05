/**
 * 历史备案补录 + 林业站侧演示播种
 * 升级时旧数据没有备案：本模块按现有地块补一份历史备案（v1）。
 * - 能补：用地块现有面积 + 实际栽植涉及树种，在站侧库登记 source = history-backfill 的 v1 备案；
 * - 补不上：写入站侧 backfillFailures，只读留着，等现场在林业站侧「重试补录」。
 * 站侧任何一笔存不上只由 withStationRetry 重试它自己，绝不影响项目部侧数据。
 */
import {
  changeFiling,
  getFilingByPlot,
  listBackfillFailures,
  registerFiling,
  removeBackfillFailure,
  removeFilingForPlot,
  stationDb,
  upsertBackfillFailure,
} from './stationDb';
import { db, invalidateUnreportedSurveys, markSurveyReported } from './db';
import type { FilingBasis } from '../types/filing';
import { toFilingBasis } from '../types/filing';
import type { Plot } from '../types/plot';
import type { Planting } from '../types/planting';
import type { Seedling, SeedlingSpecies } from '../types/seedling';
import { plantedSpeciesOf } from './reconcile';

export interface BackfillOutcome {
  /** 本次新补成功的地块数 */
  filled: number;
  /** 仍然补不上的地块数 */
  failed: number;
  /** 跳过（已有备案）的地块数 */
  skipped: number;
}

/** 生成历史备案号：用地块 id 短码，固定可读，且与地块一一对应 */
export function historyFilingNo(plotId: string): string {
  const suffix = plotId.replace(/[^a-z0-9]+/gi, '').slice(-8).toLowerCase() || 'plot';
  return `BL-HIST-${suffix}`;
}

/**
 * 为一个没有备案的地块补历史备案。
 * 树种取自实际栽植（被栽植记录引用的苗木批次）；没有实际栽植树种时补不上。
 * @returns true 补成功；false 补不上（已记入 / 更新 backfillFailures）
 */
export async function backfillOnePlot(plot: Plot, plantings: Planting[], seedlings: Seedling[]): Promise<boolean> {
  const existing = await getFilingByPlot(plot.id);
  if (existing !== undefined) return true;

  const species = plantedSpeciesOf(plot.id, plantings, seedlings) as SeedlingSpecies[];
  if (species.length === 0) {
    const prior = (await listBackfillFailures()).find((row) => row.plotId === plot.id);
    await upsertBackfillFailure({
      id: prior?.id,
      plotId: plot.id,
      reason: '无法确定备案树种：该地块尚无实际栽植记录（没有可引用的苗木批次树种），须人工到林业站登记。',
      attempts: (prior?.attempts ?? 0) + 1,
      lastError: '缺少树种，历史备案无法自动补全',
    }).catch(() => undefined);
    return false;
  }

  try {
    await registerFiling({
      filingNo: historyFilingNo(plot.id),
      plotId: plot.id,
      areaMu: plot.areaMu,
      species,
      filedAt: plot.createdAt.slice(0, 10) || '',
      changeNote: '系统升级时按现有地块与实际栽植数据补录的历史备案',
      source: 'history-backfill',
    });
    await removeBackfillFailure(plot.id).catch(() => undefined);
    return true;
  } catch (error) {
    // registerFiling 内部已重试站侧写入；仍失败时补一条只读失败记录
    const prior = (await listBackfillFailures()).find((row) => row.plotId === plot.id);
    await upsertBackfillFailure({
      id: prior?.id,
      plotId: plot.id,
      reason: '林业站侧保存失败，待重试',
      attempts: (prior?.attempts ?? 0) + 1,
      lastError: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return false;
  }
}

/**
 * 升级引导：项目部库初始化后，为每个没有备案的现有地块补历史备案。
 * 幂等：已有备案的地块跳过；重复调用安全。
 * 同时自愈清理：项目部已删除地块残留的站侧备案（删除地块时若站侧存不上，
 * 在这里只重试站侧自己的清理），单笔失败不影响其他地块。
 */
export async function ensureHistoryFilings(): Promise<BackfillOutcome> {
  const [plots, plantings, seedlings] = await Promise.all([
    db.plots.toArray(),
    db.plantings.toArray(),
    db.seedlings.toArray(),
  ]);

  // 自愈：清理项目部侧已不存在地块的站侧备案 / 补录失败留痕
  const liveIds = new Set(plots.map((plot) => plot.id));
  const staleFilings = await stationDb.filings.toArray();
  for (const filing of staleFilings) {
    if (!liveIds.has(filing.plotId)) {
      try {
        await removeFilingForPlot(filing.plotId);
      } catch {
        /* 站侧清理仍失败：留待下次检测重试，项目部侧不受影响 */
      }
    }
  }

  let filled = 0;
  let failed = 0;
  let skipped = 0;
  for (const plot of plots) {
    const existing = await getFilingByPlot(plot.id);
    if (existing !== undefined) {
      skipped += 1;
      continue;
    }
    const ok = await backfillOnePlot(plot, plantings, seedlings);
    if (ok) filled += 1;
    else failed += 1;
  }
  return { filled, failed, skipped };
}

/* --------------------------- 林业站侧演示数据 --------------------------- */

interface StationSeedRow {
  plotId: string;
  filingNo: string;
  areaMu: number;
  species: SeedlingSpecies[];
  filedAt: string;
  changeNote: string;
}

/** 演示地块的首版正式备案（播种时与地块面积、实际栽植树种一致） */
const STATION_SEED: StationSeedRow[] = [
  { plotId: 'plot-donggang-3', filingNo: 'BL-2024-001', areaMu: 46.5, species: ['秋茄', '桐花树'], filedAt: '2024-04-08', changeNote: '东港南堤 3 号地块首版造林备案' },
  { plotId: 'plot-xiwan-a', filingNo: 'BL-2024-002', areaMu: 32, species: ['白骨壤', '秋茄'], filedAt: '2024-04-25', changeNote: '西湾滩涂 A 区首版补植备案' },
  { plotId: 'plot-beiyu-b', filingNo: 'BL-2024-003', areaMu: 58.2, species: ['无瓣海桑', '白骨壤'], filedAt: '2024-03-15', changeNote: '北屿外滩 B 区首版造林备案' },
];

async function seedStationFiling(row: StationSeedRow): Promise<FilingBasis | null> {
  const result = await registerFiling({
    filingNo: row.filingNo,
    plotId: row.plotId,
    areaMu: row.areaMu,
    species: row.species,
    filedAt: row.filedAt,
    changeNote: row.changeNote,
    source: 'formal',
  });
  return toFilingBasis(result.filing, result.revision);
}

/**
 * 林业站侧演示播种（幂等）：仅当站侧备案表为空、且项目部演示地块存在时执行。
 * 顺带制造两个教学场景：
 * 1）东港地块备案随后做过一次树种变更（v2）——其前两个测次未上报 → 自动失效待重算，
 *    第三个测次已上报 → 冻结在 v1、标注依据版本；
 * 2）西湾地块当前备案树种不含实际栽植的全部树种（演示：实际多栽了备案外树种），
 *    其未上报测次上报前对账会挂起。
 */
export async function seedStationDatabase(): Promise<void> {
  const plot = await db.plots.get('plot-donggang-3');
  if (plot === undefined) return;
  const stationCount = await stationDb.filings.count();
  if (stationCount > 0) return;

  // 三个地块的首版备案（逐笔登记；存不上只重试各自那笔）
  const basisA = await seedStationFiling(STATION_SEED[0]);
  await seedStationFiling(STATION_SEED[1]);
  await seedStationFiling(STATION_SEED[2]);

  // 东港第三测次：上报在 v1 之后、备案变更之前 → 冻结依据 v1
  if (basisA !== null) {
    await markSurveyReported('survey-a3', { basis: basisA, totalCount: 5200 }).catch(() => undefined);
  }

  // 东港备案树种变更 v2（新增无瓣海桑）→ 前两个未上报测次失效
  const result = await changeFiling('BL-2024-001', {
    species: ['秋茄', '桐花树', '无瓣海桑'],
    filedAt: '2024-12-10',
    changeNote: '年度树种结构调整备案：新增无瓣海桑',
  });
  await invalidateUnreportedSurveys('plot-donggang-3', {
    filingNo: result.filing.filingNo,
    prevVersion: result.prevVersion,
    nextVersion: result.filing.currentVersion,
    changes: result.changes,
  });
}

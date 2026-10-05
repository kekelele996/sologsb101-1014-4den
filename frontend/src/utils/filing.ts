/**
 * 备案对账工具
 * 项目部上报验收前，按地块与林业站备案对账：
 * 栽植面积（地块面积）或树种与备案不符的，先挂起并写明差在哪。
 */
import type { Plot } from '../types/plot';
import type { Seedling, SeedlingSpecies } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Filing } from '../types/filing';
import { round1 } from './rate';

/** 单条对账差异 */
export interface ReconcileDifference {
  /** 差异字段：面积 / 树种 */
  field: 'area' | 'species';
  /** 字段中文名 */
  label: string;
  /** 项目部侧（栽植台账）的值 */
  projectValue: string;
  /** 备案侧（林业站）的值 */
  filingValue: string;
  /** 面向用户的差异说明 */
  detail: string;
}

/** 对账结果 */
export interface ReconcileResult {
  ok: boolean;
  plotId: string;
  /** 地块是否已有有效备案 */
  hasFiling: boolean;
  /** 当前有效备案 */
  filing: Filing | null;
  /** 差异列表（为空表示账实相符） */
  differences: ReconcileDifference[];
  /** 项目部侧栽植面积（亩） */
  projectAreaMu: number;
  /** 项目部侧主植树种（按栽植株数加权，无栽植时退回苗木批次数量） */
  projectSpecies: SeedlingSpecies | null;
}

/** 取地块当前有效备案（status = 有效 且版本号最大） */
export function getCurrentFiling(filings: Filing[], plotId: string): Filing | null {
  let current: Filing | null = null;
  for (const row of filings) {
    if (row.plotId !== plotId) continue;
    if (row.status !== '有效') continue;
    if (current === null || row.version > current.version) current = row;
  }
  return current;
}

/**
 * 推导地块主植树种：
 * 优先按栽植记录的株数加权；没有栽植记录时退回苗木批次数量；都没有则返回 null。
 */
export function getDominantSpecies(
  seedlings: Seedling[],
  plantings: Planting[],
  plotId: string,
): SeedlingSpecies | null {
  const weight = new Map<SeedlingSpecies, number>();
  const add = (species: SeedlingSpecies, count: number): void => {
    weight.set(species, (weight.get(species) ?? 0) + count);
  };
  let hasWeight = false;
  plantings
    .filter((row) => row.plotId === plotId)
    .forEach((row) => {
      const seedling = seedlings.find((item) => item.id === row.seedlingId);
      if (seedling !== undefined) {
        add(seedling.species, row.count);
        hasWeight = true;
      }
    });
  if (!hasWeight) {
    seedlings
      .filter((row) => row.plotId === plotId)
      .forEach((row) => add(row.species, row.quantity));
  }
  let dominant: SeedlingSpecies | null = null;
  let max = 0;
  weight.forEach((count, species) => {
    if (count > max) {
      max = count;
      dominant = species;
    }
  });
  return dominant;
}

/** 面积比对容差（亩）：浮点与录入精度下允许的微小误差 */
const AREA_TOLERANCE_MU = 0.01;

/**
 * 地块与备案对账。
 * @param plot 项目部侧地块
 * @param seedlings 全部苗木批次
 * @param plantings 全部栽植记录
 * @param filing 该地块当前有效备案（null 表示未备案）
 */
export function reconcilePlot(
  plot: Plot,
  seedlings: Seedling[],
  plantings: Planting[],
  filing: Filing | null,
): ReconcileResult {
  const projectSpecies = getDominantSpecies(seedlings, plantings, plot.id);
  const differences: ReconcileDifference[] = [];

  if (filing === null) {
    return {
      ok: false,
      plotId: plot.id,
      hasFiling: false,
      filing: null,
      differences: [],
      projectAreaMu: plot.areaMu,
      projectSpecies,
    };
  }

  // 面积对账：栽植面积（地块面积）vs 备案面积
  const areaDiff = round1(plot.areaMu - filing.filingAreaMu);
  if (Math.abs(plot.areaMu - filing.filingAreaMu) > AREA_TOLERANCE_MU) {
    differences.push({
      field: 'area',
      label: '备案面积',
      projectValue: `${round1(plot.areaMu)} 亩`,
      filingValue: `${round1(filing.filingAreaMu)} 亩`,
      detail: `栽植面积 ${round1(plot.areaMu)} 亩 与备案面积 ${round1(filing.filingAreaMu)} 亩 不符（差 ${
        areaDiff > 0 ? '+' : ''
      }${areaDiff} 亩）`,
    });
  }

  // 树种对账：主植树种 vs 备案树种
  if (projectSpecies !== null && projectSpecies !== filing.filingSpecies) {
    differences.push({
      field: 'species',
      label: '备案树种',
      projectValue: projectSpecies,
      filingValue: filing.filingSpecies,
      detail: `主植树种「${projectSpecies}」与备案树种「${filing.filingSpecies}」不符`,
    });
  }

  return {
    ok: differences.length === 0,
    plotId: plot.id,
    hasFiling: true,
    filing,
    differences,
    projectAreaMu: plot.areaMu,
    projectSpecies,
  };
}

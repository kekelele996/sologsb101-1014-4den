/**
 * 上报前对账（纯函数，无 IO）
 * 项目部上报验收前，按地块把「栽植面积 / 栽植树种」与林业站备案逐项核对：
 * - 无备案：直接不符（missing-filing）
 * - 栽植面积：地块台账面积（栽植口径）与备案面积比较，给一个测绘容差
 * - 栽植树种：实际栽植（被栽植记录引用的苗木批次）树种必须落在备案树种范围内
 * 只做核对、产出差异明细，不写任何数据，便于两侧各自保存、单独测试。
 */
import type { Plot } from '../types/plot';
import type { Filing } from '../types/filing';
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import type { ReconcileDiscrepancy } from '../types/survey';
import { round1 } from './rate';

/** 面积测绘容差：相对差 0.5%，且至少 0.1 亩，避免四舍五入导致的假性不符 */
export const AREA_TOLERANCE_RATIO = 0.005;
export const AREA_TOLERANCE_MIN_MU = 0.1;

export interface PlotReconcileInput {
  plot: Plot;
  /** 该地块在林业站侧的备案（可能不存在） */
  filing: Filing | undefined;
  plantings: Planting[];
  seedlings: Seedling[];
}

export interface PlotReconcileResult {
  /** 是否全部对得上（可上报） */
  ok: boolean;
  /** 差异明细，挂起时原样写到验收记录上 */
  discrepancies: ReconcileDiscrepancy[];
  /** 项目部栽植侧面积（亩） */
  projectAreaMu: number;
  /** 项目部实际栽植树种（去重，稳定排序） */
  projectSpecies: string[];
  /** 林业站备案面积（亩），无备案为 null */
  filingAreaMu: number | null;
  /** 林业站备案树种，无备案为空数组 */
  filingSpecies: string[];
}

/** 面积差是否落在测绘容差内 */
export function areaWithinTolerance(projectArea: number, filingArea: number): boolean {
  const tolerance = Math.max(AREA_TOLERANCE_MIN_MU, Math.abs(filingArea) * AREA_TOLERANCE_RATIO);
  return Math.abs(projectArea - filingArea) <= tolerance;
}

/** 取地块实际栽植涉及的树种（被栽植记录引用的苗木批次） */
export function plantedSpeciesOf(plotId: string, plantings: Planting[], seedlings: Seedling[]): string[] {
  const seedlingIds = new Set(plantings.filter((row) => row.plotId === plotId).map((row) => row.seedlingId));
  const set = new Set<string>();
  seedlings.forEach((row) => {
    if (row.plotId === plotId && seedlingIds.has(row.id)) set.add(row.species);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 按地块核对项目部栽植数据与林业站备案。
 * 不抛异常：任何不符都体现在 discrepancies 里，由调用方决定挂起哪些验收记录。
 */
export function reconcilePlotWithFiling(input: PlotReconcileInput): PlotReconcileResult {
  const { plot, filing, plantings, seedlings } = input;
  const projectAreaMu = round1(plot.areaMu);
  const projectSpecies = plantedSpeciesOf(plot.id, plantings, seedlings);

  if (filing === undefined) {
    return {
      ok: false,
      discrepancies: [
        {
          kind: 'missing-filing',
          projectValue: `栽植面积 ${projectAreaMu} 亩 / 树种 ${projectSpecies.join('、') || '（无）'}`,
          filingValue: '林业站侧查无备案',
          detail: `地块「${plot.name}」在上级林业站没有备案记录，须先完成备案才能上报验收。`,
        },
      ],
      projectAreaMu,
      projectSpecies,
      filingAreaMu: null,
      filingSpecies: [],
    };
  }

  const filingAreaMu = round1(filing.areaMu);
  const filingSpecies = [...filing.species].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const discrepancies: ReconcileDiscrepancy[] = [];

  // 1) 面积对账
  if (!areaWithinTolerance(projectAreaMu, filingAreaMu)) {
    const diff = round1(projectAreaMu - filingAreaMu);
    discrepancies.push({
      kind: 'area',
      projectValue: `栽植面积 ${projectAreaMu} 亩`,
      filingValue: `备案面积 ${filingAreaMu} 亩（${filing.filingNo} v${filing.currentVersion}）`,
      detail: `栽植面积与备案面积相差 ${Math.abs(diff)} 亩（${diff > 0 ? '栽植侧偏大' : '备案侧偏大'}），超出测绘容差 ±${
        AREA_TOLERANCE_MIN_MU
      } 亩 / 0.5%。`,
    });
  }

  // 2) 树种对账：实际栽植树种必须全部在备案树种范围内
  const notFiled = projectSpecies.filter((name) => !(filingSpecies as string[]).includes(name));
  if (notFiled.length > 0) {
    discrepancies.push({
      kind: 'species',
      projectValue: `实际栽植树种 ${projectSpecies.join('、') || '（无）'}`,
      filingValue: `备案树种 ${filingSpecies.join('、') || '（无）'}（${filing.filingNo} v${filing.currentVersion}）`,
      detail: `实际栽植的 ${notFiled.join('、')} 不在备案树种范围内，须先到林业站变更备案树种后再上报。`,
    });
  }

  return {
    ok: discrepancies.length === 0,
    discrepancies,
    projectAreaMu,
    projectSpecies,
    filingAreaMu,
    filingSpecies,
  };
}

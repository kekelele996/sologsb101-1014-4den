/**
 * usePlotReconcile 地块级对账 hook
 * 汇总项目部地块 / 栽植 / 苗木批次与林业站备案，按地块产出对账结果；
 * 纯计算来自 utils/reconcile，数据来自两个独立的本地库（已由各自 store 订阅）。
 * 被地块台账、验收台、林业站备案台复用，保证「上报前对账」口径唯一。
 */
import { useMemo } from 'react';
import type { Plot } from '../types/plot';
import type { Filing } from '../types/filing';
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import { reconcilePlotWithFiling, type PlotReconcileResult } from '../utils/reconcile';

export interface PlotReconcileInputBundle {
  plots: Plot[];
  filings: Filing[];
  plantings: Planting[];
  seedlings: Seedling[];
}

export interface PlotReconcileMap {
  [plotId: string]: PlotReconcileResult;
}

export function buildPlotReconcileMap(bundle: PlotReconcileInputBundle): PlotReconcileMap {
  const { plots, filings, plantings, seedlings } = bundle;
  const map: PlotReconcileMap = {};
  plots.forEach((plot) => {
    const filing = filings.find((item) => item.plotId === plot.id);
    map[plot.id] = reconcilePlotWithFiling({ plot, filing, plantings, seedlings });
  });
  return map;
}

/** 按地块查对账结果；两侧数据变化（liveQuery 回灌）时自动重算 */
export function usePlotReconcile(bundle: PlotReconcileInputBundle): {
  map: PlotReconcileMap;
  resultOf: (plotId: string) => PlotReconcileResult | undefined;
  /** 至少有一条差异的地块数 */
  mismatchCount: number;
} {
  const map = useMemo(() => buildPlotReconcileMap(bundle), [bundle.plots, bundle.filings, bundle.plantings, bundle.seedlings]);
  return useMemo(
    () => ({
      map,
      resultOf: (plotId: string) => map[plotId],
      mismatchCount: Object.values(map).filter((item) => !item.ok).length,
    }),
    [map],
  );
}

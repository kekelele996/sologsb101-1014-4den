/**
 * 冒烟测试（node + fake-indexeddb + tsx）：覆盖两侧分离的核心业务规则
 * 1) 首装：项目部播种 + 站侧历史补录/演示播种
 * 2) 上报前对账：符合上报冻结、不符挂起并写明差异
 * 3) 备案改动：未上报失效、已上报留原值并标注依据版本、失效可重算
 * 4) 两侧各自保存：项目部删除地块时站侧独立清理
 * 运行：node_modules/.bin/tsx scripts/smoke.ts
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert';
import { db, initDatabase, exportSnapshot } from '../src/utils/db.ts';
import { stationDb, initStationDatabase } from '../src/utils/stationDb.ts';
import { ensureHistoryFilings, seedStationDatabase } from '../src/filingBackfill.ts';
import { useFilingStore } from '../src/stores/filingStore.ts';
import { useSurveyStore } from '../src/stores/surveyStore.ts';
import { usePlotStore } from '../src/stores/plotStore.ts';
import { reconcilePlotWithFiling } from '../src/utils/reconcile.ts';

async function main() {
  /* 1) 首装播种 */
  await initDatabase();
  await initStationDatabase();
  await usePlotStore.getState().loadAll();
  await useFilingStore.getState().init();

  const plots = await db.plots.toArray();
  assert.strictEqual(plots.length, 3, '应有 3 个演示地块');
  const filings = await stationDb.filings.toArray();
  assert.strictEqual(filings.length, 3, '站侧应有 3 份备案');

  const surveyA3 = await db.surveys.get('survey-a3');
  assert.strictEqual(surveyA3?.workflow, 'reported', '东港第3测次应为已上报');
  assert.strictEqual(surveyA3?.basis?.filingNo, 'BL-2024-001', '依据备案号');
  assert.strictEqual(surveyA3?.basis?.version, 1, '应冻结在 v1');
  assert.strictEqual(surveyA3?.reportedRate, 79, '冻结成活率 79%');

  const surveyA1 = await db.surveys.get('survey-a1');
  assert.strictEqual(surveyA1?.workflow, 'stale', '东港第1测次备案 v2 后应失效');
  assert.ok(surveyA1?.staleReason.includes('v2'), '失效原因应指向 v2');

  /* 2) 上报对账：西湾实际树种含秋茄+白骨壤，备案也是两者，但播种未改西湾，对账应通过 */
  const xiwan = plots.find((p) => p.id === 'plot-xiwan-a')!;
  const xiwanFiling = filings.find((f) => f.plotId === xiwan.id)!;
  const xiwanPlantings = await db.plantings.where('plotId').equals(xiwan.id).toArray();
  const xiwanSeedlings = await db.seedlings.where('plotId').equals(xiwan.id).toArray();
  const okReconcile = reconcilePlotWithFiling({
    plot: xiwan,
    filing: xiwanFiling,
    plantings: xiwanPlantings,
    seedlings: xiwanSeedlings,
  });
  assert.strictEqual(okReconcile.ok, true, '西湾面积树种应对得上');

  // 人为改大项目部地块面积制造不符 → 对账失败并写差异
  const mismatch = reconcilePlotWithFiling({
    plot: { ...xiwan, areaMu: 99 },
    filing: xiwanFiling,
    plantings: xiwanPlantings,
    seedlings: xiwanSeedlings,
  });
  assert.strictEqual(mismatch.ok, false, '面积差很大应对账失败');
  assert.ok(mismatch.discrepancies.some((d) => d.kind === 'area'), '应有面积差异');
  assert.ok(mismatch.discrepancies[0].detail.includes('亩'), '差异应写明差多少亩');

  // 树种不符：备案树种去掉秋茄
  const speciesMismatch = reconcilePlotWithFiling({
    plot: xiwan,
    filing: { ...xiwanFiling, species: ['白骨壤'] },
    plantings: xiwanPlantings,
    seedlings: xiwanSeedlings,
  });
  assert.ok(speciesMismatch.discrepancies.some((d) => d.kind === 'species'), '应有树种差异');

  /* 3) store 级上报：西湾 b1/b2 通过上报冻结 */
  const xiwanSurveys = await db.surveys.where('plotId').equals(xiwan.id).toArray();
  const result = await useSurveyStore.getState().reportSurveys(xiwanSurveys.map((s) => s.id));
  assert.strictEqual(result.reported, 2, '西湾 2 条应上报成功');
  assert.strictEqual(result.held, 0, '不应有挂起');
  for (const s of xiwanSurveys) {
    const fresh = await db.surveys.get(s.id);
    assert.strictEqual(fresh?.workflow, 'reported');
    assert.strictEqual(fresh?.basis?.filingNo, 'BL-2024-002');
  }

  // 西湾备案再改面积：已上报的留原值（仍 reported），依据仍标注版本
  await useFilingStore.getState().change('BL-2024-002', {
    areaMu: 40,
    filedAt: '2025-06-01',
    changeNote: '面积核增',
  });
  for (const s of xiwanSurveys) {
    const fresh = await db.surveys.get(s.id);
    assert.strictEqual(fresh?.workflow, 'reported', '已上报记录备案改动后仍冻结');
    assert.strictEqual(fresh?.basis?.version, 1, '依据版本仍是上报时的 v1');
  }
  const xiwanFilingV2 = await stationDb.filings.get('BL-2024-002');
  assert.strictEqual(xiwanFilingV2?.currentVersion, 2, '备案应已到 v2');
  const revs = await stationDb.filingRevisions.where('filingNo').equals('BL-2024-002').toArray();
  assert.strictEqual(revs.length, 2, '西湾应有 2 条版本流水');

  /* 4) 失效重算 */
  await useSurveyStore.getState().recalc('survey-a1');
  const a1 = await db.surveys.get('survey-a1');
  assert.strictEqual(a1.workflow, 'draft', '重算后恢复草稿');
  assert.strictEqual(a1.staleReason, '', '失效原因清空');

  // 已上报不能重算/删除/编辑
  await assert.rejects(() => useSurveyStore.getState().recalc('survey-a3'), /冻结/);
  await assert.rejects(() => useSurveyStore.getState().deleteSurvey('survey-a3'), /已上报/);

  /* 5) 无备案地块上报挂起：删掉北屿备案再上报 */
  const beiyu = plots.find((p) => p.id === 'plot-beiyu-b')!;
  const { removeFilingForPlot } = await import('../src/utils/stationDb.ts');
  await removeFilingForPlot(beiyu.id);
  const beiyuSurveys = await db.surveys.where('plotId').equals(beiyu.id).toArray();
  const r2 = await useSurveyStore.getState().reportSurveys(beiyuSurveys.map((s) => s.id));
  assert.strictEqual(r2.held, 2, '无备案地块验收应挂起 2 条');
  for (const s of beiyuSurveys) {
    const fresh = await db.surveys.get(s.id);
    assert.strictEqual(fresh?.workflow, 'held');
    assert.ok(fresh?.discrepancies.some((d) => d.kind === 'missing-filing'));
  }

  /* 6) 两侧各自保存：快照只含项目部表 */
  const snap = await exportSnapshot();
  assert.ok(!('filings' in snap), '项目部快照不含备案');

  console.log('✅ 全部冒烟断言通过');
  console.log('  - 首装播种 / 历史补录 / 站侧演示');
  console.log('  - 上报前对账：符合冻结、面积/树种/无备案不符挂起并写明差异');
  console.log('  - 备案改动：未上报失效、已上报留原值标注依据版本、可重算');
  console.log('  - 已上报记录禁止重算/删除');
  console.log('  - 项目部快照不含站侧备案（两侧分开）');
  await db.close();
  await stationDb.close();
}

main().catch((err) => {
  console.error('❌ 冒烟测试失败:', err);
  process.exit(1);
});

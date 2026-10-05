/**
 * 升级路径冒烟：模拟旧 v2 库（验收无工作流字段、站侧库不存在）打开后：
 * - v3 迁移把旧验收补成 draft
 * - 旧地块自动补历史备案；无实际栽植的地块补不上 → backfillFailures 只读保留、可重试
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert';
import Dexie from 'dexie';
import { db } from '../src/utils/db.ts';
import { stationDb } from '../src/utils/stationDb.ts';
import { ensureHistoryFilings } from '../src/utils/filingBackfill.ts';

async function main() {
  // 手工建一个 v2 结构的旧库
  const legacy = new Dexie('gbmangrove');
  legacy.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });
  await legacy.open();
  await legacy.table('plots').bulkPut([
    // 有栽植、可补历史备案
    {
      id: 'old-1', name: '旧地块一', areaMu: 10, tideZone: '低', substrate: '砂质',
      restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', revision: 2,
    },
    // 无栽植、无法确定树种 → 补不上
    {
      id: 'old-2', name: '旧地块二', areaMu: 20, tideZone: '高', substrate: '淤泥质',
      restoreMode: '自然恢复', state: '跟踪中', missingCount: 0, lastReplantDate: '',
      createdAt: '2024-02-01T00:00:00.000Z', updatedAt: '2024-02-01T00:00:00.000Z', revision: 2,
    },
  ]);
  await legacy.table('seedlings').put({
    id: 'os1', plotId: 'old-1', species: '秋茄', source: '自育苗', spec: '50cm',
    quantity: 500, arrivalDate: '2024-03-01',
    createdAt: '2024-03-01T00:00:00.000Z', updatedAt: '2024-03-01T00:00:00.000Z', revision: 2,
  });
  await legacy.table('plantings').put({
    id: 'op1', plotId: 'old-1', seedlingId: 'os1', plantDate: '2024-03-05',
    spacingM: 1, count: 480, operator: '一班',
    createdAt: '2024-03-05T00:00:00.000Z', updatedAt: '2024-03-05T00:00:00.000Z', revision: 2,
  });
  // 旧验收：故意不带任何 v3 字段
  await legacy.table('surveys').put({
    id: 'osv1', plotId: 'old-1', round: 1, date: '2024-06-01', aliveCount: 400,
    avgHeightCm: 50, survivalRate: 83.3, grade: 'good', gradeManual: false,
    createdAt: '2024-06-01T00:00:00.000Z', updatedAt: '2024-06-01T00:00:00.000Z', revision: 2,
  });
  await legacy.close();

  // 用当前（v3）结构打开 → 触发升级
  await db.open();
  const migrated = await db.surveys.get('osv1');
  assert.strictEqual(migrated?.workflow, 'draft', '旧验收应迁移为未上报');
  assert.strictEqual(migrated?.basis, null);
  assert.deepStrictEqual(migrated?.discrepancies, []);

  // 历史补录
  const outcome = await ensureHistoryFilings();
  assert.strictEqual(outcome.filled, 1, '旧地块一应补成功');
  assert.strictEqual(outcome.failed, 1, '旧地块二应补不上');
  assert.strictEqual(outcome.skipped, 0);

  const f1 = await stationDb.filings.where('plotId').equals('old-1').first();
  assert.ok(f1, '旧地块一应存在备案');
  assert.strictEqual(f1?.source, 'history-backfill', '来源应为历史补录');
  assert.strictEqual(f1?.areaMu, 10);
  assert.deepStrictEqual(f1?.species, ['秋茄']);
  assert.strictEqual(f1?.currentVersion, 1);

  const failures = await stationDb.backfillFailures.toArray();
  assert.strictEqual(failures.length, 1, '应有 1 条补录失败只读留痕');
  assert.strictEqual(failures[0].plotId, 'old-2');
  assert.ok(failures[0].reason.includes('树种'));

  // 旧地块二后来补了栽植 → 重试补录应成功并清掉失败留痕
  await db.seedlings.put({
    id: 'os2', plotId: 'old-2', species: '桐花树', source: '外购', spec: '40cm',
    quantity: 300, arrivalDate: '2024-07-01',
    createdAt: '2024-07-01T00:00:00.000Z', updatedAt: '2024-07-01T00:00:00.000Z', revision: 3,
  });
  await db.plantings.put({
    id: 'op2', plotId: 'old-2', seedlingId: 'os2', plantDate: '2024-07-05',
    spacingM: 1.1, count: 290, operator: '二班',
    createdAt: '2024-07-05T00:00:00.000Z', updatedAt: '2024-07-05T00:00:00.000Z', revision: 3,
  });
  const retry = await ensureHistoryFilings();
  assert.strictEqual(retry.filled, 1);
  const failuresAfter = await stationDb.backfillFailures.toArray();
  assert.strictEqual(failuresAfter.length, 0, '补录成功后失败留痕应清除');
  const f2 = await stationDb.filings.where('plotId').equals('old-2').first();
  assert.ok(f2, '旧地块二重试后应有备案');
  assert.deepStrictEqual(f2?.species, ['桐花树']);

  console.log('✅ 升级路径断言通过：v2→v3 迁移、历史补录、补不上只读留痕、补齐后重试成功');
  await db.close();
  await stationDb.close();
}

main().catch((err) => {
  console.error('❌ 升级冒烟测试失败:', err);
  process.exit(1);
});

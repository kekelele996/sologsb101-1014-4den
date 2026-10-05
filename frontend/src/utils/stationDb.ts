/**
 * 林业站侧持久化层（独立 IndexedDB 库，与项目部侧 gbmangrove 物理分开）
 * - 库名：gbmangrove-station
 * - 只管备案：备案当前值（filings）、不可变版本流水（filingRevisions）
 * - 历史备案补不上的地块：backfillFailures（只读留着，可手动重试）
 * - 站侧写入存不上：withStationRetry 只重试站侧自己这一笔，绝不回滚 / 重试项目部数据；
 *   重试用尽后写入 stationWriteFailures 死信队列，供林业站侧稍后重放。
 */
import Dexie, { type Table } from 'dexie';
import type { BackfillFailure, Filing, FilingRevision, FilingSource } from '../types/filing';
import type { SeedlingSpecies } from '../types/seedling';
import { nowIso, uuid } from './id';

/** 林业站侧数据库名（与项目部库 gbmangrove 分开） */
export const STATION_DB_NAME = 'gbmangrove-station';
export const STATION_SCHEMA_VERSION = 1;
export const STATION_ROW_REVISION = 1;

/** 最大尝试次数（含首次） */
const MAX_ATTEMPTS = 3;
/** 退避基数（毫秒）：200、400 */
const RETRY_BASE_MS = 200;

/** 站侧写入失败死信：存不上的那笔操作只在这里留痕、只重试它自己 */
export interface StationWriteFailure {
  id: string;
  /** 操作类型：register / change / backfill */
  op: string;
  /** 人类可读的操作摘要，用于列表展示 */
  summary: string;
  /** 最近一次错误信息 */
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

class StationDatabase extends Dexie {
  filings!: Table<Filing, string>;
  filingRevisions!: Table<FilingRevision, string>;
  backfillFailures!: Table<BackfillFailure, string>;
  stationWriteFailures!: Table<StationWriteFailure, string>;

  constructor() {
    super(STATION_DB_NAME);
    this.version(STATION_SCHEMA_VERSION).stores({
      filings: 'filingNo, plotId, currentVersion, filedAt',
      filingRevisions: 'id, filingNo, plotId, version, filedAt',
      backfillFailures: 'id, plotId, attempts',
      stationWriteFailures: 'id, op, attempts, updatedAt',
    });
  }
}

export const stationDb = new StationDatabase();

let stationInitPromise: Promise<void> | null = null;

/** 打开林业站侧数据库（幂等，多次调用共用一个 Promise） */
export function initStationDatabase(): Promise<void> {
  if (stationInitPromise === null) {
    stationInitPromise = stationDb.open().then(() => undefined);
  }
  return stationInitPromise;
}

/* ------------------------------ 站侧重试 ------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 仅重试「林业站侧」这一笔操作：指数退避，最多 MAX_ATTEMPTS 次。
 * 项目部侧数据不在事务内，因此站侧失败绝不影响项目库，也不会触发项目部任何重试。
 */
export async function withStationRetry<T>(desc: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await initStationDatabase();
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  // 重试用尽：只把站侧这笔记入死信队列（记队列本身也走一次重试）
  await appendStationWriteFailure(desc, message, MAX_ATTEMPTS).catch(() => undefined);
  throw new Error(`林业站侧保存失败（已重试 ${MAX_ATTEMPTS} 次）：${message}`);
}

/** 追加一条站侧写入失败死信；队列本身写不进时抛错由调用方降级提示 */
async function appendStationWriteFailure(summary: string, error: string, attempts: number): Promise<void> {
  const stamp = nowIso();
  await stationDb.stationWriteFailures.put({
    id: uuid('swf'),
    op: 'save',
    summary,
    error,
    attempts,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

export async function listStationWriteFailures(): Promise<StationWriteFailure[]> {
  const rows = await stationDb.stationWriteFailures.toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function clearStationWriteFailure(id: string): Promise<void> {
  await stationDb.stationWriteFailures.delete(id);
}

/**
 * 清除某条死信前的手动重放入口：由调用方提供重放函数，成功则删信、失败则更新错误。
 * 只重试这一条，不连带其他数据。
 */
export async function replayStationWriteFailure(
  failureId: string,
  replay: () => Promise<void>,
): Promise<void> {
  await withStationRetry('手动重放站侧写入', replay);
  await stationDb.stationWriteFailures.delete(failureId);
}

/* --------------------------- 同一备案串行化 --------------------------- */

/** 同一 filingNo 的变更排队执行，避免并发改动导致版本号错乱 */
const filingLocks = new Map<string, Promise<unknown>>();

async function withFilingLock<T>(filingNo: string, fn: () => Promise<T>): Promise<T> {
  const prev = filingLocks.get(filingNo) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  filingLocks.set(
    filingNo,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await next;
  } finally {
    if (filingLocks.get(filingNo) === next) filingLocks.delete(filingNo);
  }
}

/* -------------------------------- 读 -------------------------------- */

export async function listFilings(): Promise<Filing[]> {
  const rows = await stationDb.filings.toArray();
  return rows.sort((a, b) => a.filingNo.localeCompare(b.filingNo, 'zh-Hans-CN'));
}

export async function getFilingByPlot(plotId: string): Promise<Filing | undefined> {
  return stationDb.filings.where('plotId').equals(plotId).first();
}

export async function getFiling(filingNo: string): Promise<Filing | undefined> {
  return stationDb.filings.get(filingNo);
}

export async function listFilingRevisions(filingNo?: string): Promise<FilingRevision[]> {
  const rows =
    filingNo === undefined
      ? await stationDb.filingRevisions.toArray()
      : await stationDb.filingRevisions.where('filingNo').equals(filingNo).toArray();
  return rows.sort((a, b) => b.filingNo.localeCompare(a.filingNo) || b.version - a.version);
}

export async function listBackfillFailures(): Promise<BackfillFailure[]> {
  const rows = await stationDb.backfillFailures.toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function upsertBackfillFailure(input: Omit<BackfillFailure, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<void> {
  const existing = input.id ? await stationDb.backfillFailures.get(input.id) : undefined;
  const stamp = nowIso();
  await stationDb.backfillFailures.put({
    id: input.id ?? uuid('bff'),
    plotId: input.plotId,
    reason: input.reason,
    attempts: input.attempts,
    lastError: input.lastError,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  });
}

export async function removeBackfillFailure(plotId: string): Promise<void> {
  const rows = await stationDb.backfillFailures.where('plotId').equals(plotId).toArray();
  await stationDb.backfillFailures.bulkDelete(rows.map((row) => row.id));
}

/* -------------------------------- 写 -------------------------------- */

export interface RegisterFilingInput {
  filingNo: string;
  plotId: string;
  areaMu: number;
  species: SeedlingSpecies[];
  filedAt: string;
  changeNote: string;
  source: FilingSource;
}

function dedupeSpecies(species: SeedlingSpecies[]): SeedlingSpecies[] {
  return Array.from(new Set(species));
}

/** 登记首版备案（v1）：备案当前值 + 首条版本流水同一事务落库，站侧失败只重试自己 */
export async function registerFiling(input: RegisterFilingInput): Promise<{ filing: Filing; revision: FilingRevision }> {
  return withStationRetry(`登记备案 ${input.filingNo}`, () =>
    withFilingLock(input.filingNo, async () => {
      const stamp = nowIso();
      const species = dedupeSpecies(input.species);
      const filing: Filing = {
        filingNo: input.filingNo,
        plotId: input.plotId,
        areaMu: input.areaMu,
        species,
        currentVersion: 1,
        filedAt: input.filedAt,
        changeNote: input.changeNote,
        source: input.source,
        createdAt: stamp,
        updatedAt: stamp,
        revision: STATION_ROW_REVISION,
      };
      const revision: FilingRevision = {
        id: uuid('frev'),
        filingNo: input.filingNo,
        plotId: input.plotId,
        version: 1,
        areaMu: input.areaMu,
        species,
        filedAt: input.filedAt,
        changeNote: input.changeNote,
        source: input.source,
        createdAt: stamp,
      };
      await stationDb.transaction('rw', stationDb.filings, stationDb.filingRevisions, async () => {
        if ((await stationDb.filings.get(input.filingNo)) !== undefined) {
          throw new Error(`备案号 ${input.filingNo} 已存在，不能重复登记`);
        }
        await stationDb.filings.put(filing);
        await stationDb.filingRevisions.put(revision);
      });
      return { filing, revision };
    }),
  );
}

export interface ChangeFilingInput {
  /** 新备案面积；不传表示面积不变 */
  areaMu?: number;
  /** 新备案树种全集；不传表示树种不变 */
  species?: SeedlingSpecies[];
  filedAt: string;
  changeNote: string;
}

export interface ChangeFilingResult {
  filing: Filing;
  revision: FilingRevision;
  prevVersion: number;
  /** 变更项描述，如「面积 46.5 → 50 亩」「树种 秋茄、桐花树 → 秋茄、桐花树、无瓣海桑」 */
  changes: string[];
}

function speciesText(list: SeedlingSpecies[]): string {
  return list.length > 0 ? list.join('、') : '（空）';
}

/**
 * 备案改动：面积或树种变化时产生一个新版本，旧版本只读保留。
 * 没有任何实质变化时抛错，避免产生空版本。
 */
export async function changeFiling(filingNo: string, input: ChangeFilingInput): Promise<ChangeFilingResult> {
  return withStationRetry(`备案变更 ${filingNo}`, () =>
    withFilingLock(filingNo, async () => {
      const current = await stationDb.filings.get(filingNo);
      if (current === undefined) throw new Error(`备案 ${filingNo} 不存在，无法变更`);

      const nextArea = input.areaMu ?? current.areaMu;
      const nextSpecies = input.species !== undefined ? dedupeSpecies(input.species) : current.species;
      const changes: string[] = [];
      if (nextArea !== current.areaMu) {
        changes.push(`面积 ${current.areaMu} → ${nextArea} 亩`);
      }
      const sameSpecies =
        nextSpecies.length === current.species.length &&
        nextSpecies.every((name) => current.species.includes(name));
      if (!sameSpecies) {
        changes.push(`树种 ${speciesText(current.species)} → ${speciesText(nextSpecies)}`);
      }
      if (changes.length === 0) {
        throw new Error('面积与树种均无变化，无需生成新版本');
      }

      const nextVersion = current.currentVersion + 1;
      const stamp = nowIso();
      const filing: Filing = {
        ...current,
        areaMu: nextArea,
        species: nextSpecies,
        currentVersion: nextVersion,
        filedAt: input.filedAt,
        changeNote: input.changeNote,
        updatedAt: stamp,
      };
      const revision: FilingRevision = {
        id: uuid('frev'),
        filingNo,
        plotId: current.plotId,
        version: nextVersion,
        areaMu: nextArea,
        species: nextSpecies,
        filedAt: input.filedAt,
        changeNote: input.changeNote,
        source: 'formal',
        createdAt: stamp,
      };
      await stationDb.transaction('rw', stationDb.filings, stationDb.filingRevisions, async () => {
        await stationDb.filings.put(filing);
        await stationDb.filingRevisions.put(revision);
      });
      return { filing, revision, prevVersion: current.currentVersion, changes };
    }),
  );
}

/** 删除地块时清理林业站侧该地块的备案、版本流水与补录失败（站侧独立事务） */
export async function removeFilingForPlot(plotId: string): Promise<void> {
  await withStationRetry(`清理地块 ${plotId} 的备案`, async () => {
    const filing = await stationDb.filings.where('plotId').equals(plotId).first();
    await stationDb.transaction(
      'rw',
      stationDb.filings,
      stationDb.filingRevisions,
      stationDb.backfillFailures,
      async () => {
        if (filing !== undefined) {
          await stationDb.filings.delete(filing.filingNo);
          await stationDb.filingRevisions.where('filingNo').equals(filing.filingNo).delete();
        }
        const failures = await stationDb.backfillFailures.where('plotId').equals(plotId).toArray();
        await stationDb.backfillFailures.bulkDelete(failures.map((row) => row.id));
      },
    );
  });
}

/** 清空林业站侧全部备案数据（备案 / 版本流水 / 补录失败）；死信留痕保留 */
export async function clearStationData(): Promise<void> {
  await withStationRetry('清空林业站备案', async () => {
    await stationDb.transaction(
      'rw',
      stationDb.filings,
      stationDb.filingRevisions,
      stationDb.backfillFailures,
      async () => {
        await Promise.all([
          stationDb.filings.clear(),
          stationDb.filingRevisions.clear(),
          stationDb.backfillFailures.clear(),
        ]);
      },
    );
  });
}

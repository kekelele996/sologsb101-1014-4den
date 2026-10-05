/**
 * 林业站备案（Filing）—— 林业站侧职责
 * 与项目部侧（地块 / 栽植 / 验收）各自保存：本表只存上级林业站的备案记录。
 * 备案号随地块固定；面积或树种每次改动产生一个新版本（FilingRevision，只读流水）。
 */
import type { SeedlingSpecies } from './seedling';

/** 备案来源：正式备案 / 升级时按现有地块补的历史备案 */
export type FilingSource = 'formal' | 'history-backfill';

export const FILING_SOURCE_LABEL: Record<FilingSource, string> = {
  formal: '正式备案',
  'history-backfill': '历史补录',
};

/** 一个地块对应一条备案当前值（备案号 + 当前面积 + 当前树种集） */
export interface Filing {
  /** 主键：备案号 */
  filingNo: string;
  /** 备案对应的地块 id（项目部侧地块） */
  plotId: string;
  /** 当前备案面积（亩） */
  areaMu: number;
  /** 当前备案树种（一个地块可备案多个树种，有序去重） */
  species: SeedlingSpecies[];
  /** 当前版本号，从 1 起；改动 +1 */
  currentVersion: number;
  /** 最新备案/变更日期 YYYY-MM-DD */
  filedAt: string;
  /** 最新变更说明（改动原因） */
  changeNote: string;
  /** 来源 */
  source: FilingSource;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/**
 * 备案版本流水：不可变。
 * 项目部「已上报」的验收结论冻结在某个版本上，凭 filingNo + version 标明依据哪一版。
 */
export interface FilingRevision {
  id: string;
  /** 备案号 */
  filingNo: string;
  plotId: string;
  /** 版本号，从 1 起 */
  version: number;
  /** 该版本的备案面积（亩） */
  areaMu: number;
  /** 该版本的备案树种 */
  species: SeedlingSpecies[];
  /** 备案/变更日期 YYYY-MM-DD */
  filedAt: string;
  /** 变更说明；首版为备案登记说明 */
  changeNote: string;
  source: FilingSource;
  createdAt: string;
}

/** 历史备案补录失败记录：补不上的地块只读留着，可在林业站侧手动重试 */
export interface BackfillFailure {
  id: string;
  plotId: string;
  /** 补不上的原因，如「无法确定备案树种（地块尚无苗木批次）」 */
  reason: string;
  attempts: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 变更备案的表单草稿 */
export interface FilingDraft {
  plotId: string;
  filingNo: string;
  areaMu: number;
  species: SeedlingSpecies[];
  filedAt: string;
  changeNote: string;
}

/** 验收上报时冻结在验收记录上的备案依据快照 */
export interface FilingBasis {
  filingNo: string;
  version: number;
  areaMu: number;
  species: SeedlingSpecies[];
  filedAt: string;
}

/** 由备案某版本构造上报依据快照 */
export function toFilingBasis(
  filing: Pick<Filing, 'filingNo'>,
  rev: Pick<FilingRevision, 'version' | 'areaMu' | 'species' | 'filedAt'>,
): FilingBasis {
  return {
    filingNo: filing.filingNo,
    version: rev.version,
    areaMu: rev.areaMu,
    species: [...rev.species],
    filedAt: rev.filedAt,
  };
}

/**
 * 成活率验收（Survey）
 * 按测次登记成活株数与平均株高，成活率由成活株数 / 栽植总株数派生。
 */

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

export interface Survey {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……） */
  round: number;
  /** 验收日期 YYYY-MM-DD */
  date: string;
  /** 成活株数 */
  aliveCount: number;
  /** 平均株高（厘米） */
  avgHeightCm: number;
  /** 成活率（百分比，保留 1 位小数）——默认由成活株数 / 栽植总株数派生 */
  survivalRate: number;
  /** 成活率等级——默认按区间自动判定，可人工批量调整 */
  grade: RateLevel;
  /** 该等级是否被人工调整过 */
  gradeManual: boolean;
  /** 上报状态：未上报 / 已上报（上报后冻结成活率与备案依据） */
  reportState: SurveyReportState;
  /** 上报时间 YYYY-MM-DDTHH:mm:ss.sssZ */
  reportedAt: string;
  /** 上报时依据的备案 id */
  basedOnFilingId: string;
  /** 上报时依据的备案版本号（冻结，备案改动后不再变化） */
  basedOnFilingVersion: number | null;
  /** 上报时依据的备案号（快照，便于通报时直接引用） */
  basedOnFilingNo: string;
  /** 上报时备案面积（亩）快照 */
  filingAreaMuSnapshot: number | null;
  /** 上报时备案树种快照 */
  filingSpeciesSnapshot: string;
  /** 未上报验收结论是否已失效（备案改动后置为 true，需重算后才能上报） */
  stale: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 验收上报状态：未上报 / 已上报 */
export type SurveyReportState = 'draft' | 'reported';

export const SURVEY_REPORT_STATE_LABEL: Record<SurveyReportState, string> = {
  draft: '未上报',
  reported: '已上报',
};

/** 新建 / 编辑验收记录的表单草稿 */
export interface SurveyDraft {
  plotId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
}

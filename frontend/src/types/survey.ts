/**
 * 成活率验收（Survey）—— 项目部侧职责
 * 按测次登记成活株数与平均株数，成活率由成活株数 / 栽植总株数派生。
 *
 * 上报验收工作流（与林业站备案两侧分开）：
 * - draft   草稿：录入后默认状态，未上报
 * - held    挂起：上报前按地块跟备案对账，栽植面积或树种与备案不符时挂起，写明差在哪
 * - stale   失效：备案改动后，尚未上报的验收结论自动失效，需重算
 * - reported 已上报：冻结当时成活率，并标注依据哪一版备案（basis），备案再改也留原值
 */

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

/** 验收结论上报状态 */
export type SurveyWorkflow = 'draft' | 'held' | 'stale' | 'reported';

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

export const SURVEY_WORKFLOW_LABEL: Record<SurveyWorkflow, string> = {
  draft: '未上报',
  held: '已挂起',
  stale: '已失效',
  reported: '已上报',
};

/** 一条对账差异（面积 / 树种） */
export interface ReconcileDiscrepancy {
  /** 差异类型：面积不符 / 树种不符 / 无备案 */
  kind: 'area' | 'species' | 'missing-filing';
  /** 项目部栽植侧的值（文案） */
  projectValue: string;
  /** 林业站备案侧的值（文案） */
  filingValue: string;
  /** 面向用户的差异说明，写明差在哪 */
  detail: string;
}

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

  /* ---------------- 上报 / 对账工作流（v3 新增） ---------------- */
  /** 上报状态 */
  workflow: SurveyWorkflow;
  /**
   * 已上报时冻结的成活率（%）。
   * 备案或栽植后续变化、派生值重算都不覆盖它；null 表示尚未上报、没有冻结值。
   */
  reportedRate: number | null;
  /** 已上报时冻结的成活株数 */
  reportedAliveCount: number | null;
  /** 已上报时冻结的栽植总株数（成活率口径） */
  reportedTotalCount: number | null;
  /** 上报时依据的备案版本（备案号 + 版本号 + 快照值） */
  basis: import('../types/filing').FilingBasis | null;
  /** 上报时间 ISO；未上报为 null */
  reportedAt: string | null;
  /** 挂起时的对账差异明细（workflow = held 时有值） */
  discrepancies: ReconcileDiscrepancy[];
  /** 失效原因（workflow = stale 时有值），如「备案 v2 变更：面积 46.5 → 50 亩」 */
  staleReason: string;
  /** 失效时原依据的备案版本号，便于提示重算前对的是哪一版 */
  staleFromVersion: number | null;

  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑验收记录的表单草稿 */
export interface SurveyDraft {
  plotId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
}

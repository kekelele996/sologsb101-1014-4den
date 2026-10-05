/**
 * 林业站备案（Filing）
 * 地块上报验收前必须先在上级林业站备案：备案号、备案面积、备案树种。
 * 备案独立于项目部的栽植/验收台账，备案改动会生成新版本，
 * 已上报的验收结论冻结原值并标注依据版本，未上报的失效重算。
 */
import type { SeedlingSpecies } from './seedling';

/** 备案状态：有效 / 已作废（历史版本） */
export type FilingStatus = '有效' | '已作废';

export const FILING_STATUS_OPTIONS: FilingStatus[] = ['有效', '已作废'];

export interface Filing {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 备案号 */
  filingNo: string;
  /** 备案面积（亩） */
  filingAreaMu: number;
  /** 备案树种 */
  filingSpecies: SeedlingSpecies;
  /** 版本号：每次备案改动 +1 */
  version: number;
  /** 备案状态 */
  status: FilingStatus;
  /** 备案日期 YYYY-MM-DD */
  filedAt: string;
  /** 备注 */
  note: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 变更备案的表单草稿 */
export interface FilingDraft {
  plotId: string;
  filingNo: string;
  filingAreaMu: number;
  filingSpecies: SeedlingSpecies;
  filedAt: string;
  note: string;
}

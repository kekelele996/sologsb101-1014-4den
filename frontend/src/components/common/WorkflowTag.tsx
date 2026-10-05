/**
 * <WorkflowTag> 验收结论上报状态标签
 * 未上报 / 已挂起 / 已失效 / 已上报 四态，颜色区分；
 * 已上报可附带依据版本（备案号 vN）提示。
 * 被验收台、地块台账、备案台消费。
 */
import type { ReactNode } from 'react';
import { Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, PauseCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { SURVEY_WORKFLOW_LABEL, type SurveyWorkflow } from '../../types/survey';

const COLOR: Record<SurveyWorkflow, string> = {
  draft: 'default',
  held: 'volcano',
  stale: 'orange',
  reported: 'green',
};

const ICON: Record<SurveyWorkflow, ReactNode> = {
  draft: <ClockCircleOutlined />,
  held: <PauseCircleOutlined />,
  stale: <WarningOutlined />,
  reported: <CheckCircleOutlined />,
};

interface WorkflowTagProps {
  status: SurveyWorkflow;
  /** 已上报时的依据版本文案，如「BL-2024-001 v1」 */
  basisText?: string;
  /** 挂起 / 失效时的差异或原因，悬停展示 */
  detail?: string;
}

export default function WorkflowTag({ status, basisText, detail }: WorkflowTagProps) {
  const tag = (
    <Tag color={COLOR[status]} icon={ICON[status]} style={{ marginInlineEnd: 0 }}>
      {SURVEY_WORKFLOW_LABEL[status]}
    </Tag>
  );
  const tip =
    detail ??
    (status === 'reported' && basisText !== undefined ? `已冻结原值，依据备案 ${basisText}` : undefined);
  if (tip === undefined) return tag;
  return (
    <Tooltip title={<Typography.Text style={{ color: '#fff' }}>{tip}</Typography.Text>}>{tag}</Tooltip>
  );
}

/**
 * /surveys 成活率与株高验收台
 * 按测次录入成活株数与平均株高，自动算成活率并低于阈值告警；支持批量调整成活率等级。
 * 消费模型：Survey、Plot、Planting；复用组件：<RateTag>、<EmptyPanel>、<StatBadge>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RiseOutlined,
  FallOutlined,
  SendOutlined,
  RedoOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import StatBadge from '../components/common/StatBadge';
import WorkflowTag from '../components/common/WorkflowTag';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useSurveyStore } from '../stores/surveyStore';
import { useFilingStore } from '../stores/filingStore';
import { db } from '../utils/db';
import {
  RATE_LEVEL_LABEL,
  RATE_LEVEL_OPTIONS,
  SURVEY_WORKFLOW_LABEL,
  type RateLevel,
  type Survey,
  type SurveyWorkflow,
} from '../types/survey';
import { SURVIVAL_WARN_RATE, percentText } from '../utils/rate';
import { usePlotReconcile } from '../hooks/usePlotReconcile';

interface SurveyFormValues {
  plotId: string;
  round: number;
  date: Dayjs;
  aliveCount: number;
  avgHeightCm: number;
}

export default function SurveyBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const ready = usePlotStore((state) => state.ready);
  const statOf = usePlotStore((state) => state.statOf);
  const summaryOf = usePlotStore((state) => state.summaryOf);
  const filters = useSurveyStore((state) => state.filters);
  const setFilters = useSurveyStore((state) => state.setFilters);
  const resetFilters = useSurveyStore((state) => state.resetFilters);
  const selectedIds = useSurveyStore((state) => state.selectedIds);
  const setSelectedIds = useSurveyStore((state) => state.setSelectedIds);
  const gradeDraft = useSurveyStore((state) => state.gradeDraft);
  const setGradeDraft = useSurveyStore((state) => state.setGradeDraft);
  const bulkApplyGrade = useSurveyStore((state) => state.bulkApplyGrade);
  const generateReplant = useSurveyStore((state) => state.generateReplant);
  const createSurvey = useSurveyStore((state) => state.createSurvey);
  const updateSurvey = useSurveyStore((state) => state.updateSurvey);
  const deleteSurvey = useSurveyStore((state) => state.deleteSurvey);
  const reportSurveys = useSurveyStore((state) => state.reportSurveys);
  const recalc = useSurveyStore((state) => state.recalc);
  const surveyRevision = useSurveyStore((state) => state.revision);
  const filings = useFilingStore((state) => state.filings);
  const plantings = usePlotStore((state) => state.plantings);
  const seedlings = usePlotStore((state) => state.seedlings);

  const { rows, loading, remove } = useIdbTable<Survey>(db.surveys, { sortByUpdatedAt: false });

  const reconcile = usePlotReconcile({ plots, filings, plantings, seedlings });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Survey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [form] = Form.useForm<SurveyFormValues>();

  /** 已上报记录冻结：成活率展示冻结值，等级调整 / 编辑 / 删除 / 勾选都跳过 */
  const isFrozen = (row: Survey): boolean => row.workflow === 'reported';

  /** 某条验收当前展示用的成活率：已上报用冻结值，其余用派生/实测值 */
  const displayRate = (row: Survey, derived: number | undefined): number =>
    isFrozen(row) && row.reportedRate !== null ? row.reportedRate : (derived ?? row.survivalRate);

  const filtered = useMemo(() => {
    void surveyRevision;
    const key = filters.keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.workflow !== 'all' && row.workflow !== filters.workflow) return false;
        if (filters.from !== '' && row.date < filters.from) return false;
        if (filters.to !== '' && row.date > filters.to) return false;
        if (filters.level !== 'all') {
          const summary = summaryOf(row.plotId);
          const point = summary.points.find((item) => item.surveyId === row.id);
          const level: RateLevel = isFrozen(row) ? row.grade : (point?.level ?? row.grade);
          if (level !== filters.level) return false;
        }
        if (key === '') return true;
        const plotName = plots.find((item) => item.id === row.plotId)?.name ?? '';
        return plotName.toLowerCase().includes(key) || row.date.includes(key) || `第${row.round}`.includes(key);
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.round - a.round);
    // surveyRevision 用于写操作后强制重算派生列
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, plots, summaryOf, surveyRevision]);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const workflowStats = useMemo(() => {
    const held = rows.filter((row) => row.workflow === 'held').length;
    const stale = rows.filter((row) => row.workflow === 'stale').length;
    const reported = rows.filter((row) => row.workflow === 'reported').length;
    return { held, stale, reported };
  }, [rows]);

  const stats = useMemo(() => {
    const rated = plots.filter((plot) => statOf(plot.id).surveyCount > 0);
    const warn = rated.filter((plot) => statOf(plot.id).latestRate < SURVIVAL_WARN_RATE);
    const strong = rated.filter((plot) => statOf(plot.id).latestRate >= 85);
    return {
      ratedCount: rated.length,
      warnCount: warn.length,
      strongCount: strong.length,
      strongPct: rated.length === 0 ? 0 : Math.round((strong.length / rated.length) * 1000) / 10,
      avgRate:
        rated.length === 0
          ? 0
          : Math.round((rated.reduce((acc, plot) => acc + statOf(plot.id).latestRate, 0) / rated.length) * 10) / 10,
    };
  }, [plots, statOf]);

  const openCreate = (): void => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    const nextRound = rows.filter((row) => row.plotId === plotId).length + 1;
    setEditing(null);
    form.setFieldsValue({
      plotId,
      round: nextRound,
      date: dayjs(),
      aliveCount: 0,
      avgHeightCm: 0,
    });
    setOpen(true);
  };

  const openEdit = (row: Survey): void => {
    if (isFrozen(row)) {
      message.warning('该验收结论已上报并冻结，不能编辑；只能查看依据版本。');
      return;
    }
    setEditing(row);
    form.setFieldsValue({
      plotId: row.plotId,
      round: row.round,
      date: dayjs(row.date),
      aliveCount: row.aliveCount,
      avgHeightCm: row.avgHeightCm,
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        plotId: values.plotId,
        round: values.round,
        date: values.date.format('YYYY-MM-DD'),
        aliveCount: values.aliveCount,
        avgHeightCm: values.avgHeightCm,
      };
      if (editing === null) {
        const row = await createSurvey(payload);
        message.success(`已录入第 ${row.round} 测次，成活率 ${row.survivalRate}%`);
        if (row.survivalRate < SURVIVAL_WARN_RATE) {
          message.warning(`成活率 ${row.survivalRate}% 低于告警阈值 ${SURVIVAL_WARN_RATE}%，建议生成补植计划`, 6);
        }
      } else {
        await updateSurvey(editing.id, payload);
        message.success('验收记录已更新');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkGrade = async (): Promise<void> => {
    const count = await bulkApplyGrade(gradeDraft);
    if (count === 0) {
      message.info('请先在列表中勾选需要调整等级的验收记录');
      return;
    }
    message.success(`已把 ${count} 条记录的成活率等级调整为「${RATE_LEVEL_LABEL[gradeDraft]}」`);
  };

  const handleGenerateReplant = async (): Promise<void> => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    if (plotId === '') {
      message.info('请先选择地块');
      return;
    }
    const result = await generateReplant(plotId);
    message.success(result);
  };

  /** 上报前对账并上报（可单条 / 多条，只处理未上报记录） */
  const handleReport = async (surveyIds: string[]): Promise<void> => {
    const targets = rows.filter((row) => surveyIds.includes(row.id) && row.workflow !== 'reported');
    if (targets.length === 0) {
      message.info('所选记录均已上报，无需重复上报');
      return;
    }
    setReporting(true);
    try {
      const result = await reportSurveys(targets.map((row) => row.id));
      if (result.reported > 0) message.success(`已上报 ${result.reported} 条，成活率与备案依据已冻结`);
      if (result.held > 0) {
        message.warning({
          content: `${result.held} 条因栽植面积 / 树种与备案不符已挂起，请按差异说明处理后再上报`,
          duration: 6,
        });
      }
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setReporting(false);
    }
  };

  const handleRecalc = async (row: Survey): Promise<void> => {
    try {
      await recalc(row.id);
      message.success(`第 ${row.round} 测次已按当前栽植总株数重算，恢复为未上报`);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  };

  const columns: ColumnsType<Survey> = [
    {
      title: '地块',
      key: 'plot',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            栽植总株数 {statOf(record.plotId).plantTotal.toLocaleString('zh-CN')} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '测次',
      dataIndex: 'round',
      key: 'round',
      width: 84,
      align: 'center',
      render: (value: number) => <Tag color="blue">第 {value} 次</Tag>,
      sorter: (a, b) => a.round - b.round,
    },
    { title: '验收日期', dataIndex: 'date', key: 'date', width: 128, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '成活株数',
      dataIndex: 'aliveCount',
      key: 'aliveCount',
      width: 110,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '成活率',
      key: 'rate',
      width: 190,
      render: (_value, record) => {
        const summary = summaryOf(record.plotId);
        const point = summary.points.find((item) => item.surveyId === record.id);
        const frozen = isFrozen(record);
        return (
          <Space direction="vertical" size={2}>
            <RateTag
              rate={displayRate(record, point?.rate)}
              level={frozen ? record.grade : (point?.level ?? record.grade)}
              manual={record.gradeManual}
            />
            {frozen ? <Tag color="green" style={{ marginInlineEnd: 0 }}>原值已冻结</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '平均株高',
      dataIndex: 'avgHeightCm',
      key: 'avgHeightCm',
      width: 128,
      align: 'right',
      render: (value: number, record) => {
        const summary = summaryOf(record.plotId);
        const index = summary.points.findIndex((item) => item.surveyId === record.id);
        const previous = index > 0 ? summary.points[index - 1] : null;
        return (
          <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
            <span>{value} cm</span>
            {previous !== null ? (
              <Typography.Text
                type={value >= previous.avgHeightCm ? 'success' : 'danger'}
                style={{ fontSize: 12 }}
              >
                {value >= previous.avgHeightCm ? <RiseOutlined /> : <FallOutlined />}{' '}
                {Math.abs(Math.round((value - previous.avgHeightCm) * 10) / 10)} cm
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '上报状态',
      key: 'workflow',
      width: 120,
      render: (_value, record) => {
        const basisText = record.basis !== null ? `${record.basis.filingNo} v${record.basis.version}` : undefined;
        return (
          <WorkflowTag
            status={record.workflow}
            basisText={basisText}
            detail={record.workflow === 'held' ? record.discrepancies.map((d) => d.detail).join('；') : record.staleReason || undefined}
          />
        );
      },
    },
    {
      title: '备案依据 / 差异',
      key: 'basis',
      width: 240,
      render: (_value, record) => {
        if (record.workflow === 'reported' && record.basis !== null) {
          return (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{record.basis.filingNo}</Typography.Text>
              <Tag color="blue" style={{ marginTop: 2 }}>依据 v{record.basis.version}（{record.basis.filedAt}）</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                备案面积 {record.basis.areaMu} 亩 · {record.basis.species.join('、')}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                上报口径 {record.reportedAliveCount ?? record.aliveCount}/{record.reportedTotalCount ?? 0} 株
              </Typography.Text>
            </Space>
          );
        }
        if (record.workflow === 'held') {
          return (
            <Tooltip
              title={record.discrepancies.map((d) => (
                <div key={`${record.id}-${d.kind}`}>· {d.detail}</div>
              ))}
            >
              <Space direction="vertical" size={0}>
                {record.discrepancies.map((d) => (
                  <Tag color="volcano" key={`${record.id}-${d.kind}`} style={{ marginInlineEnd: 0 }}>
                    {d.kind === 'area' ? '面积不符' : d.kind === 'species' ? '树种不符' : '无备案'}
                  </Tag>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  悬停查看差在哪
                </Typography.Text>
              </Space>
            </Tooltip>
          );
        }
        if (record.workflow === 'stale') {
          return (
            <Tooltip title={record.staleReason}>
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                {record.staleReason || '备案已变更，结论失效'}
              </Typography.Text>
            </Tooltip>
          );
        }
        const result = reconcile.resultOf(record.plotId);
        if (result !== undefined && !result.ok) {
          return (
            <Tooltip title={result.discrepancies.map((d) => (
              <div key={`${record.id}-new-${d.kind}`}>· {d.detail}</div>
            ))}>
              <Tag color="orange">上报前需先对账</Tag>
            </Tooltip>
          );
        }
        return <Typography.Text type="secondary">未上报（草稿）</Typography.Text>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.workflow === 'stale' ? (
            <Button size="small" type="link" icon={<RedoOutlined />} onClick={() => void handleRecalc(record)}>
              失效重算
            </Button>
          ) : null}
          {record.workflow !== 'reported' ? (
            <Button size="small" type="link" icon={<SendOutlined />} loading={reporting} onClick={() => void handleReport([record.id])}>
              上报
            </Button>
          ) : null}
          <Button size="small" type="link" icon={<EditOutlined />} disabled={record.workflow === 'reported'} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该测次记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            disabled={record.workflow === 'reported'}
            onConfirm={async () => {
              try {
                await deleteSurvey(record.id);
                await remove(record.id);
                message.success('验收记录已删除');
              } catch (error) {
                if (error instanceof Error) message.error(error.message);
              }
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} disabled={record.workflow === 'reported'}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const warnPlots = plots.filter((plot) => {
    const stat = statOf(plot.id);
    return stat.surveyCount > 0 && stat.latestRate < SURVIVAL_WARN_RATE;
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="验收记录" value={rows.length} suffix="条" tone="primary" icon={<ExperimentOutlined />} />
        <StatBadge label="已验收地块" value={stats.ratedCount} suffix="块" tone="info" />
        <StatBadge label="平均成活率" value={percentText(stats.avgRate)} percent={stats.avgRate} tone="success" />
        <StatBadge
          label="已上报（冻结）"
          value={workflowStats.reported}
          suffix="条"
          tone="success"
          hint="已上报的验收结论保留上报时原值，并标注依据的备案版本"
        />
        <StatBadge
          label="已挂起"
          value={workflowStats.held}
          suffix="条"
          tone={workflowStats.held > 0 ? 'danger' : 'default'}
          hint="栽植面积或树种与备案不符，上报前对账未通过"
        />
        <StatBadge
          label="已失效待重算"
          value={workflowStats.stale}
          suffix="条"
          tone={workflowStats.stale > 0 ? 'warning' : 'default'}
          hint="备案改动后尚未上报的验收结论自动失效"
        />
        <StatBadge
          label="优秀地块占比"
          value={percentText(stats.strongPct)}
          percent={stats.strongPct}
          tone="primary"
          hint="最新成活率 ≥ 85% 的地块占比"
        />
        <StatBadge
          label="告警地块"
          value={stats.warnCount}
          suffix="块"
          tone={stats.warnCount > 0 ? 'danger' : 'default'}
          hint={`最新成活率低于 ${SURVIVAL_WARN_RATE}% 的地块`}
        />
      </div>

      {workflowStats.stale > 0 || workflowStats.held > 0 ? (
        <Alert
          type={workflowStats.held > 0 ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 14 }}
          message={
            workflowStats.held > 0
              ? `有 ${workflowStats.held} 条验收因与备案不符已挂起；另有 ${workflowStats.stale} 条因备案变更已失效`
              : `有 ${workflowStats.stale} 条验收因备案改动失效，等待按新版本重算`
          }
          description="挂起记录请按「备案依据 / 差异」列修正栽植数据或到林业站变更备案；失效记录点击「失效重算」即可按当前栽植重新计算。已上报记录不受影响、保留原值。"
        />
      ) : null}

      {warnPlots.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${warnPlots.length} 个地块的最新成活率低于 ${SURVIVAL_WARN_RATE}%`}
          description={
            <Space direction="vertical" size={2}>
              {warnPlots.map((plot) => (
                <span key={plot.id}>
                  {plot.name}：最新成活率 {percentText(statOf(plot.id).latestRate)}，建议补植{' '}
                  {statOf(plot.id).suggestReplant} 株
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      <Card
        title="成活率与株高验收台"
        extra={
          <Space>
            <Button icon={<ToolOutlined />} onClick={() => void handleGenerateReplant()}>
              生成补植计划
            </Button>
            <Button
              icon={<SendOutlined />}
              loading={reporting}
              disabled={selectedIds.length === 0}
              onClick={() => void handleReport(selectedIds)}
            >
              上报所选（先对账）
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plots.length === 0}>
              录入测次
            </Button>
          </Space>
        }
      >
        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>地块</span>
            <Select
              style={{ minWidth: 200 }}
              value={filters.plotId}
              onChange={(value: string) => setFilters({ plotId: value })}
              options={[
                { value: 'all', label: '全部地块' },
                ...plots.map((plot) => ({ value: plot.id, label: plot.name })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>等级</span>
            <Select
              style={{ minWidth: 140 }}
              value={filters.level}
              onChange={(value: string) => setFilters({ level: value as RateLevel | 'all' })}
              options={[
                { value: 'all', label: '全部等级' },
                ...RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>上报状态</span>
            <Select
              style={{ minWidth: 150 }}
              value={filters.workflow}
              onChange={(value: string) => setFilters({ workflow: value as SurveyWorkflow | 'all' })}
              options={[
                { value: 'all', label: '全部状态' },
                ...(['draft', 'held', 'stale', 'reported'] as SurveyWorkflow[]).map((status) => ({
                  value: status,
                  label: SURVEY_WORKFLOW_LABEL[status],
                })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>日期区间</span>
            <DatePicker
              value={filters.from === '' ? null : dayjs(filters.from)}
              onChange={(value) => setFilters({ from: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="开始日期"
            />
            <DatePicker
              value={filters.to === '' ? null : dayjs(filters.to)}
              onChange={(value) => setFilters({ to: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="结束日期"
            />
          </Space>
          <Button onClick={resetFilters}>重置筛选</Button>
          <Tag color="cyan">
            命中 {filtered.length} / {rows.length} 条
          </Tag>
        </Space>

        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Tag color={selectedIds.length > 0 ? 'purple' : 'default'}>已选 {selectedIds.length} 条（不含已上报）</Tag>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>批量调整为</span>
            <Select
              style={{ minWidth: 120 }}
              value={gradeDraft}
              onChange={(value: RateLevel) => setGradeDraft(value)}
              options={RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] }))}
            />
          </Space>
          <Button type="primary" ghost disabled={selectedIds.length === 0} onClick={() => void handleBulkGrade()}>
            批量调整成活率等级
          </Button>
          <Button disabled={selectedIds.length === 0} onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </Space>

        {rows.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有任何验收记录"
            description="按测次录入成活株数与平均株高，系统会自动计算成活率并在低于阈值时告警。"
            actionText="录入第一个测次"
            onAction={openCreate}
          />
        ) : (
          <Table<Survey>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1560 }}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
              getCheckboxProps: (record) => ({ disabled: record.workflow === 'reported' }),
            }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel title="没有符合筛选条件的验收记录" actionText="重置筛选" onAction={resetFilters} />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '录入验收测次' : '编辑验收测次'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plotId" label="地块" style={{ flex: 2 }} rules={[{ required: true, message: '请选择地块' }]}>
              <Select options={plots.map((plot) => ({ value: plot.id, label: plot.name }))} />
            </Form.Item>
            <Form.Item name="round" label="测次" style={{ flex: 1 }} rules={[{ required: true, message: '请填写测次' }]}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="验收日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="aliveCount"
              label="成活株数"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写成活株数' }]}
            >
              <InputNumber min={0} max={500000} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="avgHeightCm"
              label="平均株高（cm）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写平均株高' }]}
            >
              <InputNumber min={0} max={2000} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            成活率 = 成活株数 / 该地块栽植总株数，保存时自动计算；低于 {SURVIVAL_WARN_RATE}% 会告警。
            录入后为「未上报」草稿；点「上报」会先按地块与林业站备案对账，面积或树种不符将挂起并写明差异。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}

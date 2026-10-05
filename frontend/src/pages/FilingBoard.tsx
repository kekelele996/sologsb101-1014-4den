/**
 * /filings 林业站备案管理
 * 备案独立于项目部栽植/验收台账：登记备案号、备案面积、备案树种；
 * 备案改动生成新版本，已上报验收冻结原值并标注依据版本。
 * 备案侧独立保存，写失败只重试备案侧本身。
 * 消费模型：Filing、Plot、Seedling、Planting；复用组件：<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { useFilingStore } from '../stores/filingStore';
import { SEEDLING_SPECIES_OPTIONS, type SeedlingSpecies } from '../types/seedling';
import type { Filing, FilingDraft } from '../types/filing';
import { getDominantSpecies } from '../utils/filing';
import { round1 } from '../utils/rate';

interface FilingFormValues {
  plotId: string;
  filingNo: string;
  filingAreaMu: number;
  filingSpecies: SeedlingSpecies;
  filedAt: Dayjs;
  note: string;
}

export default function FilingBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const seedlings = usePlotStore((state) => state.seedlings);
  const plantings = usePlotStore((state) => state.plantings);
  const ready = usePlotStore((state) => state.ready);
  const filings = useFilingStore((state) => state.filings);
  const saveState = useFilingStore((state) => state.saveState);
  const saveError = useFilingStore((state) => state.saveError);
  const createFiling = useFilingStore((state) => state.createFiling);
  const retrySave = useFilingStore((state) => state.retrySave);
  const currentFilingOf = useFilingStore((state) => state.currentFilingOf);
  const reconcileOf = useFilingStore((state) => state.reconcileOf);

  const [open, setOpen] = useState(false);
  const [historyPlot, setHistoryPlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<FilingFormValues>();

  /** 地块主植树种（项目部侧） */
  const speciesOf = (plotId: string): SeedlingSpecies | null =>
    getDominantSpecies(seedlings, plantings, plotId);

  const rows = useMemo(() => plots, [plots]);

  const stats = useMemo(() => {
    let filed = 0;
    let unfiled = 0;
    let matched = 0;
    let mismatched = 0;
    plots.forEach((plot) => {
      const recon = reconcileOf(plot.id);
      if (recon.hasFiling) {
        filed += 1;
        if (recon.ok) matched += 1;
        else mismatched += 1;
      } else {
        unfiled += 1;
      }
    });
    return { filed, unfiled, matched, mismatched };
    // reconcileOf 依赖 filings / plots / seedlings / plantings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plots, filings, seedlings, plantings]);

  const openCreate = (plotId: string): void => {
    const plot = plots.find((item) => item.id === plotId);
    const current = currentFilingOf(plotId);
    const species = speciesOf(plotId);
    form.setFieldsValue({
      plotId,
      filingNo: current?.filingNo ?? '',
      filingAreaMu: current?.filingAreaMu ?? plot?.areaMu ?? 1,
      filingSpecies: current?.filingSpecies ?? species ?? '秋茄',
      filedAt: dayjs(),
      note: current?.note ?? '',
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const plotId = form.getFieldValue('plotId') as string;
      const draft: FilingDraft = {
        plotId,
        filingNo: values.filingNo,
        filingAreaMu: values.filingAreaMu,
        filingSpecies: values.filingSpecies,
        filedAt: values.filedAt.format('YYYY-MM-DD'),
        note: values.note ?? '',
      };
      const row = await createFiling(draft);
      if (row !== null) {
        message.success(`备案已保存：${row.filingNo}（v${row.version}）`);
        setOpen(false);
      } else {
        message.error('备案保存失败，可点击「重试」只重试备案侧');
      }
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const historyRows = useMemo<Filing[]>(
    () => (historyPlot === null ? [] : filings.filter((row) => row.plotId === historyPlot).sort((a, b) => b.version - a.version)),
    [filings, historyPlot],
  );

  const columns: ColumnsType<(typeof plots)[number]> = [
    {
      title: '地块',
      key: 'plot',
      width: 220,
      render: (_value, record) => {
        const species = speciesOf(record.id);
        return (
          <Space direction="vertical" size={0}>
            <span>{record.name}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {round1(record.areaMu)} 亩 · 主植树种 {species ?? '未定'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '当前备案',
      key: 'filing',
      width: 320,
      render: (_value, record) => {
        const filing = currentFilingOf(record.id);
        if (filing === null) {
          return <Tag color="default">未备案</Tag>;
        }
        return (
          <Space direction="vertical" size={2}>
            <Space size={6} wrap>
              <Tag color="blue">{filing.filingNo}</Tag>
              <Tag>v{filing.version}</Tag>
              <Tag color="cyan">{filing.filingSpecies}</Tag>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              备案面积 {round1(filing.filingAreaMu)} 亩 · 备案日期 {filing.filedAt}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '对账结果',
      key: 'reconcile',
      width: 300,
      render: (_value, record) => {
        const recon = reconcileOf(record.id);
        if (!recon.hasFiling) {
          return (
            <Tag icon={<WarningOutlined />} color="warning">
              未备案 · 上报将挂起
            </Tag>
          );
        }
        if (recon.ok) {
          return (
            <Tag icon={<CheckCircleOutlined />} color="success">
              账实相符
            </Tag>
          );
        }
        return (
          <Space direction="vertical" size={2}>
            <Tag icon={<CloseCircleOutlined />} color="error">
              不符 · 已挂起
            </Tag>
            {recon.differences.map((diff) => (
              <Typography.Text key={diff.field} type="danger" style={{ fontSize: 12 }}>
                {diff.detail}
              </Typography.Text>
            ))}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      fixed: 'right',
      render: (_value, record) => {
        const filing = currentFilingOf(record.id);
        return (
          <Space size={4} wrap>
            <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openCreate(record.id)}>
              {filing === null ? '补建备案' : '变更备案'}
            </Button>
            <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => setHistoryPlot(record.id)}>
              历史版本
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="已备案地块" value={stats.filed} suffix="块" tone="primary" icon={<CheckCircleOutlined />} />
        <StatBadge
          label="未备案地块"
          value={stats.unfiled}
          suffix="块"
          tone={stats.unfiled > 0 ? 'warning' : 'default'}
          icon={<WarningOutlined />}
        />
        <StatBadge label="对账一致" value={stats.matched} suffix="块" tone="success" />
        <StatBadge
          label="对账不符（挂起）"
          value={stats.mismatched}
          suffix="块"
          tone={stats.mismatched > 0 ? 'danger' : 'default'}
        />
      </div>

      {saveState === 'error' ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message="林业站备案保存失败"
          description={
            <Space direction="vertical" size={4}>
              <span>{saveError}。备案侧独立保存，可只重试备案侧，不影响项目部已录入数据。</span>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void retrySave()}>
                重试备案保存
              </Button>
            </Space>
          }
        />
      ) : null}

      <Card title="林业站备案台账" extra={<Tag icon={<CloudUploadOutlined />}>备案侧独立保存 · 失败只重试备案侧</Tag>}>
        {ready && rows.length === 0 ? (
          <EmptyPanel
            title="还没有修复地块"
            description="先建立修复地块，再到这里补建林业站备案；备案号、备案面积与备案树种是上报验收的依据。"
            actionText="前往地块台账"
            onAction={() => {
              /* 地块台账入口由侧边导航进入 */
            }}
          />
        ) : (
          <Table
            rowKey="id"
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={rows}
            scroll={{ x: 1100 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
          />
        )}
      </Card>

      <Modal
        title="补建 / 变更备案"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting || saveState === 'saving'}
        okText={saveState === 'saving' ? '备案保存中…' : '保存备案'}
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="plotId" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="filingNo"
            label="备案号"
            rules={[{ required: true, message: '请填写备案号' }, { max: 30, message: '备案号不超过 30 字' }]}
          >
            <Input placeholder="如：备-2024-001" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="filingAreaMu"
              label="备案面积（亩）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写备案面积' }]}
            >
              <InputNumber min={0.1} max={5000} step={0.5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="filingSpecies" label="备案树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Form.Item name="filedAt" label="备案日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            变更备案会生成新版本并作废旧版本；备案改动后，未上报的验收结论需重算，已上报结论冻结原值并标注依据版本。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title="备案历史版本"
        open={historyPlot !== null}
        onCancel={() => setHistoryPlot(null)}
        footer={null}
        width={640}
      >
        {historyRows.length === 0 ? (
          <EmptyPanel title="该地块暂无备案记录" description="可在台账中点击「补建备案」创建首版备案。" />
        ) : (
          <Table<Filing>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={historyRows}
            columns={[
              { title: '版本', dataIndex: 'version', width: 70, render: (v: number) => <Tag>v{v}</Tag> },
              { title: '备案号', dataIndex: 'filingNo', width: 140 },
              { title: '备案面积', dataIndex: 'filingAreaMu', width: 110, render: (v: number) => `${round1(v)} 亩` },
              { title: '备案树种', dataIndex: 'filingSpecies', width: 110, render: (v: string) => <Tag color="cyan">{v}</Tag> },
              { title: '备案日期', dataIndex: 'filedAt', width: 120 },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (v: string) => <Tag color={v === '有效' ? 'green' : 'default'}>{v}</Tag>,
              },
            ]}
          />
        )}
      </Modal>
    </div>
  );
}

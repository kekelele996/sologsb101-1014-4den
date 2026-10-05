/**
 * /filings 林业站备案台（林业站侧）
 * 与项目部验收物理分开：这里只管备案号、备案面积、备案树种与版本流水。
 * - 备案当前值表：新登记 / 变更（产生新版本）/ 查看版本流水；
 * - 历史备案补录失败：升级时补不上的地块只读留着，可逐块或一键重试；
 * - 站侧写入死信：站侧存不上（已自动重试）的操作留痕，可清除。
 * 消费模型：Filing、FilingRevision、BackfillFailure、StationWriteFailure、Plot（对账参照）。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  CloudServerOutlined,
  HistoryOutlined,
  PlusOutlined,
  RedoOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { usePlotStore } from '../stores/plotStore';
import { useFilingStore } from '../stores/filingStore';
import type { Filing, FilingDraft, FilingRevision } from '../types/filing';
import { FILING_SOURCE_LABEL } from '../types/filing';
import type { BackfillFailure } from '../types/filing';
import { SEEDLING_SPECIES_OPTIONS, type SeedlingSpecies } from '../types/seedling';
import { STATION_DB_NAME, STATION_SCHEMA_VERSION, type StationWriteFailure } from '../utils/stationDb';
import { usePlotReconcile } from '../hooks/usePlotReconcile';

interface ChangeFormValues {
  areaMu: number;
  species: SeedlingSpecies[];
  filedAt: Dayjs;
  changeNote: string;
}

interface RegisterFormValues {
  plotId: string;
  filingNo: string;
  areaMu: number;
  species: SeedlingSpecies[];
  filedAt: Dayjs;
  changeNote: string;
}

export default function FilingBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const plantings = usePlotStore((state) => state.plantings);
  const seedlings = usePlotStore((state) => state.seedlings);
  const ready = useFilingStore((state) => state.ready);
  const filings = useFilingStore((state) => state.filings);
  const backfillFailures = useFilingStore((state) => state.backfillFailures);
  const writeFailures = useFilingStore((state) => state.writeFailures);
  const lastMessage = useFilingStore((state) => state.lastMessage);
  const init = useFilingStore((state) => state.init);
  const register = useFilingStore((state) => state.register);
  const change = useFilingStore((state) => state.change);
  const backfillPlot = useFilingStore((state) => state.backfillPlot);
  const backfillAll = useFilingStore((state) => state.backfillAll);
  const revisionListOf = useFilingStore((state) => state.revisionListOf);
  const dismissWriteFailure = useFilingStore((state) => state.dismissWriteFailure);

  const [registerOpen, setRegisterOpen] = useState(false);
  const [changing, setChanging] = useState<Filing | null>(null);
  const [historyOf, setHistoryOf] = useState<Filing | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registerForm] = Form.useForm<RegisterFormValues>();
  const [changeForm] = Form.useForm<ChangeFormValues>();

  const reconcile = usePlotReconcile({ plots, filings, plantings, seedlings });

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const unfiledPlots = useMemo(
    () => plots.filter((plot) => !filings.some((filing) => filing.plotId === plot.id)),
    [plots, filings],
  );

  const stats = useMemo(
    () => ({
      filingCount: filings.length,
      currentMismatch: reconcile.mismatchCount,
      backfillFailed: backfillFailures.length,
      writeFailed: writeFailures.length,
    }),
    [filings.length, reconcile.mismatchCount, backfillFailures.length, writeFailures.length],
  );

  const openChange = (filing: Filing): void => {
    setChanging(filing);
    changeForm.setFieldsValue({
      areaMu: filing.areaMu,
      species: [...filing.species],
      filedAt: dayjs(),
      changeNote: '',
    });
  };

  const openRegister = (): void => {
    const plotId = unfiledPlots[0]?.id ?? '';
    const plot = plots.find((item) => item.id === plotId);
    registerForm.setFieldsValue({
      plotId,
      filingNo: '',
      areaMu: plot?.areaMu ?? 30,
      species: [],
      filedAt: dayjs(),
      changeNote: '林业站首版备案',
    });
    setRegisterOpen(true);
  };

  const handleRegisterSelectPlot = (plotId: string): void => {
    const plot = plots.find((item) => item.id === plotId);
    if (plot !== undefined) {
      const planted = reconcile.resultOf(plotId)?.projectSpecies as SeedlingSpecies[] | undefined;
      registerForm.setFieldsValue({
        areaMu: plot.areaMu,
        species: planted ?? [],
      });
    }
  };

  const handleRegister = async (): Promise<void> => {
    try {
      const values = await registerForm.validateFields();
      setSubmitting(true);
      const draft: FilingDraft = {
        plotId: values.plotId,
        filingNo: values.filingNo,
        areaMu: values.areaMu,
        species: values.species,
        filedAt: values.filedAt.format('YYYY-MM-DD'),
        changeNote: values.changeNote,
      };
      await register(draft);
      message.success(`备案 ${draft.filingNo} 已登记`);
      setRegisterOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleChange = async (): Promise<void> => {
    if (changing === null) return;
    try {
      const values = await changeForm.validateFields();
      setSubmitting(true);
      const result = await change(changing.filingNo, {
        areaMu: values.areaMu,
        species: values.species,
        filedAt: values.filedAt.format('YYYY-MM-DD'),
        changeNote: values.changeNote.trim() || '备案变更',
      });
      message.success(
        `已生成 v${result.filing.currentVersion}，${result.invalidated} 条未上报验收失效待重算`,
      );
      setChanging(null);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackfillOne = async (failure: BackfillFailure): Promise<void> => {
    const ok = await backfillPlot(failure.plotId);
    if (ok) message.success(`已为「${plotName(failure.plotId)}」补录历史备案`);
    else message.warning('仍补不上：该地块缺少实际栽植树种，请先在项目部补齐数据后重试');
  };

  const filingColumns: ColumnsType<Filing> = [
    {
      title: '备案号',
      dataIndex: 'filingNo',
      key: 'filingNo',
      width: 170,
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <Tag color={record.source === 'formal' ? 'geekblue' : 'default'} style={{ marginTop: 2 }}>
            {FILING_SOURCE_LABEL[record.source]}
          </Tag>
        </Space>
      ),
    },
    {
      title: '对应地块',
      key: 'plot',
      width: 200,
      render: (_value, record) => plotName(record.plotId),
    },
    {
      title: '备案面积（亩）',
      dataIndex: 'areaMu',
      key: 'areaMu',
      width: 130,
      align: 'right',
      render: (value: number, record) => {
        const result = reconcile.resultOf(record.plotId);
        const mismatch = result?.discrepancies.some((item) => item.kind === 'area') ?? false;
        return (
          <Space size={4}>
            <span>{value}</span>
            {mismatch ? <Tag color="volcano">与栽植不符</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '备案树种',
      dataIndex: 'species',
      key: 'species',
      render: (value: SeedlingSpecies[], record) => {
        const result = reconcile.resultOf(record.plotId);
        const mismatch = result?.discrepancies.some((item) => item.kind === 'species') ?? false;
        return (
          <Space size={4} wrap>
            {value.map((name) => (
              <Tag color="green" key={name}>
                {name}
              </Tag>
            ))}
            {mismatch ? <Tag color="volcano">树种对不上</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '当前版本',
      key: 'version',
      width: 110,
      align: 'center',
      render: (_value, record) => <Tag color="blue">v{record.currentVersion}</Tag>,
    },
    { title: '最新备案日期', dataIndex: 'filedAt', key: 'filedAt', width: 120 },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => setHistoryOf(record)}>
            版本流水
          </Button>
          <Button size="small" type="link" onClick={() => openChange(record)}>
            变更备案
          </Button>
        </Space>
      ),
    },
  ];

  const failureColumns: ColumnsType<BackfillFailure> = [
    { title: '地块', key: 'plot', width: 200, render: (_v, record) => plotName(record.plotId) },
    { title: '补不上的原因', dataIndex: 'reason', key: 'reason' },
    { title: '尝试次数', dataIndex: 'attempts', key: 'attempts', width: 90, align: 'center' },
    { title: '最近错误', dataIndex: 'lastError', key: 'lastError', width: 220 },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_v, record) => (
        <Button size="small" type="link" icon={<RedoOutlined />} onClick={() => void handleBackfillOne(record)}>
          重试补录
        </Button>
      ),
    },
  ];

  const writeFailureColumns: ColumnsType<StationWriteFailure> = [
    { title: '操作', dataIndex: 'summary', key: 'summary' },
    { title: '错误', dataIndex: 'error', key: 'error', width: 260 },
    { title: '尝试次数', dataIndex: 'attempts', key: 'attempts', width: 90, align: 'center' },
    { title: '时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 200 },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_v, record) => (
        <Button size="small" type="link" danger onClick={() => void dismissWriteFailure(record.id)}>
          清除留痕
        </Button>
      ),
    },
  ];

  const historyRows: FilingRevision[] = historyOf === null ? [] : revisionListOf(historyOf.filingNo);

  const filingTable = (
    <Card
      title={`林业站备案台账 · ${STATION_DB_NAME} v${STATION_SCHEMA_VERSION}`}
      extra={
        <Space wrap>
          <Button icon={<RedoOutlined />} onClick={() => void init()}>
            重新检测并补录
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={openRegister}
            disabled={unfiledPlots.length === 0}
          >
            登记备案
          </Button>
        </Space>
      }
    >
      {ready && filings.length === 0 ? (
        <EmptyPanel
          title="林业站侧还没有备案记录"
          description="升级旧数据时会按现有地块自动补一份历史备案；新地块需要在这里由林业站登记首版备案后，项目部才能上报验收。"
          actionText="重新检测并补录"
          onAction={() => void backfillAll()}
        />
      ) : (
        <Table<Filing>
          rowKey="filingNo"
          size="middle"
          loading={!ready}
          columns={filingColumns}
          dataSource={filings}
          scroll={{ x: 1100 }}
          pagination={{ pageSize: 8, showSizeChanger: false }}
        />
      )}
    </Card>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="备案地块" value={stats.filingCount} suffix="份" tone="primary" icon={<AuditOutlined />} />
        <StatBadge
          label="当前对不上"
          value={stats.currentMismatch}
          suffix="块"
          tone={stats.currentMismatch > 0 ? 'danger' : 'success'}
          hint="栽植面积或树种与当前备案不一致的地块数"
        />
        <StatBadge
          label="历史补录失败"
          value={stats.backfillFailed}
          suffix="块"
          tone={stats.backfillFailed > 0 ? 'warning' : 'default'}
          icon={<HistoryOutlined />}
        />
        <StatBadge
          label="站侧写入失败"
          value={stats.writeFailed}
          suffix="笔"
          tone={stats.writeFailed > 0 ? 'danger' : 'default'}
          icon={<CloudServerOutlined />}
          hint="林业站侧保存失败且已自动重试 3 次仍未成功的操作"
        />
      </div>

      {lastMessage !== '' ? <Alert type="info" showIcon style={{ marginBottom: 14 }} message={lastMessage} /> : null}
      {stats.backfillFailed > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${stats.backfillFailed} 个旧地块补不上历史备案，已只读保留`}
          description="这些地块通常缺少实际栽植记录、无法确定备案树种。项目部可继续查看，但在林业站补录成功前不能上报验收。"
        />
      ) : null}

      <Tabs
        defaultActiveKey="filings"
        items={[
          { key: 'filings', label: `备案当前值（${filings.length}）`, children: filingTable },
          {
            key: 'backfill',
            label: `补录失败（${backfillFailures.length}）`,
            children: (
              <Card
                title="历史备案补录失败（只读留着）"
                extra={
                  <Button icon={<RedoOutlined />} onClick={() => void backfillAll()}>
                    一键全部重试
                  </Button>
                }
              >
                {backfillFailures.length === 0 ? (
                  <EmptyPanel title="没有补录失败的地块" description="所有现有地块都已具备林业站备案。" />
                ) : (
                  <Table<BackfillFailure>
                    rowKey="id"
                    size="middle"
                    columns={failureColumns}
                    dataSource={backfillFailures}
                    pagination={false}
                  />
                )}
              </Card>
            ),
          },
          {
            key: 'deadletter',
            label: `站侧写入失败（${writeFailures.length}）`,
            children: (
              <Card title="林业站侧写入失败留痕（仅重试站侧自己）">
                {writeFailures.length === 0 ? (
                  <EmptyPanel title="没有写入失败" description="林业站侧最近的备案写入都已成功。" />
                ) : (
                  <Table<StationWriteFailure>
                    rowKey="id"
                    size="middle"
                    columns={writeFailureColumns}
                    dataSource={writeFailures}
                    pagination={false}
                  />
                )}
              </Card>
            ),
          },
        ]}
      />

      {/* 变更备案 */}
      <Modal
        title={changing === null ? '变更备案' : `变更备案 · ${changing.filingNo}（${plotName(changing.plotId)}）`}
        open={changing !== null}
        onCancel={() => setChanging(null)}
        onOk={() => void handleChange()}
        confirmLoading={submitting}
        okText="提交变更并生成新版本"
        cancelText="取消"
        width={560}
      >
        <Form form={changeForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="areaMu" label="备案面积（亩）" style={{ flex: 1 }} rules={[{ required: true }]}>
              <InputNumber min={0.1} max={5000} step={0.5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="filedAt" label="变更日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="species" label="备案树种（全集）" rules={[{ required: true, message: '请至少选择一个树种' }]}>
            <Select
              mode="multiple"
              options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))}
              placeholder="选择本地块备案的全部树种"
            />
          </Form.Item>
          <Form.Item name="changeNote" label="变更说明" rules={[{ required: true, message: '请填写变更原因' }]}>
            <Input.TextArea rows={2} placeholder="如：年度树种结构调整备案" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="提交后产生新版本，旧版本只读保留。"
            description="项目部尚未上报的验收结论会自动失效、需按新备案重算；已经上报的结论保留原值，并继续标注它依据的备案版本。"
          />
        </Form>
      </Modal>

      {/* 新登记备案 */}
      <Modal
        title="登记首版备案"
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        onOk={() => void handleRegister()}
        confirmLoading={submitting}
        okText="登记备案"
        cancelText="取消"
        width={560}
      >
        <Form form={registerForm} layout="vertical">
          <Form.Item name="plotId" label="对应地块" rules={[{ required: true, message: '请选择地块' }]}>
            <Select
              placeholder="仅列出尚无备案的地块"
              options={unfiledPlots.map((plot) => ({ value: plot.id, label: plot.name }))}
              onChange={(value: string) => handleRegisterSelectPlot(value)}
            />
          </Form.Item>
          <Form.Item
            name="filingNo"
            label="备案号"
            rules={[{ required: true, message: '请填写备案号' }, { pattern: /^[A-Za-z0-9-]+$/, message: '备案号仅支持字母、数字与短横线' }]}
          >
            <Input placeholder="如：BL-2025-018" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="areaMu" label="备案面积（亩）" style={{ flex: 1 }} rules={[{ required: true }]}>
              <InputNumber min={0.1} max={5000} step={0.5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="filedAt" label="备案日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="species" label="备案树种" rules={[{ required: true, message: '请至少选择一个树种' }]}>
            <Select
              mode="multiple"
              options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item name="changeNote" label="说明">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 版本流水抽屉 */}
      <Drawer
        title={historyOf === null ? '版本流水' : `版本流水 · ${historyOf.filingNo}`}
        open={historyOf !== null}
        width={520}
        onClose={() => setHistoryOf(null)}
      >
        {historyOf !== null ? (
          <>
            <Typography.Paragraph type="secondary">
              对应地块：{plotName(historyOf.plotId)}；当前为 v{historyOf.currentVersion}。每个版本只读，不可删除。
            </Typography.Paragraph>
            <Timeline
              items={historyRows.map((rev) => ({
                color: rev.version === historyOf.currentVersion ? 'green' : 'gray',
                children: (
                  <Space direction="vertical" size={2}>
                    <Space>
                      <Tag color="blue">v{rev.version}</Tag>
                      <strong>{rev.filedAt}</strong>
                      <Tag>{FILING_SOURCE_LABEL[rev.source]}</Tag>
                    </Space>
                    <span>面积 {rev.areaMu} 亩</span>
                    <span>树种 {rev.species.join('、')}</span>
                    <Typography.Text type="secondary">{rev.changeNote}</Typography.Text>
                  </Space>
                ),
              }))}
            />
          </>
        ) : null}
      </Drawer>
    </div>
  );
}

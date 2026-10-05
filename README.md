# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 两个独立库：项目部 `gbmangrove`（v1→v2→v3）+ 林业站 `gbmangrove-station`（v1） |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts replant.ts filing.ts
        ├── stores/             # plotStore.ts surveyStore.ts replantStore.ts filingStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx WorkflowTag.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts usePlotReconcile.ts
        ├── pages/              # 6 个模块页面（含林业站备案台 FilingBoard）
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts db.ts（项目部库）stationDb.ts（林业站库）reconcile.ts filingBackfill.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示） |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：录株距与株数、按面积与株距校验密度合理性 |
| `/surveys` | `pages/SurveyBoard.tsx` | 项目部成活率与株高验收台：按测次录入、上报前对账、挂起/失效/上报、批量调等级 |
| `/filings` | `pages/FilingBoard.tsx` | 林业站备案台：备案号/面积/树种登记与变更（版本流水）、历史补录失败重试、站侧写入留痕 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装。**两侧分开、各自保存**，使用两个物理独立的库：
  * 项目部侧 **`gbmangrove`**：地块、苗木批次、栽植、验收、补植（项目数据与验收结论）；
  * 林业站侧 **`gbmangrove-station`**：备案当前值、备案版本流水、历史补录失败、站侧写入失败留痕。
  * 两侧不放在同一事务：林业站侧存不上只由 `withStationRetry` 自动重试站侧这一笔（指数退避 3 次），
    用尽后写入站侧 `stationWriteFailures` 死信留痕，绝不回滚或重试项目部侧数据。
* **数据结构版本**：
  * 项目部库 `DB_SCHEMA_VERSION = 3`：`version(1)` 建表 → `version(2)` 补索引/回写字段 → `version(3)`
    验收记录增加上报工作流（`workflow` 索引及 `reportedRate/basis/discrepancies/staleReason…` 字段），
    旧验收统一迁移为「未上报」；
  * 林业站库 `STATION_SCHEMA_VERSION = 1`：备案三表一次建成。
* **项目部库表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | id | plotId, [plotId+round], date, grade, workflow |
  | `replants` | id | plotId, planDate, state, species |

* **林业站库表结构**：

  | 表 | 主键 | 主要索引 | 说明 |
  | --- | --- | --- | --- |
  | `filings` | filingNo | plotId, currentVersion, filedAt | 备案当前值（备案号、面积、树种、当前版本） |
  | `filingRevisions` | id | filingNo, plotId, version, filedAt | 备案版本流水，**不可变**，每次改动 +1 版 |
  | `backfillFailures` | id | plotId, attempts | 升级时补不上历史备案的地块（只读留着、可重试） |
  | `stationWriteFailures` | id | op, attempts, updatedAt | 站侧写入重试 3 次仍失败的死信留痕 |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 栽植 → 验收 → 补植** 三层互相引用：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 6 个苗木批次（每地块 2 批）、6 条栽植记录（每地块 2 条，引用真实批次 id）；
  * 7 条验收记录（每地块 2–3 个测次，成活率自洽：90.0% → 85.0% → 79.0% 等）；
  * 3 条补植计划（覆盖待补植 / 已补植 / 已复核三种状态）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
  * 林业站演示备案 `BL-2024-001/002/003`：东港第 3 测次已上报并冻结在备案 v1，随后备案树种变更为 v2，
    其前两个未上报测次自动失效待重算——可直接在验收台看到「已上报 / 已失效」两种状态的对照。
* **历史备案补录（升级）**：旧数据没有备案，启动时 `ensureHistoryFilings()` 按现有地块补一份
  `source = history-backfill` 的历史备案（取地块面积 + 实际栽植涉及树种）；**补不上**（如地块尚无实际栽植、
  无法确定树种）的地块写入林业站 `backfillFailures`，只读保留，可在备案台逐块或一键重试，补齐数据后重试成功。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录与补植计划（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run smoke        # 冒烟测试：两侧分离 / 上报对账 / 失效冻结（fake-indexeddb + tsx）
npm run smoke:upgrade # 升级路径：v2→v3 迁移 + 历史备案补录 / 补不上只读留痕
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **成活率** = 成活株数 ÷ 该地块栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率（已上报的验收冻结、不回写）。

---

## 八、林业站备案 × 项目部验收（两侧分离）

地块必须先经上级林业站备案，项目部才能上报验收；两侧各记各的、各自保存。

* **两侧职责**
  * 林业站侧（`/filings`，库 `gbmangrove-station`）：只记备案号、备案面积、备案树种；每次面积或树种改动
    生成一个**不可变新版本**（`filingRevisions`），旧版本只读保留。
  * 项目部侧（`/surveys`，库 `gbmangrove`）：记栽植记录与验收测次，不持有备案正本，只在「上报」瞬间
    冻结一份备案依据快照（备案号 + 版本号 + 面积 + 树种）。

* **上报前对账（`src/utils/reconcile.ts`）**：点「上报」按地块把栽植数据与当前备案逐项核对：
  * 面积：地块栽植面积与备案面积比较，容差 ±0.5% 且至少 ±0.1 亩（避免测绘四舍五入误报）；
  * 树种：实际栽植（被栽植记录引用的苗木批次）树种必须全部落在备案树种范围内；
  * 无备案：视为不符。
  * 对得上：验收记录转为**已上报**，冻结成活率/成活株数/栽植总株数与依据版本；
  * 对不上：记录**挂起**、不上报，并在「备案依据 / 差异」列逐条写明差在哪
    （如「栽植面积 46.5 亩 vs 备案 50 亩，相差 3.5 亩」「实际栽植的秋茄不在备案树种范围内」）。

* **备案改动后的处理**
  * 尚未上报（草稿/挂起/已失效）的验收结论：自动置为**已失效**（stale），记录失效原因（指向新备案版本），
    在验收台点「失效重算」按当前栽植总株数重算后恢复为未上报；
  * **已上报**的结论：**保留上报时原值不动**，界面与导出始终标注它依据的是备案号哪一版
    （如 `BL-2024-001 v1`），不会因备案升到 v2 而变化；已上报记录禁止编辑、删除、调级、重算。

* **各自保存、单侧重试**：林业站所有写入走 `withStationRetry`（指数退避，最多 3 次）；只重试站侧那一笔，
  不触碰项目部数据。重试用尽写入站侧死信表并在备案台留痕。删除地块时项目部侧先提交，
  站侧清理失败只留待下次检测自愈重试，不阻断项目部删除。

* **旧数据升级**：v2→v3 旧验收一律补为「未上报」；随后按现有地块补一份历史备案，补不上的只读留在
  「补录失败」页签，数据补齐后可重试（见第五节）。

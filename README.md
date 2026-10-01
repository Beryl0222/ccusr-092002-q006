# 重症场外护理证据链 / 照护假核验服务

在员工家属 ICU 抢救期间，把"零散缴费单、深夜截图"式的弱证明，升级为**医院或合规见证方签发的、可验签、可失效、不含诊断**的最小化凭证，并由企业侧按当期制度完成照护假核算、角色隔离与可追溯调账。

- `npm run check`：检查服务身份
- `npm test`：36 项契约 / 引擎 / 服务 / HTTP 测试
- `npm start`（或 `node src/service.js --port 8000`）：启动演示服务，内存态引导数据

## 设计原则

1. **最小披露**：凭证只包含流程性事实——照护需求区间、ICU 区间（仅医院可证明）、入院/病危通知/紧急同意/待命/转院/手续办理等事件的**类型与时刻**；不含诊断、检查、治疗、用药。员工提交前可调用预览接口逐项查看将披露字段。
2. **可验证真伪与有效期**：凭证与短期状态令牌均为 Ed25519 签名信封（`care-certificate/1`、`care-credential-status/1`），负载经规范化 JSON 签名；企业侧只持有签发方公钥名录。凭证带 `valid_until`，吊销/取代通过 15 分钟有效的状态令牌实时反映。
3. **更正只产生新版本**：医院更正签发 `supersedes` 新版本，旧版本标记 `superseded` 且永不删除；企业侧差额调整先挂 `pending_review`，复核通过才过账，驳回则作废、维持原核准。劳动仲裁结果同理产生新版本与即时过账差额。
4. **重复不增假**：申报先扣除既往已核准区间（同员工跨申请、同患者跨员工轮换），再扣除已排定年假，剩余才进入照护假分类。
5. **按当期制度拆分**：制度按生效日版本化；跨午夜按本地日（默认 Asia/Shanghai +08:00）切分，跨制度换版区间各日适用当期版本；额度按本地日历日计，金额按实际凭证覆盖的分钟计。
6. **角色最小可见**：员工见全量本人视图与披露预览；主管只见排班影响（缺勤分钟/假别/待命，无凭证、无金额）；薪酬只见最近核准版本的区间与已过账调整；争议处理人须经 HR/工会授权（可过期）才能查看证据链，访问留痕。

## 核算规则（见 `contracts/policy.json`）

| 情形 | 处理 |
|---|---|
| 班内、ICU 窗口或紧急文书事件覆盖、现场 | 重症照护假（2025 版 5 日额度、全薪、须现场） |
| 转院/出院/手续办理事件 | 家庭照护假（80% 薪、日 8 小时上限） |
| 远程办理手续（`presence=remote`） | 远程办公（全薪） |
| 院方待命请求（可跨午夜） | 待命，不计缺勤 |
| 与年假重叠 | 按年假排除，不另计照护假 |
| 与既往核准/其他亲属同患者申报重叠 | 排除，或挂起 `relay_pending` 待争议裁定（计 0 薪） |
| 重症额度用尽 | 逐日降级：家庭照护假 → 事假（0 薪） |
| 无凭证支持 | 事假兜底并标 `unsubstantiated`，不会把正常缺勤误算成照护假 |

## 模块结构

```
src/domain/time.js        区间半开运算、本地日切分、扣除/合并
src/domain/credentials.js Ed25519 签发注册簿、验签、状态令牌、披露字段
src/domain/policy.js      版本化制度册（POL-2025 / POL-2026）
src/domain/engine.js      纯函数核算引擎（片段/排除/额度/待命/轮换）
src/domain/service.js     申请生命周期、更正/仲裁版本化调账、授权与角色视图
src/http/app.js           Bearer 角色鉴权与路由
src/bootstrap.js          演示签发方、员工、令牌（固定时钟 2025-06-10）
contracts/                领域样例与制度契约（测试中与代码一致性互校）
```

## HTTP 接口（Bearer 令牌，演示令牌见 `bootstrap.js`）

| 方法 & 路径 | 角色 | 说明 |
|---|---|---|
| `POST /employees/:id/certificates/preview` | employee(本人) | 预览披露字段与验签结果，不留存 |
| `POST /employees/:id/certificates` | employee(本人) | 验签并受理凭证 |
| `POST /employees/:id/claims` | employee(本人) | 建草稿，返回片段/排除/额度/合计 |
| `POST /claims/:id/submit` | employee(本人) | 提交复核 |
| `POST /claims/:id/review` | hr | 核准/驳回；同时过账或作废更正差额 |
| `POST /claims/:id/corrections` | employee(本人) | 提交医院更正后的新凭证版本 |
| `POST /claims/:id/arbitration` | arbitrator | 仲裁结果入账（授予区间可指定假别） |
| `POST /claims/:id/evidence-grants` | hr | 向争议处理人授予证据链访问权（可过期） |
| `GET /claims/:id/evidence` | arbitrator(授权) | 证据链：版本、输入、片段、排除、调整 |
| `GET /managers/:id/roster` | manager(本人) | 仅排班影响 |
| `GET /payroll` | payroll | 仅最近核准版本区间与已过账调整 |
| `GET /hr/queue` | hr | 待审队列（含无凭证/轮换挂起分钟） |
| `GET /adjustments/:id/trace` | payroll/hr/arbitrator | **从一笔调薪复原**：制度版本、凭证状态、排除的重叠时间、最终复核决定 |
| `POST /issuers/:id/certificates[ /:certId/supersede]` | issuer | 签发/更正（演示用） |

### 调账可追溯性示例

`GET /adjustments/ADJ-…/trace` 返回：调整触发方与差额、`policy_basis`（所用制度版本）、每版本凭证快照（版本号、状态、是否被取代、有效期）、`excluded_overlaps`（年假/重复/轮换/日上限）、挂起片段与最终复核决定。薪酬人员无需接触病历即可解释一笔薪资调整的全部依据。

## 演示数据

`bootstrap.js` 内置市中心医院、合规见证服务中心两名签发方（每次启动生成新演示密钥），员工 E001（子女，跨午夜班次+年假+深夜待命）、E002（配偶，轮换冲突），令牌：

`tok-employee-e001` / `tok-employee-e002` / `tok-manager-m01` / `tok-hr` / `tok-payroll` / `tok-arbitrator` / `tok-hospital` / `tok-witness`

演示为内存态、固定时钟、无真实个人资料；生产化需替换为持久化存储、真实签发方名录与状态端点、令牌换为 OIDC/联盟鉴权。

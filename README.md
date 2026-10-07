# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 运行

```bash
npm install
npm run build
npm run smoke
```

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。

## 项目/租户作用域边界

所有实体都归属且仅归属一个 `(tenantId, projectId)` 作用域。客户端控制的标识（容器条码、外部运行号、客户端操作号、客户端设备序列号）**只在同一作用域内唯一**，可在不同项目/租户中合法复用。

- 统一入口：每个查询/状态变更/结果关联方法都接收调用方 `{ tenantId, projectId }`，经 `domain/scope.ts` 的 `assertInScope` 校验后才能读取或变更聚合；越权请求返回 `scope.forbidden` 且不产生任何副作用（事务回滚）。
- 去重与幂等：`clientOperationId`、`sourceOperationId`、`externalRunId`、`(deviceId, clientSequence)` 的去重一律以 `(tenant, project)` 为界。同一作用域内相同 ID 不同 payload 返回/记录 `CONFLICT`（`*.operation_conflict`、`result.run_conflict`、`sample.client_sequence_conflict`、`sync.payload_conflict`），不会静默覆盖。
- 样本以 `(tenant, project, sampleId)` 复合键存储，支持显式样本 ID 跨项目共存；容器/分装条码、外部运行号的唯一性检查均限定在本项目内。
- 审计、Outbox、证据包：写入时携带归属作用域；证据包的清单收集、`requestKey` 幂等、快照版本计数与文件键（`evidence/{tenant}/{project}/...`）全部限定在单一项目内，跨项目活动不会改变已有证据包的快照版本或清单哈希。
- 同步：`SyncEnvelope` 必须带租户和项目；去重键含作用域，跨项目相同 operationId 独立落库；同项目不同 payload 记为 `CONFLICT` 且不分发、无副作用，原 `APPLIED` 记录保持为幂等锚点，相同重放返回 `DUPLICATE`。

## 测试

```bash
npm test
```

覆盖：跨项目同步、并发接收、同运行号不同内容冲突、错误项目导出/冻结/关联，以及跨租户同名项目隔离。


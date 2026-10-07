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
npm test
```

## 项目/租户边界模型

所有领域对象与请求都以 `(tenantId, projectId)` 为硬边界（见 `src/domain/scope.ts`）：

- **自然键按作用域唯一/幂等**：容器条码、分装条码、外部运行号、客户端操作号、设备序列、证据包 requestKey 只在同一 `(tenant, project)` 内唯一或去重；相同 ID 在不同项目/租户中合法共存。
- **先鉴权后查询**：所有按 ID/自然键的查询、去重和状态变更先加载实体并做 `assertScope`，越权请求在任何写入前抛 `scope.forbidden`，事务保证零副作用。
- **同作用域同键不同 payload 进入冲突处理**：抛出 `*.op_conflict` / `result.run_conflict` / `sample.client_op_conflict` / `sync.payload_conflict`，不会静默返回旧记录。
- **同步层**（`sync-service.ts`）：信封的 tenant/project 覆盖 payload；冲突结果持久化（不随事务回滚丢失），越权信封返回 `REJECTED` 并写审计。
- **审计、Outbox 事件、证据包**均带 tenant/project；证据包的快照版本只统计本项目活动，`freeze` 同样强制边界。

测试覆盖跨项目同步、并发接收、同运行号不同内容、错误项目导出四类场景（见 `test/`）。

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。

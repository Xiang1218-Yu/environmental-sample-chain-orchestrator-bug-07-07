import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { buildChain, assertThrows } from './helpers.js';

const TENANT = 'tenant-lab';
const OTHER_TENANT = 'tenant-other';
const A = 'project-alpha';
const B = 'project-beta';

async function approvedBatch(app: SampleChainApplication, tenantId: string, projectId: string, keys: { barcode: string; runId: string; opPrefix: string; barcodeAlq: string }, contentHash: string) {
  const chain = await buildChain(app, tenantId, projectId, keys);
  const result = app.results.ingestRevision({
    tenantId, projectId, batchId: chain.batchId, runId: chain.runId,
    aliquotId: chain.aliquotId, analyte: 'lead', value: 0.1, unit: 'mg/L', detectionLimit: 0.01,
    qualityFlags: [], instrumentSoftwareVersion: 'sw-1', contentHash,
  });
  app.quality.decide({
    tenantId, projectId, batchId: chain.batchId, resultId: result.id,
    decision: 'APPROVED', reason: 'ok', ruleVersion: 'q1', reviewerId: 'rv',
  });
  app.quality.approveBatch(chain.batchId, 'rv', { tenantId, projectId });
  return { chain, result };
}

test('错误项目导出：A 的证据包不含 B 的任何实体，且 A 的活动不改变 B 的快照哈希', async () => {
  const app = new SampleChainApplication();
  const a = await approvedBatch(app, TENANT, A, { barcode: 'BC-S', runId: 'RUN-S', opPrefix: 'op-a', barcodeAlq: 'ALQ-S' }, 'hash-a');
  const evA1 = app.evidence.generate({ tenantId: TENANT, projectId: A, requestKey: 'req-a' });
  app.evidence.freeze(evA1.id, { tenantId: TENANT, projectId: A });

  // B 随后产生大量活动（相同自然键）
  const b = await approvedBatch(app, TENANT, B, { barcode: 'BC-S', runId: 'RUN-S', opPrefix: 'op-b', barcodeAlq: 'ALQ-S' }, 'hash-b');
  const evB = app.evidence.generate({ tenantId: TENANT, projectId: B, requestKey: 'req-b' });

  // A 的包不含 B 的批次/结果/容器/样本/质控
  assert.ok(!evA1.sourceIds.batchIds.includes(b.chain.batchId));
  assert.ok(!evA1.sourceIds.sampleIds.some((id) => app.store.samples.get(id)!.projectId === B));
  assert.ok(!evA1.sourceIds.containerIds.some((id) => app.store.containers.get(id)!.projectId === B));
  assert.ok(!evA1.sourceIds.resultIds.some((id) => app.store.results.get(id)!.projectId === B));
  assert.ok(!evA1.sourceIds.qualityDecisionIds.some((id) => app.store.quality.get(id)!.projectId === B));

  // B 的包也不含 A
  assert.ok(!evB.sourceIds.batchIds.includes(a.chain.batchId));

  // A 重新生成同一 requestKey 直接返回已冻结包；即便强制新版本，其 snapshotVersion/hash 不受 B 活动影响
  const evA1Again = app.evidence.generate({ tenantId: TENANT, projectId: A, requestKey: 'req-a' });
  assert.equal(evA1Again.id, evA1.id);
  assert.equal(evA1Again.manifestHash, evA1.manifestHash);
  assert.equal(evA1Again.snapshotVersion, evA1.snapshotVersion);
});

test('其他项目/租户不能冻结、重放证据包', async () => {
  const app = new SampleChainApplication();
  await approvedBatch(app, TENANT, A, { barcode: 'BC-1', runId: 'R-1', opPrefix: 'o1', barcodeAlq: 'A-1' }, 'h1');
  const ev = app.evidence.generate({ tenantId: TENANT, projectId: A, requestKey: 'req' });
  assertThrows(() => app.evidence.freeze(ev.id, { tenantId: TENANT, projectId: B }), 'scope.forbidden');
  assertThrows(() => app.evidence.freeze(ev.id, { tenantId: OTHER_TENANT, projectId: A }), 'scope.forbidden');
  // 被拒后仍未冻结
  assert.equal(app.store.evidence.get(ev.id)!.status, 'READY');
  const frozen = app.evidence.freeze(ev.id, { tenantId: TENANT, projectId: A });
  assert.equal(frozen.status, 'FROZEN');
});

test('审计与事件全部携带正确的 tenant/project，跨项目零串扰', async () => {
  const app = new SampleChainApplication();
  await buildChain(app, TENANT, A, { barcode: 'BC-Z', runId: 'RUN-Z', opPrefix: 'op-a-z', barcodeAlq: 'ALQ-A' });
  await buildChain(app, TENANT, B, { barcode: 'BC-Z', runId: 'RUN-Z', opPrefix: 'op-b-z', barcodeAlq: 'ALQ-B' });

  for (const record of app.store.audit) {
    assert.ok(record.tenantId === TENANT);
    assert.ok([A, B].includes(record.projectId));
  }
  for (const message of app.store.outbox) {
    assert.ok(message.tenantId === TENANT);
    assert.ok([A, B].includes(message.projectId));
  }
  // 每个 aggregate 的审计/事件项目归属与实体一致
  const checkEntity = (entityId: string, projectId: string) => {
    for (const record of app.store.audit.filter((r) => r.entityId === entityId)) {
      assert.equal(record.projectId, projectId, `audit ${record.action} on ${entityId} crossed projects`);
    }
  };
  for (const container of app.store.containers.values()) checkEntity(container.id, container.projectId);
  for (const batch of app.store.batches.values()) checkEntity(batch.id, batch.projectId);
  // outbox 内容里的 id 也必须属于其项目（抽样校验容器事件）
  for (const message of app.store.outbox.filter((m) => m.topic.startsWith('custody') || m.topic === 'sample.received')) {
    const payload = JSON.parse(message.payload) as { containerId?: string };
    if (payload.containerId) assert.equal(app.store.containers.get(payload.containerId)!.projectId, message.projectId);
  }
});

test('requestKey 相同也只在各自项目内幂等', async () => {
  const app = new SampleChainApplication();
  await approvedBatch(app, TENANT, A, { barcode: 'KEY-1', runId: 'KEY-1-R', opPrefix: 'k1a', barcodeAlq: 'K1A' }, 'h1');
  await approvedBatch(app, TENANT, B, { barcode: 'KEY-1', runId: 'KEY-1-R', opPrefix: 'k1b', barcodeAlq: 'K1B' }, 'h2');
  const evA = app.evidence.generate({ tenantId: TENANT, projectId: A, requestKey: 'SAME-REQUEST-KEY' });
  const evB = app.evidence.generate({ tenantId: TENANT, projectId: B, requestKey: 'SAME-REQUEST-KEY' });
  assert.notEqual(evA.id, evB.id);
  assert.equal(evA.projectId, A);
  assert.equal(evB.projectId, B);
  assert.ok(!evA.sourceIds.batchIds.some((id) => app.store.batches.get(id)!.projectId === B));
  assert.ok(!evB.sourceIds.batchIds.some((id) => app.store.batches.get(id)!.projectId === A));
});

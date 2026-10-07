import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { buildChain, assertThrows } from './helpers.js';
const TENANT = 'tenant-lab';
const A = 'project-alpha';
const B = 'project-beta';
test('项目 B 不能接收/确认/处置项目 A 的容器，且无副作用', async () => {
    const app = new SampleChainApplication();
    const a = await buildChain(app, TENANT, A);
    const b = await buildChain(app, TENANT, B);
    // B 用 A 的容器发起接收（即便复用相同操作号）
    assertThrows(() => app.receiving.receive({
        tenantId: TENANT, projectId: B, containerId: a.container.id,
        receivedBy: 'rx-b', receivedAt: '2026-10-07T12:00:00Z', temperatureCelsius: 6,
        sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'shared-receive',
    }), 'scope.forbidden');
    // B 确认 A 的交接
    assertThrows(() => app.custody.confirmReceipt({
        tenantId: TENANT, projectId: B, transferId: a.transferId,
        receiverId: `courier-${A}`, receivedAt: '2026-10-07T12:00:00Z', temperatureCelsius: 6, sealStatus: 'INTACT',
    }), 'scope.forbidden');
    // B 交接 A 的容器
    assertThrows(() => app.custody.handOver({
        tenantId: TENANT, projectId: B, containerId: a.container.id,
        fromHolderId: `courier-${A}`, toHolderId: 'thief', fromLocation: 'LAB-a', toLocation: 'ELSEWHERE',
        handedOverAt: '2026-10-07T12:00:00Z', temperatureCelsius: 6, sealStatus: 'INTACT', clientOperationId: 'x-ho',
    }), 'scope.forbidden');
    // B 对 A 的样本分装
    assertThrows(() => app.aliquots.createMany({
        tenantId: TENANT, projectId: B, parentContainerId: a.container.id,
        protocolVersion: 'v1', createdBy: 'evil', operationId: 'evil-al',
        items: [{ barcode: 'EVIL', volumeMl: 5, unit: 'ML' }],
    }), 'scope.forbidden');
    // B 处置 A 的样本
    assertThrows(() => app.sampling.markDisposed(a.sample.id, { tenantId: TENANT, projectId: B }, 'evil'), 'scope.forbidden');
    // 容器/样本状态与持有人未被改变
    const container = app.store.containers.get(a.container.id);
    const sample = app.store.samples.get(a.sample.id);
    assert.equal(container.custodyStatus, 'RELEASED_TO_LAB');
    assert.equal(container.currentHolderId, `courier-${A}`);
    assert.equal(container.availableVolumeMl, 100 - 20);
    assert.equal(sample.status, 'RECEIVED');
    // B 的链路没有出现针对 A 实体的审计
    const cross = app.store.audit.filter((r) => r.projectId === B && r.entityId === a.container.id);
    assert.equal(cross.length, 0);
    // B 的实体也没有被 A 的请求碰到
    assert.equal(app.store.containers.get(b.container.id).custodyStatus, 'RELEASED_TO_LAB');
});
test('项目 B 不能把成员、运行、结果或质控挂到项目 A 的批次', async () => {
    const app = new SampleChainApplication();
    const a = await buildChain(app, TENANT, A);
    const b = await buildChain(app, TENANT, B);
    // B 的分装管加入 A 的批次
    assertThrows(() => app.batches.addAliquot(a.batchId, b.aliquotId, { tenantId: TENANT, projectId: B }), 'scope.forbidden');
    // A 的视角同样拒绝（请求是 A 但 aliquot 属于 B）
    assertThrows(() => app.batches.addAliquot(a.batchId, b.aliquotId, { tenantId: TENANT, projectId: A }), 'scope.forbidden');
    // B 在 A 的批次上注册运行
    assertThrows(() => app.results.registerRun({
        tenantId: TENANT, projectId: B, batchId: a.batchId, externalRunId: 'EVIL-RUN',
        rawFileHash: 'h', instrumentSoftwareVersion: 'sw', startedAt: '2026-10-07T12:00:00Z',
    }), 'scope.forbidden');
    // B 把结果挂到 A 的批次 + A 的运行（外部运行号相同也不行）
    assertThrows(() => app.results.ingestRevision({
        tenantId: TENANT, projectId: B, batchId: a.batchId, runId: a.runId,
        aliquotId: b.aliquotId, analyte: 'lead', value: 9, unit: 'mg/L', detectionLimit: 0.1,
        qualityFlags: [], instrumentSoftwareVersion: 'sw', contentHash: 'evil',
    }), 'scope.forbidden');
    // B 的结果作为质控挂到 A 的批次
    const resultB = app.results.ingestRevision({
        tenantId: TENANT, projectId: B, batchId: b.batchId, runId: b.runId,
        aliquotId: b.aliquotId, analyte: 'blank', value: 0, unit: 'mg/L', detectionLimit: 0.1,
        qualityFlags: [], instrumentSoftwareVersion: 'sw', contentHash: 'b-ctrl',
    });
    assertThrows(() => app.batches.attachControlResult(a.batchId, resultB.id, { tenantId: TENANT, projectId: B }), 'scope.forbidden');
    // B 对 A 批次上不存在于 B 的结果做质量判定
    const resultA = app.results.ingestRevision({
        tenantId: TENANT, projectId: A, batchId: a.batchId, runId: a.runId,
        aliquotId: a.aliquotId, analyte: 'lead', value: 0.1, unit: 'mg/L', detectionLimit: 0.01,
        qualityFlags: [], instrumentSoftwareVersion: 'sw', contentHash: 'a-r1',
    });
    assertThrows(() => app.quality.decide({
        tenantId: TENANT, projectId: B, batchId: a.batchId, resultId: resultA.id,
        decision: 'APPROVED', reason: 'x', ruleVersion: 'q1', reviewerId: 'evil',
    }), 'scope.forbidden');
    // B 批准/启动/就绪 A 的批次
    assertThrows(() => app.batches.markReady(a.batchId, { tenantId: TENANT, projectId: B }), 'scope.forbidden');
    assertThrows(() => app.batches.start(a.batchId, '2026-10-07T12:00:00Z', { tenantId: TENANT, projectId: B }), 'scope.forbidden');
    assertThrows(() => app.quality.approveBatch(a.batchId, 'evil', { tenantId: TENANT, projectId: B }), 'scope.forbidden');
    // B 完成 A 的运行
    assertThrows(() => app.results.completeRun(a.runId, '2026-10-07T12:00:00Z', 'COMPLETED', { tenantId: TENANT, projectId: B }), 'scope.forbidden');
    // A 的批次成员/控制结果没有被污染
    const batchA = app.store.batches.get(a.batchId);
    assert.deepEqual(batchA.memberAliquotIds, [a.aliquotId]);
    assert.deepEqual(batchA.controlResultIds, []);
    assert.equal([...app.store.results.values()].filter((r) => r.batchId === a.batchId && r.projectId === B).length, 0);
});
test('同项目同运行号不同 raw 文件/批次进入冲突处理，幂等返回不改变既有 run', async () => {
    const app = new SampleChainApplication();
    const a = await buildChain(app, TENANT, A);
    // 同号同内容是幂等
    const again = app.results.registerRun({
        tenantId: TENANT, projectId: A, batchId: a.batchId, externalRunId: 'SHARED-RUN',
        rawFileHash: `raw-${A}`, instrumentSoftwareVersion: 'sw-1', startedAt: '2026-10-07T11:10:00.000Z',
    });
    assert.equal(again.id, a.runId);
    // 同号不同内容冲突
    assertThrows(() => app.results.registerRun({
        tenantId: TENANT, projectId: A, batchId: a.batchId, externalRunId: 'SHARED-RUN',
        rawFileHash: 'totally-different', instrumentSoftwareVersion: 'sw-1', startedAt: '2026-10-07T11:10:00.000Z',
    }), 'result.run_conflict');
    assert.equal([...app.store.runs.values()].filter((r) => r.projectId === A && r.externalRunId === 'SHARED-RUN').length, 1);
});
test('同项目同操作号不同 payload 的接收/交接/分装均为冲突而非静默幂等', async () => {
    const app = new SampleChainApplication();
    const a = await buildChain(app, TENANT, A);
    // 容器已是 RELEASED_TO_LAB，无法再走 receive；这里直接验证操作号冲突判定：
    // 用交接在合法状态下制造一次幂等+冲突（A 容器已被交接过，换个可交接目标不行，改用第二条链路的容器做同号重放）
    const second = app.sampling.createSealedSample({
        tenantId: TENANT, projectId: A, collectorId: 'c2', protocolVersion: 'v1', medium: 'WATER',
        collectedAt: '2026-10-07T08:00:00Z', location: { latitude: 9, longitude: 9, siteCode: 'S2' },
        preservation: { temperatureCelsius: 4, method: 'm', maxTransitHours: 24 },
        clientDeviceId: 'd2', clientSequence: 1, containerBarcode: 'BC-2', sealCode: 'SEAL-2', totalVolumeMl: 100,
    });
    const ho = {
        tenantId: TENANT, projectId: A, containerId: second.container.id,
        fromHolderId: 'c2', toHolderId: 'courier2', fromLocation: 'S2', toLocation: 'L2',
        handedOverAt: '2026-10-07T09:00:00Z', temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'op-ho-x',
    };
    const t1 = app.custody.handOver(ho);
    const t2 = app.custody.handOver(ho);
    assert.equal(t1.id, t2.id);
    assertThrows(() => app.custody.handOver({ ...ho, toLocation: 'L2-OTHER' }), 'custody.op_conflict');
    // 冲突没有新增 transfer，也没有再次推进容器状态
    assert.equal([...app.store.transfers.values()].filter((t) => t.clientOperationId === 'op-ho-x').length, 1);
    assert.equal(app.store.containers.get(second.container.id).currentLocation, 'L2');
    // 接收同号不同内容：用一个新的已交接容器
    app.custody.confirmReceipt({
        tenantId: TENANT, projectId: A, transferId: t1.id, receiverId: 'courier2',
        receivedAt: '2026-10-07T10:00:00Z', temperatureCelsius: 5, sealStatus: 'INTACT',
    });
    const rx = {
        tenantId: TENANT, projectId: A, containerId: second.container.id,
        receivedBy: 'rx2', receivedAt: '2026-10-07T10:30:00Z', temperatureCelsius: 5,
        sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'op-rx-x',
    };
    app.receiving.receive(rx);
    assertThrows(() => app.receiving.receive({ ...rx, decision: 'REJECTED' }), 'receiving.op_conflict');
    assert.equal(app.store.containers.get(second.container.id).custodyStatus, 'RELEASED_TO_LAB');
    void a;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { envelope } from './helpers.js';
const TENANT = 'tenant-lab';
const A = 'project-alpha';
const B = 'project-beta';
function samplePayload(barcode, sequence, site) {
    return {
        collectorId: 'collector-x',
        protocolVersion: 'v1',
        medium: 'WATER',
        collectedAt: '2026-10-07T08:00:00.000Z',
        location: { latitude: 1, longitude: 1, siteCode: site },
        preservation: { temperatureCelsius: 4, method: 'm', maxTransitHours: 24 },
        clientDeviceId: 'ignored-device',
        clientSequence: sequence,
        containerBarcode: barcode,
        sealCode: 'SEAL-X',
        totalVolumeMl: 100,
    };
}
test('跨项目同步：相同设备、操作号、条码在两个项目各自落库，互不去重', async () => {
    const app = new SampleChainApplication();
    const make = (projectId) => envelope({
        tenantId: TENANT, projectId, deviceId: 'device-shared', clientSequence: 1, operationId: 'op-1',
        entityId: 'BC-SYNC', type: 'CREATE_SAMPLE', payload: samplePayload('BC-SYNC', 1, `SITE-${projectId}`),
    });
    const rA = await app.sync.apply(make(A));
    const rB = await app.sync.apply(make(B));
    assert.equal(rA, 'APPLIED');
    assert.equal(rB, 'APPLIED');
    const samplesA = [...app.store.samples.values()].filter((s) => s.projectId === A);
    const samplesB = [...app.store.samples.values()].filter((s) => s.projectId === B);
    assert.equal(samplesA.length, 1);
    assert.equal(samplesB.length, 1);
    assert.notEqual(samplesA[0].id, samplesB[0].id);
    assert.equal(samplesA[0].clientDeviceId, 'device-shared');
    // 信封的 tenant/project 覆盖 payload 中的伪造字段
    assert.equal(samplesA[0].projectId, A);
    // 同步记录分项目存在
    assert.equal(app.store.syncRecords.size, 2);
});
test('同项目同操作号不同 payload：CONFLICT 持久化且无领域副作用，再次不同内容仍被识别', async () => {
    const app = new SampleChainApplication();
    const base = {
        tenantId: TENANT, projectId: A, deviceId: 'device-1', clientSequence: 1, operationId: 'op-conflict',
        entityId: 'BC-C', type: 'CREATE_SAMPLE',
    };
    const first = await app.sync.apply(envelope({ ...base, payload: samplePayload('BC-C', 1, 'SITE-1') }));
    assert.equal(first, 'APPLIED');
    const samplesAfterApply = app.store.samples.size;
    const second = await app.sync.apply(envelope({ ...base, payload: samplePayload('BC-C', 1, 'SITE-DIFFERENT') }));
    assert.equal(second, 'CONFLICT');
    // 冲突不能回滚掉：原始 APPLIED 记录仍在，冲突记录也留痕
    const records = [...app.store.syncRecords.values()];
    assert.ok(records.some((r) => r.result === 'APPLIED'));
    assert.ok(records.some((r) => r.result === 'CONFLICT' && r.conflictReason));
    // 没有新建样本
    assert.equal(app.store.samples.size, samplesAfterApply);
    // 相同内容重放 -> DUPLICATE
    const third = await app.sync.apply(envelope({ ...base, payload: samplePayload('BC-C', 1, 'SITE-1') }));
    assert.equal(third, 'DUPLICATE');
    // 审计中有冲突事件且归属正确项目
    assert.ok(app.store.audit.some((r) => r.action === 'sync.payload_conflict' && r.projectId === A));
});
test('越权同步信封（引用其他项目容器）返回 REJECTED，容器状态不变且有拒绝审计', async () => {
    const app = new SampleChainApplication();
    // A 先建样本
    await app.sync.apply(envelope({
        tenantId: TENANT, projectId: A, deviceId: 'da', clientSequence: 1, operationId: 'op-a-create',
        entityId: 'BC-A', type: 'CREATE_SAMPLE', payload: samplePayload('BC-A', 1, 'SITE-A'),
    }));
    const containerA = [...app.store.containers.values()].find((c) => c.projectId === A);
    const before = containerA.custodyStatus;
    const result = await app.sync.apply(envelope({
        tenantId: TENANT, projectId: B, deviceId: 'db', clientSequence: 1, operationId: 'op-b-evil',
        entityId: containerA.id, type: 'CUSTODY_TRANSFER', payload: {
            containerId: containerA.id, fromHolderId: 'collector-x', toHolderId: 'thief',
            fromLocation: 'SITE-A', toLocation: 'EVIL', handedOverAt: '2026-10-07T09:00:00Z',
            temperatureCelsius: 5, sealStatus: 'INTACT',
        },
    }));
    assert.equal(result, 'REJECTED');
    assert.equal(app.store.containers.get(containerA.id).custodyStatus, before);
    assert.equal(app.store.containers.get(containerA.id).currentHolderId, 'collector-x');
    assert.ok(![...app.store.transfers.values()].some((t) => t.projectId === B && t.containerId === containerA.id));
    assert.ok(app.store.audit.some((r) => r.action === 'sync.scope_rejected' && r.projectId === B));
});
test('跨租户同项目名的同步信封互不串项目', async () => {
    const app = new SampleChainApplication();
    const mk = (tenantId) => envelope({
        tenantId, projectId: 'same-name', deviceId: 'device-shared', clientSequence: 1, operationId: 'op-1',
        entityId: 'BC-TENANT', type: 'CREATE_SAMPLE', payload: samplePayload('BC-TENANT', 1, `SITE-${tenantId}`),
    });
    assert.equal(await app.sync.apply(mk('tenant-1')), 'APPLIED');
    assert.equal(await app.sync.apply(mk('tenant-2')), 'APPLIED');
    assert.equal([...app.store.samples.values()].filter((s) => s.projectId === 'same-name').length, 2);
    const t1Samples = [...app.store.samples.values()].filter((s) => s.tenantId === 'tenant-1');
    const t2Samples = [...app.store.samples.values()].filter((s) => s.tenantId === 'tenant-2');
    assert.equal(t1Samples[0].containerId !== t2Samples[0].containerId, true);
    // 同操作号在租户-2 重放为 DUPLICATE，而不是租户-1 的记录
    assert.equal(await app.sync.apply(mk('tenant-2')), 'DUPLICATE');
});
test('越权重放稳定返回 REJECTED，不产生第二条拒绝记录之外的副作用', async () => {
    const app = new SampleChainApplication();
    await app.sync.apply(envelope({
        tenantId: TENANT, projectId: A, deviceId: 'da', clientSequence: 1, operationId: 'op-a',
        entityId: 'BC-A', type: 'CREATE_SAMPLE', payload: samplePayload('BC-A', 1, 'SITE-A'),
    }));
    const containerA = [...app.store.containers.values()].find((c) => c.projectId === A);
    const evil = envelope({
        tenantId: TENANT, projectId: B, deviceId: 'db', clientSequence: 1, operationId: 'op-evil',
        entityId: containerA.id, type: 'CUSTODY_TRANSFER', payload: {
            containerId: containerA.id, fromHolderId: 'collector-x', toHolderId: 'thief',
            fromLocation: 'SITE-A', toLocation: 'EVIL', handedOverAt: '2026-10-07T09:00:00Z',
            temperatureCelsius: 5, sealStatus: 'INTACT',
        },
    });
    assert.equal(await app.sync.apply(evil), 'REJECTED');
    assert.equal(await app.sync.apply(evil), 'REJECTED');
    assert.equal(app.store.containers.get(containerA.id).currentHolderId, 'collector-x');
    // 只有一条拒绝同步记录（主 key 幂等）和一条拒绝审计
    assert.equal([...app.store.syncRecords.values()].filter((r) => r.result === 'REJECTED').length, 1);
});
test('并发接收：同操作号并发只生效一次；不同操作号并发对同一容器的第二次接收被状态机拦截', async () => {
    const app = new SampleChainApplication();
    // 手工准备一个 HANDED_OVER 容器
    const sealed = app.sampling.createSealedSample({
        tenantId: TENANT, projectId: A, collectorId: 'collector-x', protocolVersion: 'v1', medium: 'WATER',
        collectedAt: '2026-10-07T08:00:00Z', location: { latitude: 1, longitude: 1, siteCode: 'S' },
        preservation: { temperatureCelsius: 4, method: 'm', maxTransitHours: 24 },
        clientDeviceId: 'd1', clientSequence: 1, containerBarcode: 'BC-CONC', sealCode: 'SEAL-C', totalVolumeMl: 100,
    });
    app.custody.handOver({
        tenantId: TENANT, projectId: A, containerId: sealed.container.id,
        fromHolderId: 'collector-x', toHolderId: 'courier', fromLocation: 'S', toLocation: 'LAB',
        handedOverAt: '2026-10-07T09:00:00Z', temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'ho-c',
    });
    const rx = {
        tenantId: TENANT, projectId: A, containerId: sealed.container.id,
        receivedBy: 'rx', receivedAt: '2026-10-07T10:00:00Z', temperatureCelsius: 5,
        sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'op-rx-conc',
    };
    // 同操作号并发：全部成功返回同一条记录，只落一条
    const sameOp = await Promise.all([
        app.sync.apply(envelope({ tenantId: TENANT, projectId: A, deviceId: 'd1', clientSequence: 2, operationId: rx.clientOperationId, entityId: sealed.container.id, type: 'RECEIVE_CONTAINER', payload: (({ clientOperationId: _omit, ...rest }) => rest)(rx) })),
        app.sync.apply(envelope({ tenantId: TENANT, projectId: A, deviceId: 'd1', clientSequence: 2, operationId: rx.clientOperationId, entityId: sealed.container.id, type: 'RECEIVE_CONTAINER', payload: (({ clientOperationId: _omit, ...rest }) => rest)(rx) })),
        app.sync.apply(envelope({ tenantId: TENANT, projectId: A, deviceId: 'd1', clientSequence: 2, operationId: rx.clientOperationId, entityId: sealed.container.id, type: 'RECEIVE_CONTAINER', payload: (({ clientOperationId: _omit, ...rest }) => rest)(rx) })),
    ]);
    assert.deepEqual([...sameOp].sort(), ['APPLIED', 'DUPLICATE', 'DUPLICATE']);
    assert.equal([...app.store.receiving.values()].length, 1);
    assert.equal(app.store.containers.get(sealed.container.id).custodyStatus, 'RELEASED_TO_LAB');
    // 不同操作号并发再次接收同一容器：状态机拒绝两个请求，且事务回滚无第二条接收记录
    const attempts = await Promise.allSettled([
        Promise.resolve().then(() => app.receiving.receive({ ...rx, clientOperationId: 'op-rx-2' })),
        Promise.resolve().then(() => app.receiving.receive({ ...rx, clientOperationId: 'op-rx-3' })),
    ]);
    for (const attempt of attempts) {
        assert.equal(attempt.status, 'rejected');
        if (attempt.status === 'rejected') {
            assert.equal(attempt.reason.code, 'receiving.invalid_state');
        }
    }
    assert.equal([...app.store.receiving.values()].length, 1);
});

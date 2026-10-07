import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { buildChain } from './helpers.js';
const TENANT = 'tenant-lab';
const A = 'project-alpha';
const B = 'project-beta';
test('相同容器条码、分装条码和外部运行号在两个项目中可合法共存', async () => {
    const app = new SampleChainApplication();
    const keys = { barcode: 'BC-SAME', runId: 'RUN-SAME', opPrefix: 'shared', barcodeAlq: 'ALQ-SAME' };
    const chainA = await buildChain(app, TENANT, A, keys);
    const chainB = await buildChain(app, TENANT, B, keys);
    assert.notEqual(chainA.container.id, chainB.container.id);
    assert.equal(chainA.container.barcode, chainB.container.barcode);
    assert.equal(chainA.runId !== chainB.runId, true);
    const runs = [...app.store.runs.values()].filter((run) => run.externalRunId === 'RUN-SAME');
    assert.equal(runs.length, 2);
    assert.deepEqual(new Set(runs.map((run) => run.projectId)), new Set([A, B]));
    const aliquots = [...app.store.aliquots.values()].filter((item) => item.barcode === 'ALQ-SAME');
    assert.equal(aliquots.length, 2);
});
test('同项目内条码仍然唯一，重复创建进入冲突处理', async () => {
    const app = new SampleChainApplication();
    await buildChain(app, TENANT, A, { barcode: 'BC-DUP', runId: 'r1', opPrefix: 'p1', barcodeAlq: 'ALQ-1' });
    assert.throws(() => app.sampling.createSealedSample({
        tenantId: TENANT, projectId: A, collectorId: 'c', protocolVersion: 'v1', medium: 'WATER',
        collectedAt: '2026-10-07T08:00:00Z', location: { latitude: 1, longitude: 1, siteCode: 'X' },
        preservation: { temperatureCelsius: 4, method: 'm', maxTransitHours: 24 },
        clientDeviceId: 'd', clientSequence: 99, containerBarcode: 'BC-DUP', sealCode: 'SEAL-X', totalVolumeMl: 50,
    }), (error) => error.code === 'sample.barcode_conflict');
});
test('同项目同设备同序列的重放：相同 payload 幂等，不同 payload 冲突', async () => {
    const app = new SampleChainApplication();
    const base = {
        tenantId: TENANT, projectId: A, collectorId: 'c1', protocolVersion: 'v1', medium: 'WATER',
        collectedAt: '2026-10-07T08:00:00Z', location: { latitude: 1, longitude: 1, siteCode: 'X' },
        preservation: { temperatureCelsius: 4, method: 'm', maxTransitHours: 24 },
        clientDeviceId: 'device-1', clientSequence: 7, containerBarcode: 'BC-7', sealCode: 'SEAL-7', totalVolumeMl: 60,
    };
    const first = app.sampling.createSealedSample(base);
    const replay = app.sampling.createSealedSample(base);
    assert.equal(replay.sample.id, first.sample.id);
    assert.equal(app.store.samples.size, 1);
    assert.throws(() => app.sampling.createSealedSample({ ...base, totalVolumeMl: 90 }), (error) => error.code === 'sample.client_op_conflict');
    // 冲突不能产生第二个样本/容器
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
});
test('跨租户即使项目名相同，所有自然键也互不影响', async () => {
    const app = new SampleChainApplication();
    const t1 = await buildChain(app, 'tenant-1', 'same-project-name', { barcode: 'BC-X', runId: 'RUN-X', opPrefix: 'o1', barcodeAlq: 'A-X' });
    const t2 = await buildChain(app, 'tenant-2', 'same-project-name', { barcode: 'BC-X', runId: 'RUN-X', opPrefix: 'o2', barcodeAlq: 'A-X' });
    assert.equal(t1.projectId, t2.projectId);
    assert.notEqual(t1.container.id, t2.container.id);
    assert.equal(app.store.samples.size, 2);
});

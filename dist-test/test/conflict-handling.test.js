import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { makeScope } from './helpers.js';
function expectCode(code, fn) {
    try {
        fn();
        assert.fail(`expected error ${code}`);
    }
    catch (error) {
        assert.equal(error.code, code);
    }
}
describe('same-project idempotency and payload conflicts', () => {
    test('identical replay of client operation returns the same record with no extra side effects', () => {
        const app = new SampleChainApplication();
        const scope = makeScope('A');
        const sealed = app.sampling.createSealedSample({
            ...scope, collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
            collectedAt: '2026-10-06T08:00:00.000Z',
            location: { latitude: 1, longitude: 2, siteCode: 'S' },
            preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
            clientDeviceId: 'd1', clientSequence: 1,
            containerBarcode: 'CNT-1', sealCode: 'SEAL-1', totalVolumeMl: 100,
        });
        app.custody.handOver({
            ...scope, containerId: sealed.container.id, fromHolderId: 'c1', toHolderId: 'courier',
            fromLocation: 'S', toLocation: 'L', handedOverAt: '2026-10-06T09:00:00.000Z',
            temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'op-1',
        });
        // Identical replay.
        const replay = app.custody.handOver({
            ...scope, containerId: sealed.container.id, fromHolderId: 'c1', toHolderId: 'courier',
            fromLocation: 'S', toLocation: 'L', handedOverAt: '2026-10-06T09:00:00.000Z',
            temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'op-1',
        });
        const transfers = [...app.store.transfers.values()].filter((t) => t.clientOperationId === 'op-1');
        assert.equal(transfers.length, 1);
        assert.equal(replay.id, transfers[0].id);
        // No duplicated audit/outbox or temperature readings.
        const handoverAudits = app.store.audit.filter((a) => a.action === 'custody.handed_over');
        assert.equal(handoverAudits.length, 1);
        assert.equal(sealed.container.temperatureLog.length, 2); // sealed + one handover
    });
    test('same client operation id with different payload in one project is a conflict with no side effects', () => {
        const app = new SampleChainApplication();
        const scope = makeScope('A');
        const sealed = app.sampling.createSealedSample({
            ...scope, collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
            collectedAt: '2026-10-06T08:00:00.000Z',
            location: { latitude: 1, longitude: 2, siteCode: 'S' },
            preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
            clientDeviceId: 'd1', clientSequence: 1,
            containerBarcode: 'CNT-1', sealCode: 'SEAL-1', totalVolumeMl: 100,
        });
        app.custody.handOver({
            ...scope, containerId: sealed.container.id, fromHolderId: 'c1', toHolderId: 'courier-1',
            fromLocation: 'S', toLocation: 'L1', handedOverAt: '2026-10-06T09:00:00.000Z',
            temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: 'op-1',
        });
        const transfersBefore = app.store.transfers.size;
        const logLength = sealed.container.temperatureLog.length;
        const auditsBefore = app.store.audit.length;
        // Same op id, different destination => conflict.
        expectCode('custody.operation_conflict', () => app.custody.handOver({
            ...scope, containerId: sealed.container.id, fromHolderId: 'c1', toHolderId: 'courier-2',
            fromLocation: 'S', toLocation: 'L2', handedOverAt: '2026-10-06T09:05:00.000Z',
            temperatureCelsius: 6, sealStatus: 'INTACT', clientOperationId: 'op-1',
        }));
        assert.equal(app.store.transfers.size, transfersBefore);
        assert.equal(sealed.container.temperatureLog.length, logLength);
        assert.equal(app.store.audit.length, auditsBefore);
    });
    test('receiving and aliquot replay conflicts when payload differs', () => {
        const app = new SampleChainApplication();
        const scope = makeScope('A');
        const sealed = app.sampling.createSealedSample({
            ...scope, collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
            collectedAt: '2026-10-06T08:00:00.000Z',
            location: { latitude: 1, longitude: 2, siteCode: 'S' },
            preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
            clientDeviceId: 'd1', clientSequence: 1,
            containerBarcode: 'CNT-1', sealCode: 'SEAL-1', totalVolumeMl: 100,
        });
        sealed.container.custodyStatus = 'HANDED_OVER';
        app.receiving.receive({
            ...scope, containerId: sealed.container.id, receivedBy: 'r1',
            receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5,
            sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'recv-1',
        });
        expectCode('receiving.operation_conflict', () => app.receiving.receive({
            ...scope, containerId: sealed.container.id, receivedBy: 'r2',
            receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 8,
            sealStatus: 'BROKEN', decision: 'REJECTED', clientOperationId: 'recv-1',
        }));
        const aliquots = app.aliquots.createMany({
            ...scope, parentContainerId: sealed.container.id, protocolVersion: 'v',
            createdBy: 'a1', operationId: 'al-1',
            items: [{ barcode: 'ALQ-1', volumeMl: 10, unit: 'ML' }],
        });
        const volumeAfterFirst = sealed.container.availableVolumeMl;
        // Same operation id, different item => conflict and volume not deducted twice.
        expectCode('aliquot.operation_conflict', () => app.aliquots.createMany({
            ...scope, parentContainerId: sealed.container.id, protocolVersion: 'v',
            createdBy: 'a1', operationId: 'al-1',
            items: [{ barcode: 'ALQ-1', volumeMl: 20, unit: 'ML' }],
        }));
        assert.equal(sealed.container.availableVolumeMl, volumeAfterFirst);
        assert.equal(app.store.aliquots.size, aliquots.length);
        // Barcode reuse in the same project is rejected, even via a new operation.
        expectCode('aliquot.barcode_conflict', () => app.aliquots.createMany({
            ...scope, parentContainerId: sealed.container.id, protocolVersion: 'v',
            createdBy: 'a1', operationId: 'al-2',
            items: [{ barcode: 'ALQ-1', volumeMl: 5, unit: 'ML' }],
        }));
    });
    test('same client device+sequence with different payload conflicts; same barcode across projects is fine', () => {
        const app = new SampleChainApplication();
        const scope = makeScope('A');
        const base = {
            collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
            collectedAt: '2026-10-06T08:00:00.000Z',
            location: { latitude: 1, longitude: 2, siteCode: 'S' },
            preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
            clientDeviceId: 'd1', clientSequence: 1,
            containerBarcode: 'CNT-1', sealCode: 'SEAL-1', totalVolumeMl: 100,
        };
        app.sampling.createSealedSample({ ...scope, ...base });
        // Different payload (other barcode) on same device+sequence => conflict.
        expectCode('sample.client_sequence_conflict', () => app.sampling.createSealedSample({
            ...scope, ...base, containerBarcode: 'CNT-CHANGED',
        }));
        // Identical replay is idempotent.
        const replay = app.sampling.createSealedSample({ ...scope, ...base });
        assert.equal(replay.container.barcode, 'CNT-1');
        assert.equal(app.store.samples.size, 1);
        // Same barcode + same device + same sequence in project B is independent.
        const scopeB = makeScope('B');
        const inB = app.sampling.createSealedSample({ ...scopeB, ...base });
        assert.equal(inB.container.barcode, 'CNT-1');
        assert.equal(app.store.samples.size, 2);
    });
    test('external run id is scoped to project; same project with different raw file conflicts', () => {
        const app = new SampleChainApplication();
        const scope = makeScope('A');
        const batch = runningBatch(app, scope, 'CNT-1');
        const run = app.results.registerRun({
            ...scope, batchId: batch.id, externalRunId: 'EXT-1', rawFileHash: 'hash-a',
            instrumentSoftwareVersion: 'v', startedAt: '2026-10-06T11:00:00.000Z',
        });
        // Same hash: idempotent replay.
        assert.equal(app.results.registerRun({
            ...scope, batchId: batch.id, externalRunId: 'EXT-1', rawFileHash: 'hash-a',
            instrumentSoftwareVersion: 'v', startedAt: '2026-10-06T11:00:00.000Z',
        }).id, run.id);
        // Different raw file with same external run id: conflict.
        expectCode('result.run_conflict', () => app.results.registerRun({
            ...scope, batchId: batch.id, externalRunId: 'EXT-1', rawFileHash: 'hash-b',
            instrumentSoftwareVersion: 'v', startedAt: '2026-10-06T11:00:00.000Z',
        }));
    });
});
function runningBatch(app, scope, barcode) {
    const seq = [...barcode].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const sealed = app.sampling.createSealedSample({
        ...scope, collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
        collectedAt: '2026-10-06T08:00:00.000Z',
        location: { latitude: 1, longitude: 2, siteCode: 'S' },
        preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
        clientDeviceId: 'd', clientSequence: seq,
        containerBarcode: barcode, sealCode: 'SEAL-1', totalVolumeMl: 100,
    });
    sealed.container.custodyStatus = 'RELEASED_TO_LAB';
    sealed.container.sealStatus = 'RESEALED';
    const aliquots = app.aliquots.createMany({
        ...scope, parentContainerId: sealed.container.id, protocolVersion: 'v', createdBy: 'a',
        operationId: `al-${barcode}`, items: [{ barcode: `ALQ-${barcode}`, volumeMl: 10, unit: 'ML' }],
    });
    const batch = app.batches.create({ ...scope, protocolVersion: 'v', instrumentType: 'ICP-MS', requiredControls: [], createdBy: 'a' });
    app.batches.addAliquot({ ...scope, batchId: batch.id, aliquotId: aliquots[0].id });
    app.batches.markReady({ ...scope, batchId: batch.id });
    app.batches.start({ ...scope, batchId: batch.id, startedAt: '2026-10-06T11:00:00.000Z' });
    return batch;
}

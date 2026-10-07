import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
describe('tenant boundary (same project id in different tenants)', () => {
    test('identical project id in two tenants shares nothing', () => {
        const app = new SampleChainApplication();
        const make = (tenantId) => {
            const sealed = app.sampling.createSealedSample({
                tenantId, projectId: 'SAME-PROJECT', collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
                collectedAt: '2026-10-06T08:00:00.000Z',
                location: { latitude: 1, longitude: 2, siteCode: 'S' },
                preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
                clientDeviceId: 'd1', clientSequence: 1,
                containerBarcode: 'CNT-1', sealCode: 'SEAL-1', totalVolumeMl: 100,
            });
            return sealed;
        };
        const a = make('tenant-X');
        const b = make('tenant-Y');
        assert.notEqual(a.sample.id, b.sample.id);
        // Tenant Y cannot touch tenant X's container even with the same project id.
        try {
            app.custody.handOver({
                tenantId: 'tenant-Y', projectId: 'SAME-PROJECT', containerId: a.container.id,
                fromHolderId: 'c1', toHolderId: 'intruder', fromLocation: 'S', toLocation: 'L',
                handedOverAt: '2026-10-06T09:00:00.000Z', temperatureCelsius: 5,
                sealStatus: 'INTACT', clientOperationId: 'op-1',
            });
            assert.fail('expected scope.forbidden');
        }
        catch (error) {
            assert.equal(error.code, 'scope.forbidden');
        }
        // Client-supplied sample id with the same value is legal in both tenants.
        const cA = app.sampling.createSealedSample({
            tenantId: 'tenant-X', projectId: 'SAME-PROJECT', collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
            collectedAt: '2026-10-06T08:00:00.000Z',
            location: { latitude: 1, longitude: 2, siteCode: 'S2' },
            preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
            clientDeviceId: 'd1', clientSequence: 2, sampleId: 'ext-id-99',
            containerBarcode: 'CNT-2', sealCode: 'SEAL-2', totalVolumeMl: 100,
        });
        const cB = app.sampling.createSealedSample({
            tenantId: 'tenant-Y', projectId: 'SAME-PROJECT', collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
            collectedAt: '2026-10-06T08:00:00.000Z',
            location: { latitude: 1, longitude: 2, siteCode: 'S2' },
            preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
            clientDeviceId: 'd1', clientSequence: 2, sampleId: 'ext-id-99',
            containerBarcode: 'CNT-2', sealCode: 'SEAL-2', totalVolumeMl: 100,
        });
        assert.equal(cA.sample.id, 'ext-id-99');
        assert.equal(cB.sample.id, 'ext-id-99');
        assert.notEqual(cA.container.id, cB.container.id);
    });
    test('result cannot reference an aliquot from another project/tenant', () => {
        const app = new SampleChainApplication();
        const fixture = (scope, barcode, seq) => {
            const sealed = app.sampling.createSealedSample({
                ...scope, collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
                collectedAt: '2026-10-06T08:00:00.000Z',
                location: { latitude: 1, longitude: 2, siteCode: barcode },
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
            const run = app.results.registerRun({
                ...scope, batchId: batch.id, externalRunId: `RUN-${barcode}`, rawFileHash: `h-${barcode}`,
                instrumentSoftwareVersion: 'v', startedAt: '2026-10-06T11:00:00.000Z',
            });
            return { scope, batch, run, foreignAliquot: aliquots[0] };
        };
        const a = fixture({ tenantId: 'tA', projectId: 'pA' }, 'C-A', 1);
        const b = fixture({ tenantId: 'tB', projectId: 'pB' }, 'C-B', 1);
        // A's run/batch with B's aliquot id: rejected before any revision is written.
        const resultsBefore = app.store.results.size;
        try {
            app.results.ingestRevision({
                ...a.scope, batchId: a.batch.id, runId: a.run.id, aliquotId: b.foreignAliquot.id,
                analyte: 'lead', value: 1, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [],
                instrumentSoftwareVersion: 'v', contentHash: 'evil',
            });
            assert.fail('expected scope.forbidden');
        }
        catch (error) {
            assert.equal(error.code, 'scope.forbidden');
        }
        assert.equal(app.store.results.size, resultsBefore);
        // Cross-project batch.addAliquot is rejected as well.
        try {
            app.batches.addAliquot({ ...a.scope, batchId: a.batch.id, aliquotId: b.foreignAliquot.id });
            assert.fail('expected scope.forbidden');
        }
        catch (error) {
            assert.equal(error.code, 'scope.forbidden');
        }
        assert.ok(!a.batch.memberAliquotIds.includes(b.foreignAliquot.id));
    });
    test('quality decision cannot pair another project result with this project batch', () => {
        const app = new SampleChainApplication();
        const scopeA = { tenantId: 'tA', projectId: 'pA' };
        const scopeB = { tenantId: 'tB', projectId: 'pB' };
        // Minimal two-batch setup reusing the helper flow via evidence fixture is heavy;
        // hand-place runs/results instead.
        const batchA = app.batches.create({ ...scopeA, protocolVersion: 'v', instrumentType: 'x', requiredControls: [], createdBy: 'u' });
        const batchB = app.batches.create({ ...scopeB, protocolVersion: 'v', instrumentType: 'x', requiredControls: [], createdBy: 'u' });
        // Fabricate runs/results directly through store with proper scopes.
        const runB = { id: app.store.nextId('run'), ...scopeB, batchId: batchB.id, externalRunId: 'r', rawFileHash: 'h', instrumentSoftwareVersion: 'v', startedAt: 't', status: 'REGISTERED', version: 1 };
        app.store.runs.set(runB.id, runB);
        const resultB = {
            id: app.store.nextId('result'), ...scopeB, batchId: batchB.id, runId: runB.id,
            analyte: 'lead', value: 1, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [],
            instrumentSoftwareVersion: 'v', contentHash: 'hh', revisionNumber: 1, status: 'CURRENT',
            createdAt: 't', version: 1,
        };
        app.store.results.set(resultB.id, resultB);
        try {
            app.quality.decide({
                ...scopeA, batchId: batchA.id, resultId: resultB.id, decision: 'APPROVED',
                reason: 'x', ruleVersion: 'r', reviewerId: 'u',
            });
            assert.fail('expected scope.forbidden');
        }
        catch (error) {
            assert.equal(error.code, 'scope.forbidden');
        }
        assert.equal(app.store.quality.size, 0);
    });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { buildApprovedProject, makeScope } from './helpers.js';
function expectForbidden(fn) {
    try {
        fn();
        assert.fail('expected scope.forbidden error');
    }
    catch (error) {
        assert.equal(error.code, 'scope.forbidden');
    }
}
describe('cross-project isolation with shared client identifiers', () => {
    test('same container barcode, external run id and client operation ids coexist legally in two projects', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        const b = buildApprovedProject(app, makeScope('B'));
        // Both chains reuse the exact same barcode / run id / client operation ids.
        assert.equal(a.container.barcode, b.container.barcode);
        assert.equal(a.run.externalRunId, b.run.externalRunId);
        const aOps = [...app.store.transfers.values(), ...app.store.receiving.values()]
            .filter((r) => r.tenantId === a.scope.tenantId).map((r) => r.clientOperationId);
        const bOps = [...app.store.transfers.values(), ...app.store.receiving.values()]
            .filter((r) => r.tenantId === b.scope.tenantId).map((r) => r.clientOperationId);
        assert.deepEqual(aOps.sort(), bOps.sort());
        // They are distinct aggregates, each confined to its own project.
        assert.notEqual(a.container.id, b.container.id);
        assert.notEqual(a.batch.id, b.batch.id);
        assert.notEqual(a.run.id, b.run.id);
        const containers = [...app.store.containers.values()].filter((c) => c.barcode === a.container.barcode);
        assert.equal(containers.length, 2);
        const runs = [...app.store.runs.values()].filter((r) => r.externalRunId === 'RUN-SHARED');
        assert.equal(runs.length, 2);
    });
    test('project B receive request cannot confirm/mutate project A container', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        buildApprovedProject(app, makeScope('B'));
        // Direct receiving entry: wrong project referencing A's container id.
        expectForbidden(() => app.receiving.receive({
            tenantId: 'tenant-B', projectId: 'project-B',
            containerId: a.container.id,
            receivedBy: 'intruder', receivedAt: '2026-10-07T00:00:00.000Z',
            temperatureCelsius: 9, sealStatus: 'BROKEN', decision: 'REJECTED',
            clientOperationId: 'op-receive-shared',
        }));
        // Custody confirm on A's transfer from B's scope is rejected.
        const aTransfer = [...app.store.transfers.values()].find((t) => t.containerId === a.container.id);
        expectForbidden(() => app.custody.confirmReceipt(aTransfer.id, {
            tenantId: 'tenant-B', projectId: 'project-B',
            receiverId: 'courier-shared', receivedAt: '2026-10-07T00:00:00.000Z',
            temperatureCelsius: 9, sealStatus: 'BROKEN',
        }));
        // No side effects leaked onto A: state and holders unchanged.
        const aContainerFresh = app.store.containers.get(a.container.id);
        assert.equal(aContainerFresh.custodyStatus, 'RELEASED_TO_LAB');
        assert.equal(aContainerFresh.sealStatus, 'INTACT');
        const aReceiving = [...app.store.receiving.values()].filter((r) => r.containerId === a.container.id);
        assert.equal(aReceiving.length, 1);
        assert.equal(aReceiving[0].decision, 'ACCEPTED');
    });
    test('project B instrument result cannot be attached to project A batch', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        const b = buildApprovedProject(app, makeScope('B'));
        // registerRun against A's batch using B's scope.
        expectForbidden(() => app.results.registerRun({
            tenantId: 'tenant-B', projectId: 'project-B',
            batchId: a.batch.id, externalRunId: 'RUN-SHARED', rawFileHash: 'evil',
            instrumentSoftwareVersion: 'x', startedAt: '2026-10-07T00:00:00.000Z',
        }));
        // Result ingestion referencing A's batch+run under B's scope.
        expectForbidden(() => app.results.ingestRevision({
            tenantId: 'tenant-B', projectId: 'project-B',
            batchId: a.batch.id, runId: a.run.id, analyte: 'lead', value: 99,
            unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [],
            instrumentSoftwareVersion: 'x', contentHash: 'evil-hash',
        }));
        // Attaching B's control result to A's batch.
        expectForbidden(() => app.batches.attachControlResult({
            tenantId: 'tenant-B', projectId: 'project-B',
            batchId: a.batch.id, resultId: b.controlResult.id,
        }));
        // A batch keeps only its own results and remains approved.
        const aResults = [...app.store.results.values()].filter((r) => r.batchId === a.batch.id);
        assert.equal(aResults.length, 2);
        assert.ok(aResults.every((r) => r.tenantId === 'tenant-A' && r.projectId === 'project-A'));
        assert.equal(app.store.batches.get(a.batch.id).status, 'APPROVED');
    });
    test('state-changing entry points enforce scope: batch lifecycle, quality, evidence', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        const bScope = makeScope('B');
        expectForbidden(() => app.batches.markReady({ ...bScope, batchId: a.batch.id }));
        expectForbidden(() => app.results.completeRun({ ...bScope, runId: a.run.id, completedAt: '2026-10-07T00:00:00.000Z', status: 'FAILED' }));
        expectForbidden(() => app.quality.approveBatch({ ...bScope, batchId: a.batch.id, reviewerId: 'intruder' }));
        const evidence = app.evidence.generate({ ...a.scope, requestKey: 'req-A' });
        expectForbidden(() => app.evidence.freeze({ ...bScope, evidenceId: evidence.id }));
    });
    test('audit and outbox records never cross project boundaries', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        buildApprovedProject(app, makeScope('B'));
        const bBatchIds = new Set([...app.store.batches.values()].filter((b) => b.tenantId === 'tenant-B').map((b) => b.id));
        const aAudit = app.store.audit.filter((r) => r.tenantId === 'tenant-A');
        assert.ok(aAudit.length > 0);
        assert.ok(aAudit.every((r) => !bBatchIds.has(r.entityId)));
        const aOutbox = app.store.outbox.filter((m) => m.tenantId === 'tenant-A');
        assert.ok(aOutbox.length > 0);
        assert.ok(aOutbox.every((m) => {
            const payload = JSON.parse(m.payload);
            return payload.batchId === undefined || !bBatchIds.has(payload.batchId);
        }));
        // Every audit/outbox row carries its owning scope.
        assert.ok(app.store.audit.every((r) => r.tenantId && r.projectId));
        assert.ok(app.store.outbox.every((r) => r.tenantId && r.projectId));
        void a;
    });
});

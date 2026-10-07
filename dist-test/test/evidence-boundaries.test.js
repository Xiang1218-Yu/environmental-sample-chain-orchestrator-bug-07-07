import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { buildApprovedProject, makeScope } from './helpers.js';
describe('evidence packages respect project boundaries', () => {
    test('export for project A only contains project A sources despite shared ids', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        const b = buildApprovedProject(app, makeScope('B'));
        const packA = app.evidence.generate({ ...a.scope, requestKey: 'export-1' });
        assert.deepEqual(packA.sourceIds.sampleIds, [a.sample.id]);
        assert.deepEqual(packA.sourceIds.containerIds, [a.container.id]);
        assert.deepEqual(packA.sourceIds.batchIds, [a.batch.id]);
        assert.deepEqual(packA.sourceIds.resultIds.sort(), [a.sampleResult.id, a.controlResult.id].sort());
        assert.ok(!packA.sourceIds.sampleIds.includes(b.sample.id));
        assert.ok(!packA.sourceIds.containerIds.includes(b.container.id));
        assert.ok(!packA.sourceIds.batchIds.includes(b.batch.id));
        assert.ok(!packA.sourceIds.resultIds.includes(b.sampleResult.id));
        // File key namespaces tenant+project; manifest hash is content-derived.
        assert.match(packA.fileKeys[0], /evidence\/tenant-A\/project-A\//);
        assert.equal(packA.status, 'READY');
    });
    test('wrong-project export request cannot read or freeze another project package', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        buildApprovedProject(app, makeScope('B'));
        const packA = app.evidence.generate({ ...a.scope, requestKey: 'export-1' });
        try {
            app.evidence.freeze({ tenantId: 'tenant-B', projectId: 'project-B', evidenceId: packA.id });
            assert.fail('expected scope.forbidden');
        }
        catch (error) {
            assert.equal(error.code, 'scope.forbidden');
        }
        // A can freeze its own package.
        const frozen = app.evidence.freeze({ ...a.scope, evidenceId: packA.id });
        assert.equal(frozen.status, 'FROZEN');
    });
    test('requestKey is scoped per project: same request key in B creates a separate package', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        const b = buildApprovedProject(app, makeScope('B'));
        const packA = app.evidence.generate({ ...a.scope, requestKey: 'same-key' });
        const packB = app.evidence.generate({ ...b.scope, requestKey: 'same-key' });
        assert.notEqual(packA.id, packB.id);
        assert.equal(packA.tenantId, 'tenant-A');
        assert.equal(packB.tenantId, 'tenant-B');
        // Regeneration within the same project stays idempotent.
        assert.equal(app.evidence.generate({ ...a.scope, requestKey: 'same-key' }).id, packA.id);
    });
    test('snapshot version and manifest hash are unaffected by activity in another project', () => {
        const app = new SampleChainApplication();
        const a = buildApprovedProject(app, makeScope('A'));
        const packA1 = app.evidence.generate({ ...a.scope, requestKey: 'export-1' });
        const versionA1 = packA1.snapshotVersion;
        const hashA1 = packA1.manifestHash;
        // Lots of activity in project B (shared ids, fresh audit/outbox streams).
        buildApprovedProject(app, makeScope('B'));
        const packA2 = app.evidence.generate({ ...a.scope, requestKey: 'export-1' });
        assert.equal(packA2.id, packA1.id);
        assert.equal(packA2.snapshotVersion, versionA1);
        assert.equal(packA2.manifestHash, hashA1);
    });
});

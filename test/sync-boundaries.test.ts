import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import type { SyncEnvelope } from '../src/domain/types.js';

function envelope(partial: Partial<SyncEnvelope> & Pick<SyncEnvelope, 'type' | 'payload' | 'payloadHash'>): SyncEnvelope {
  return {
    tenantId: 'tenant-A', projectId: 'project-A', deviceId: 'd1',
    clientSequence: 1, operationId: 'op-1', baseVersion: 1,
    occurredAt: '2026-10-06T08:00:00.000Z',
    ...partial,
  };
}

const samplePayload = (barcode: string) => ({
  collectorId: 'c1', protocolVersion: 'v', medium: 'WATER' as const,
  collectedAt: '2026-10-06T08:00:00.000Z',
  location: { latitude: 1, longitude: 2, siteCode: 'S' },
  preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
  containerBarcode: barcode, sealCode: 'SEAL-1', totalVolumeMl: 100,
});

describe('offline sync project boundaries', () => {
  test('same operation id in different projects applies independently (cross-project sync)', async () => {
    const app = new SampleChainApplication();
    const envA = envelope({
      tenantId: 'tenant-A', projectId: 'project-A',
      type: 'CREATE_SAMPLE', payload: samplePayload('CNT-X'), payloadHash: 'hash-A',
    });
    const envB = envelope({
      tenantId: 'tenant-B', projectId: 'project-B',
      type: 'CREATE_SAMPLE', payload: samplePayload('CNT-X'), payloadHash: 'hash-A',
    });
    const resultA = await app.sync.apply(envA);
    const resultB = await app.sync.apply(envB);
    assert.equal(resultA, 'APPLIED');
    assert.equal(resultB, 'APPLIED');

    // Both containers exist, one per project, sharing the barcode.
    const a = [...app.store.containers.values()].filter((c) => c.tenantId === 'tenant-A');
    const b = [...app.store.containers.values()].filter((c) => c.tenantId === 'tenant-B');
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]!.barcode, b[0]!.barcode);

    // Each project sees the other's replay as its own idempotent duplicate.
    assert.equal(await app.sync.apply(envA), 'DUPLICATE');
    assert.equal(await app.sync.apply(envB), 'DUPLICATE');
  });

  test('same operation id with different payload inside one project is CONFLICT with no side effects', async () => {
    const app = new SampleChainApplication();
    const first = envelope({ type: 'CREATE_SAMPLE', payload: samplePayload('CNT-X'), payloadHash: 'hash-1' });
    assert.equal(await app.sync.apply(first), 'APPLIED');

    const samplesAfterApply = app.store.samples.size;
    const containersAfterApply = app.store.containers.size;
    const auditAfterApply = app.store.audit.length;

    const conflicting = envelope({ type: 'CREATE_SAMPLE', payload: samplePayload('CNT-Y'), payloadHash: 'hash-2' });
    assert.equal(await app.sync.apply(conflicting), 'CONFLICT');

    // No new aggregates, no state change, no extra audit/outbox.
    assert.equal(app.store.samples.size, samplesAfterApply);
    assert.equal(app.store.containers.size, containersAfterApply);
    assert.equal(app.store.audit.length, auditAfterApply);
    const container = [...app.store.containers.values()][0]!;
    assert.equal(container.barcode, 'CNT-X');

    // Conflict is recorded for audit purposes; original APPLIED record intact.
    const records = [...app.store.syncRecords.values()];
    const applied = records.filter((r) => r.result === 'APPLIED');
    const conflicts = records.filter((r) => r.result === 'CONFLICT');
    assert.equal(applied.length, 1);
    assert.ok(conflicts.length >= 1);
    assert.match(conflicts[0]!.conflictReason ?? '', /different payload/);

    // The original operation remains the idempotency anchor: replay -> DUPLICATE.
    assert.equal(await app.sync.apply(first), 'DUPLICATE');
  });

  test('cross-project sync cannot reference another project container via RECEIVE_CONTAINER', async () => {
    const app = new SampleChainApplication();
    // Project A creates a sample (container in HANDED_OVER-ready flow).
    const created = app.sampling.createSealedSample({
      tenantId: 'tenant-A', projectId: 'project-A', collectorId: 'c1',
      protocolVersion: 'v', medium: 'WATER', collectedAt: '2026-10-06T08:00:00.000Z',
      location: { latitude: 1, longitude: 2, siteCode: 'S' },
      preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
      clientDeviceId: 'd1', clientSequence: 1,
      containerBarcode: 'CNT-X', sealCode: 'SEAL-1', totalVolumeMl: 100,
    });
    created.container.custodyStatus = 'HANDED_OVER';

    const rogue = envelope({
      tenantId: 'tenant-B', projectId: 'project-B', operationId: 'op-recv',
      type: 'RECEIVE_CONTAINER', payloadHash: 'h',
      payload: {
        containerId: created.container.id, receivedBy: 'r', receivedAt: '2026-10-06T09:00:00.000Z',
        temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'REJECTED',
      },
    });
    await assert.rejects(app.sync.apply(rogue), (error: { code?: string }) => error.code === 'scope.forbidden');

    // Transaction rolled back: no conflict/applied record committed for the
    // rogue operation and the container was untouched.
    const records = [...app.store.syncRecords.values()].filter((r) => r.envelope.tenantId === 'tenant-B');
    assert.equal(records.length, 0);
    assert.equal(created.container.custodyStatus, 'HANDED_OVER');
    assert.equal(app.store.receiving.size, 0);
  });

  test('missing tenant/project is rejected before any effect', async () => {
    const app = new SampleChainApplication();
    const bad = envelope({
      tenantId: '', projectId: '', type: 'CREATE_SAMPLE',
      payload: samplePayload('CNT-Z'), payloadHash: 'h',
    });
    await assert.rejects(app.sync.apply(bad), (error: { code?: string }) => error.code === 'scope.invalid_tenant');
    assert.equal(app.store.containers.size, 0);
  });
});

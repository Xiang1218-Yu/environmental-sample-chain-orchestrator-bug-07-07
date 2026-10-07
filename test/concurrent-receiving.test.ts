import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { makeScope } from './helpers.js';

describe('concurrent receiving', () => {
  test('parallel duplicate receives with the same client operation id collapse to one record', async () => {
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

    const payload = {
      ...scope, containerId: sealed.container.id, receivedBy: 'r1',
      receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5,
      sealStatus: 'INTACT' as const, decision: 'ACCEPTED' as const,
      clientOperationId: 'recv-concurrent',
    };

    const outcomes = await Promise.all([
      Promise.resolve().then(() => app.receiving.receive({ ...payload })),
      Promise.resolve().then(() => app.receiving.receive({ ...payload })),
      Promise.resolve().then(() => app.receiving.receive({ ...payload })),
    ]);

    // All three calls return the same idempotent record.
    assert.equal(outcomes.length, 3);
    const ids = new Set(outcomes.map((r) => r.id));
    assert.equal(ids.size, 1);
    const records = [...app.store.receiving.values()].filter((r) => r.containerId === sealed.container.id);
    assert.equal(records.length, 1);
    assert.equal(sealed.container.custodyStatus, 'RELEASED_TO_LAB');
  });

  test('concurrent sync receives across projects serialize without cross-confirming', async () => {
    const app = new SampleChainApplication();
    const scopeA = makeScope('A');
    const scopeB = makeScope('B');

    const mk = (scope: typeof scopeA, barcode: string) => {
      const sealed = app.sampling.createSealedSample({
        ...scope, collectorId: 'c1', protocolVersion: 'v', medium: 'WATER',
        collectedAt: '2026-10-06T08:00:00.000Z',
        location: { latitude: 1, longitude: 2, siteCode: barcode },
        preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
        clientDeviceId: 'd-shared', clientSequence: 1,
        containerBarcode: 'CNT-C', sealCode: `SEAL-${barcode}`, totalVolumeMl: 100,
      });
      sealed.container.custodyStatus = 'HANDED_OVER';
      return sealed;
    };
    const a = mk(scopeA, 'A');
    const b = mk(scopeB, 'B');

    // Both projects fire concurrent receive syncs with the SAME client operation id.
    const env = (scope: typeof scopeA, containerId: string) => ({
      ...scope, deviceId: 'd-shared', clientSequence: 2, operationId: 'op-recv-shared',
      baseVersion: 1, occurredAt: '2026-10-06T10:00:00.000Z',
      type: 'RECEIVE_CONTAINER' as const, payloadHash: 'same-hash',
      payload: {
        containerId, receivedBy: 'r', receivedAt: '2026-10-06T10:00:00.000Z',
        temperatureCelsius: 5, sealStatus: 'INTACT' as const, decision: 'ACCEPTED' as const,
      },
    });

    const outcomes = await Promise.all([
      app.sync.apply(env(scopeA, a.container.id)),
      app.sync.apply(env(scopeB, b.container.id)),
      app.sync.apply(env(scopeA, a.container.id)),
      app.sync.apply(env(scopeB, b.container.id)),
    ]);
    assert.deepEqual(outcomes.sort(), ['APPLIED', 'APPLIED', 'DUPLICATE', 'DUPLICATE']);

    // Each container was received by its own project exactly once.
    const aRecs = [...app.store.receiving.values()].filter((r) => r.containerId === a.container.id);
    const bRecs = [...app.store.receiving.values()].filter((r) => r.containerId === b.container.id);
    assert.equal(aRecs.length, 1);
    assert.equal(bRecs.length, 1);
    assert.equal(aRecs[0]!.tenantId, 'tenant-A');
    assert.equal(bRecs[0]!.tenantId, 'tenant-B');
    assert.equal(a.container.custodyStatus, 'RELEASED_TO_LAB');
    assert.equal(b.container.custodyStatus, 'RELEASED_TO_LAB');
  });

  test('concurrent conflicting payloads: first applies, others get conflict and stay side-effect free', async () => {
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
    const base = {
      ...scope, containerId: sealed.container.id, receivedBy: 'r1',
      receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5,
      sealStatus: 'INTACT' as const, clientOperationId: 'recv-conflict',
    };
    const accepted = () => app.receiving.receive({ ...base, decision: 'ACCEPTED' as const });
    const rejected = (): unknown => {
      try {
        return app.receiving.receive({ ...base, decision: 'REJECTED' as const, temperatureCelsius: 9, sealStatus: 'BROKEN' as const });
      } catch (error) {
        return error;
      }
    };

    const outcomes = await Promise.all([
      Promise.resolve().then(accepted),
      Promise.resolve().then(rejected),
      Promise.resolve().then(rejected),
      Promise.resolve().then(accepted),
    ]);
    const isRecord = (o: unknown): o is { id: string } => typeof o === 'object' && o !== null && 'id' in o;
    const isError = (o: unknown): o is { code: string } => typeof o === 'object' && o !== null && 'code' in o;
    const records = outcomes.filter(isRecord);
    const conflicts = outcomes.filter(isError);
    assert.equal(records.length, 2); // first applied + idempotent replay of same payload
    assert.equal(new Set(records.map((r) => r.id)).size, 1);
    assert.equal(conflicts.length, 2);
    assert.ok(conflicts.every((c) => c.code === 'receiving.operation_conflict'));
    assert.equal([...app.store.receiving.values()].length, 1);
    assert.equal(sealed.container.custodyStatus, 'RELEASED_TO_LAB');
    assert.equal(sealed.container.sealStatus, 'INTACT');
  });
});

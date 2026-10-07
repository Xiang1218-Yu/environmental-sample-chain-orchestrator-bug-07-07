import { createHash } from 'node:crypto';
let counter = 0;
function unique(prefix) {
    counter += 1;
    return `${prefix}-${counter}`;
}
/**
 * 走完 采样 -> 交接 -> 接收 -> 分装 -> 批次启动 -> 仪器运行 的链路，
 * 所有操作使用相同的一组自然键（条码/运行号/操作号），供跨项目测试复用。
 */
export async function buildChain(app, tenantId, projectId, keys = {
    barcode: 'SHARED-BARCODE', runId: 'SHARED-RUN', opPrefix: unique('op'), barcodeAlq: 'SHARED-ALQ',
}) {
    const sealed = app.sampling.createSealedSample({
        tenantId,
        projectId,
        collectorId: `collector-${projectId}`,
        protocolVersion: 'v1',
        medium: 'WATER',
        collectedAt: '2026-10-07T08:00:00.000Z',
        location: { latitude: 1, longitude: 1, siteCode: `SITE-${projectId}` },
        preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
        clientDeviceId: `device-${projectId}`,
        clientSequence: 1,
        containerBarcode: keys.barcode,
        sealCode: `SEAL-${projectId}`,
        totalVolumeMl: 100,
    });
    const transfer = app.custody.handOver({
        tenantId, projectId,
        containerId: sealed.container.id,
        fromHolderId: `collector-${projectId}`,
        toHolderId: `courier-${projectId}`,
        fromLocation: `SITE-${projectId}`,
        toLocation: `LAB-${projectId}`,
        handedOverAt: '2026-10-07T09:00:00.000Z',
        temperatureCelsius: 5,
        sealStatus: 'INTACT',
        clientOperationId: `${keys.opPrefix}-handover`,
    });
    app.custody.confirmReceipt({
        tenantId, projectId,
        transferId: transfer.id,
        receiverId: `courier-${projectId}`,
        receivedAt: '2026-10-07T10:00:00.000Z',
        temperatureCelsius: 5,
        sealStatus: 'INTACT',
    });
    app.receiving.receive({
        tenantId, projectId,
        containerId: sealed.container.id,
        receivedBy: `rx-${projectId}`,
        receivedAt: '2026-10-07T10:30:00.000Z',
        temperatureCelsius: 5,
        sealStatus: 'INTACT',
        decision: 'ACCEPTED',
        clientOperationId: `${keys.opPrefix}-receive`,
    });
    const aliquots = app.aliquots.createMany({
        tenantId, projectId,
        parentContainerId: sealed.container.id,
        protocolVersion: 'v1',
        createdBy: `analyst-${projectId}`,
        operationId: `${keys.opPrefix}-aliquot`,
        items: [{ barcode: keys.barcodeAlq, volumeMl: 20, unit: 'ML' }],
    });
    const batch = app.batches.create({
        tenantId, projectId,
        protocolVersion: 'v1',
        instrumentType: 'ICP-MS',
        requiredControls: [],
        createdBy: `analyst-${projectId}`,
    });
    app.batches.addAliquot(batch.id, aliquots[0].id, { tenantId, projectId });
    app.batches.markReady(batch.id, { tenantId, projectId });
    app.batches.start(batch.id, '2026-10-07T11:00:00.000Z', { tenantId, projectId });
    const run = app.results.registerRun({
        tenantId, projectId,
        batchId: batch.id,
        externalRunId: keys.runId,
        rawFileHash: `raw-${projectId}`,
        instrumentSoftwareVersion: 'sw-1',
        startedAt: '2026-10-07T11:10:00.000Z',
    });
    return {
        tenantId, projectId,
        sample: sealed.sample, container: sealed.container,
        transferId: transfer.id, batchId: batch.id,
        aliquotId: aliquots[0].id, runId: run.id,
    };
}
export function envelope(partial) {
    return {
        baseVersion: 1,
        payloadHash: createHash('sha256').update(JSON.stringify(partial.payload)).digest('hex'),
        occurredAt: '2026-10-07T08:00:00.000Z',
        ...partial,
    };
}
export function assertThrows(fn, code) {
    try {
        fn();
    }
    catch (error) {
        if (code && (!(error instanceof Error) || error.code !== code)) {
            throw new Error(`expected error code ${code}, got ${error.message}`);
        }
        return error;
    }
    throw new Error(`expected function to throw${code ? ` ${code}` : ''}`);
}
export async function assertRejects(promise, code) {
    try {
        await promise;
    }
    catch (error) {
        if (code && (!(error instanceof Error) || error.code !== code)) {
            throw new Error(`expected error code ${code}, got ${error.message}`);
        }
        return error;
    }
    throw new Error(`expected promise to reject${code ? ` ${code}` : ''}`);
}
export function countSideEffects(app) {
    return { audit: app.store.audit.length, outbox: app.store.outbox.length };
}

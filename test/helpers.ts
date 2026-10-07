import { SampleChainApplication } from '../src/app.js';
import type { Scope } from '../src/domain/scope.js';
import type { AnalysisBatch, InstrumentRun, ResultRevision, SampleContainer, SamplingRecord } from '../src/domain/types.js';

export interface BuiltProject {
  scope: Scope;
  sample: SamplingRecord;
  container: SampleContainer;
  batch: AnalysisBatch;
  run: InstrumentRun;
  sampleResult: ResultRevision;
  controlResult: ResultRevision;
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/**
 * Builds a full approved-chain fixture for one project so cross-project tests
 * can construct two independent fixtures that reuse the same barcode,
 * external run id and client operation ids.
 */
export function buildApprovedProject(app: SampleChainApplication, scope: Scope, suffix = ''): BuiltProject {
  const barcode = `CNT-SHARED${suffix}`;
  const sealed = app.sampling.createSealedSample({
    ...scope,
    collectorId: `collector${suffix}`,
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: `SITE${suffix}` },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device-shared',
    clientSequence: 1,
    containerBarcode: barcode,
    sealCode: `SEAL${suffix || '-1'}`,
    totalVolumeMl: 100,
  });

  app.custody.handOver({
    ...scope,
    containerId: sealed.container.id,
    fromHolderId: `collector${suffix}`,
    toHolderId: 'courier-shared',
    fromLocation: `SITE${suffix}`,
    toLocation: 'LAB',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: 'op-handover-shared',
  });
  const transfers = [...app.store.transfers.values()].filter((t) => t.containerId === sealed.container.id);
  const transfer = transfers[0]!;
  app.custody.confirmReceipt(transfer.id, {
    ...scope,
    receiverId: 'courier-shared',
    receivedAt: '2026-10-06T10:00:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
  });
  app.receiving.receive({
    ...scope,
    containerId: sealed.container.id,
    receivedBy: 'receiver-shared',
    receivedAt: '2026-10-06T10:15:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    decision: 'ACCEPTED',
    clientOperationId: 'op-receive-shared',
  });

  const aliquots = app.aliquots.createMany({
    ...scope,
    parentContainerId: sealed.container.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst',
    operationId: 'op-aliquot-shared',
    items: [{ barcode: `ALQ${suffix || '-A'}`, volumeMl: 20, unit: 'ML' }],
  });
  const aliquot = aliquots[0]!;

  const batch = app.batches.create({
    ...scope,
    protocolVersion: 'water-v3',
    instrumentType: 'ICP-MS',
    requiredControls: [{ kind: 'BLANK', minimumCount: 1 }],
    createdBy: 'analyst',
  });
  app.batches.addAliquot({ ...scope, batchId: batch.id, aliquotId: aliquot.id });
  app.batches.markReady({ ...scope, batchId: batch.id });
  app.batches.start({ ...scope, batchId: batch.id, startedAt: '2026-10-06T11:00:00.000Z' });

  const run = app.results.registerRun({
    ...scope,
    batchId: batch.id,
    externalRunId: 'RUN-SHARED',
    rawFileHash: `raw-hash${suffix || '-A'}`,
    instrumentSoftwareVersion: 'instrument-7.2',
    startedAt: '2026-10-06T11:10:00.000Z',
  });
  app.results.completeRun({ ...scope, runId: run.id, completedAt: '2026-10-06T12:00:00.000Z', status: 'COMPLETED' });

  const sampleResult = app.results.ingestRevision({
    ...scope,
    batchId: batch.id,
    runId: run.id,
    aliquotId: aliquot.id,
    analyte: 'lead',
    value: 0.12,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [],
    instrumentSoftwareVersion: 'instrument-7.2',
    contentHash: `result-hash${suffix || '-A'}`,
  });
  const controlResult = app.results.ingestRevision({
    ...scope,
    batchId: batch.id,
    runId: run.id,
    controlKind: 'BLANK',
    analyte: 'lead',
    value: 0,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [],
    instrumentSoftwareVersion: 'instrument-7.2',
    contentHash: `control-hash${suffix || '-A'}`,
  });
  app.batches.attachControlResult({ ...scope, batchId: batch.id, resultId: controlResult.id });
  app.quality.decide({
    ...scope,
    batchId: batch.id,
    resultId: sampleResult.id,
    decision: 'APPROVED',
    reason: 'within limits',
    ruleVersion: 'quality-v2',
    reviewerId: 'reviewer',
  });
  app.quality.decide({
    ...scope,
    batchId: batch.id,
    resultId: controlResult.id,
    decision: 'APPROVED',
    reason: 'blank clean',
    ruleVersion: 'quality-v2',
    reviewerId: 'reviewer',
  });
  app.quality.approveBatch({ ...scope, batchId: batch.id, reviewerId: 'reviewer' });

  return { scope, sample: sealed.sample, container: sealed.container, batch, run, sampleResult, controlResult };
}

export function makeScope(name: string): Scope {
  return { tenantId: `tenant-${name}`, projectId: `project-${name}` };
}

export { unique };

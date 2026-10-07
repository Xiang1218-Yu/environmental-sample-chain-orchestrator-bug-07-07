import { SampleChainApplication } from '../app.js';

const app = new SampleChainApplication();
const tenantId = 'tenant_demo';
const projectId = 'project_delta';
const scope = { tenantId, projectId };

const sealed = app.sampling.createSealedSample({
  tenantId,
  projectId,
  collectorId: 'collector_01',
  protocolVersion: 'water-v3',
  medium: 'WATER',
  collectedAt: '2026-10-06T08:00:00.000Z',
  location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
  preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
  clientDeviceId: 'device_01',
  clientSequence: 1,
  containerBarcode: 'CNT-DEMO-001',
  sealCode: 'SEAL-001',
  totalVolumeMl: 100,
});

const transfer = app.custody.handOver({
  tenantId,
  projectId,
  containerId: sealed.container.id,
  fromHolderId: 'collector_01',
  toHolderId: 'courier_01',
  fromLocation: 'SITE-SH-01',
  toLocation: 'LAB-SH-A',
  handedOverAt: '2026-10-06T08:30:00.000Z',
  temperatureCelsius: 5,
  sealStatus: 'INTACT',
  clientOperationId: 'handover-001',
});
app.custody.confirmReceipt(transfer.id, { ...scope, receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_receiver_01', receivedAt: '2026-10-06T10:15:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'receive-001' });

const aliquots = app.aliquots.createMany({ tenantId, projectId, parentContainerId: sealed.container.id, protocolVersion: 'water-v3', createdBy: 'analyst_01', operationId: 'aliquot-001', items: [{ barcode: 'ALQ-001', volumeMl: 20, unit: 'ML' }, { barcode: 'ALQ-002', volumeMl: 20, unit: 'ML' }] });
const batch = app.batches.create({ tenantId, projectId, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', requiredControls: [{ kind: 'BLANK', minimumCount: 1 }], createdBy: 'analyst_01' });
for (const aliquot of aliquots) app.batches.addAliquot({ ...scope, batchId: batch.id, aliquotId: aliquot.id });
app.batches.markReady({ ...scope, batchId: batch.id });
app.batches.start({ ...scope, batchId: batch.id, startedAt: '2026-10-06T11:00:00.000Z' });
const run = app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId: 'RUN-001', rawFileHash: 'raw-hash-001', instrumentSoftwareVersion: 'instrument-7.2', startedAt: '2026-10-06T11:10:00.000Z' });
app.results.completeRun({ ...scope, runId: run.id, completedAt: '2026-10-06T12:00:00.000Z', status: 'COMPLETED' });
const result = app.results.ingestRevision({ tenantId, projectId, batchId: batch.id, runId: run.id, ...(aliquots[0] ? { aliquotId: aliquots[0].id } : {}), analyte: 'lead', value: 0.12, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'instrument-7.2', contentHash: 'result-hash-001' });
app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: result.id, decision: 'APPROVED', reason: 'within protocol limits', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01' });

console.log(JSON.stringify({
  projectId,
  sampleId: sealed.sample.id,
  containerId: sealed.container.id,
  aliquotIds: aliquots.map((item) => item.id),
  batchId: batch.id,
  resultId: result.id,
  auditCount: app.store.audit.length,
  outboxCount: app.store.outbox.length,
}, null, 2));

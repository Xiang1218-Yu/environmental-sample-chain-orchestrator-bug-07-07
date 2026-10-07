import type { SampleContainer, SamplingRecord } from '../domain/types.js';
import { assertCondition, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';
import { assertInScope, assertValidScope, type Scope } from '../domain/scope.js';

export interface CreateSampleInput extends Scope {
  collectorId: string;
  protocolVersion: string;
  medium: SamplingRecord['medium'];
  collectedAt: string;
  location: SamplingRecord['location'];
  preservation: SamplingRecord['preservation'];
  clientDeviceId: string;
  clientSequence: number;
  sampleId?: string;
  containerBarcode: string;
  sealCode: string;
  totalVolumeMl: number;
}

export class SamplingService {
  constructor(private readonly store: Store) {}

  createSealedSample(input: CreateSampleInput): { sample: SamplingRecord; container: SampleContainer } {
    assertValidScope(input);
    this.validateInput(input);

    // Idempotency/dedup is scoped to (tenant, project, device, sequence).
    // The same device/sequence in another project is a different operation.
    const existing = this.store.findScoped(
      this.store.samples.values(),
      (sample) => sample.clientDeviceId === input.clientDeviceId && sample.clientSequence === input.clientSequence,
      input,
    );
    if (existing) {
      // Same project, same device+sequence but a different business payload:
      // this is a genuine conflict, never a silent overwrite.
      const container = this.store.containers.get(existing.containerId ?? '');
      if (this.payloadSignature(input) !== this.existingSignature(existing, container)) {
        throw new DomainError('sample.client_sequence_conflict', 'client sequence was already used in this project with different payload');
      }
      const scopedContainer = assertInScope(container, input, 'sample.container_missing', 'sample container missing');
      return { sample: existing, container: scopedContainer };
    }

    assertCondition(input.totalVolumeMl > 0, 'sample.invalid_volume', 'sample volume must be positive');
    assertCondition(input.preservation.temperatureCelsius >= -80 && input.preservation.temperatureCelsius <= 40, 'sample.invalid_temperature', 'sample preservation temperature is outside supported range');

    // Barcode uniqueness is scoped to the project: the same physical-style
    // barcode value may legally be registered by another project/tenant.
    const barcodeConflict = this.store.findScoped(
      this.store.containers.values(),
      (item) => item.barcode === input.containerBarcode,
      input,
    );
    if (barcodeConflict) throw new DomainError('sample.barcode_conflict', 'container barcode already belongs to another sample in this project');

    // An explicitly supplied sample id must only be unique inside the scope.
    if (input.sampleId !== undefined) {
      const idConflict = this.store.findSample(input.sampleId, input);
      if (idConflict) throw new DomainError('sample.id_conflict', 'sample id already exists in this project');
    }

    const sampleId = input.sampleId ?? this.store.nextId('sample');
    const containerId = this.store.nextId('container');
    const sample: SamplingRecord = {
      id: sampleId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      collectorId: input.collectorId,
      protocolVersion: input.protocolVersion,
      medium: input.medium,
      collectedAt: input.collectedAt,
      location: input.location,
      preservation: input.preservation,
      status: 'SEALED',
      clientDeviceId: input.clientDeviceId,
      clientSequence: input.clientSequence,
      containerId,
      version: 1,
    };
    const container: SampleContainer = {
      id: containerId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      sampleId,
      barcode: input.containerBarcode,
      sealCode: input.sealCode,
      sealStatus: 'INTACT',
      custodyStatus: 'SEALED',
      currentHolderId: input.collectorId,
      currentLocation: input.location.siteCode,
      temperatureLog: [{ recordedAt: input.collectedAt, celsius: input.preservation.temperatureCelsius, source: 'HANDHELD' }],
      availableVolumeMl: input.totalVolumeMl,
      totalVolumeMl: input.totalVolumeMl,
      version: 1,
    };
    this.store.putSample(sample);
    this.store.containers.set(container.id, container);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.sealed', entity: 'sample', entityId: sample.id, metadata: { containerId, protocolVersion: input.protocolVersion } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.sealed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId, protocolVersion: input.protocolVersion }) });
    return { sample, container };
  }

  markDisposed(sampleId: string, scope: Scope, actorId: string): void {
    assertValidScope(scope);
    const sample = assertInScope(this.store.findSample(sampleId, scope), scope, 'sample.not_found', 'sample not found');
    const container = assertInScope(sample.containerId ? this.store.containers.get(sample.containerId) : undefined, scope, 'sample.container_missing', 'sample container missing');
    assertCondition(sample.status === 'RECEIVED' || sample.status === 'ISOLATED' || sample.status === 'CONSUMED', 'sample.invalid_dispose_state', 'sample cannot be disposed from its current state');
    sample.status = 'DISPOSED';
    sample.version += 1;
    container.custodyStatus = 'ISOLATED';
    container.version += 1;
    this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'sample.disposed', entity: 'sample', entityId: sample.id, metadata: { actorId } });
    this.store.addOutbox({ tenantId: scope.tenantId, projectId: scope.projectId, topic: 'sample.disposed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, actorId }) });
  }

  private validateInput(input: CreateSampleInput): void {
    assertCondition(input.containerBarcode.trim().length >= 3, 'sample.invalid_barcode', 'container barcode is too short');
    assertCondition(input.sealCode.trim().length >= 3, 'sample.invalid_seal', 'seal code is too short');
    assertCondition(input.clientDeviceId.trim().length > 0, 'sample.invalid_device', 'client device is required');
    assertCondition(Number.isInteger(input.clientSequence) && input.clientSequence >= 0, 'sample.invalid_sequence', 'client sequence is invalid');
  }

  private payloadSignature(input: CreateSampleInput): string {
    return JSON.stringify([
      input.sampleId ?? null,
      input.collectorId,
      input.protocolVersion,
      input.medium,
      input.collectedAt,
      input.location,
      input.preservation,
      input.containerBarcode,
      input.sealCode,
      input.totalVolumeMl,
    ]);
  }

  private existingSignature(existing: SamplingRecord, container: SampleContainer | undefined): string {
    // Server-generated ids look like sample_00000001; only client-supplied
    // ids participate in the payload comparison for idempotency.
    const clientSampleId = existing.id.startsWith('sample_') ? null : existing.id;
    return JSON.stringify([
      clientSampleId,
      existing.collectorId,
      existing.protocolVersion,
      existing.medium,
      existing.collectedAt,
      existing.location,
      existing.preservation,
      container?.barcode,
      container?.sealCode,
      container?.totalVolumeMl,
    ]);
  }
}

import type { SampleContainer, SamplingRecord } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface CreateSampleInput {
  tenantId: string;
  projectId: string;
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
    this.validateScopedIdentity(input);
    const existing = [...this.store.samples.values()].find((sample) => sample.tenantId === input.tenantId && sample.clientDeviceId === input.clientDeviceId && sample.clientSequence === input.clientSequence);
    if (existing) {
      const container = assertFound(existing.containerId ? this.store.containers.get(existing.containerId) : undefined, 'sample.container_missing', 'sample container missing');
      return { sample: existing, container };
    }
    assertCondition(input.totalVolumeMl > 0, 'sample.invalid_volume', 'sample volume must be positive');
    assertCondition(input.preservation.temperatureCelsius >= -80 && input.preservation.temperatureCelsius <= 40, 'sample.invalid_temperature', 'sample preservation temperature is outside supported range');
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
    // a barcode used in one tenant block or select an unrelated aggregate.
    const barcodeConflict = this.findContainerByScopedBarcode(input.tenantId, input.projectId, input.containerBarcode);
    if (barcodeConflict) throw new DomainError('sample.barcode_conflict', 'container barcode already belongs to another sample in this project');
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
    this.store.samples.set(sample.id, sample);
    this.store.containers.set(container.id, container);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.sealed', entity: 'sample', entityId: sample.id, metadata: { containerId, protocolVersion: input.protocolVersion } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.sealed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId, protocolVersion: input.protocolVersion }) });
    return { sample, container };
  }

  markDisposed(sampleId: string, actorId: string): void {
    const sample = assertFound(this.store.samples.get(sampleId), 'sample.not_found', 'sample not found');
    const container = assertFound(sample.containerId ? this.store.containers.get(sample.containerId) : undefined, 'sample.container_missing', 'sample container missing');
    assertCondition(sample.status === 'RECEIVED' || sample.status === 'ISOLATED' || sample.status === 'CONSUMED', 'sample.invalid_dispose_state', 'sample cannot be disposed from its current state');
    sample.status = 'DISPOSED';
    sample.version += 1;
    container.custodyStatus = 'ISOLATED';
    container.version += 1;
    this.store.addAudit({ tenantId: sample.tenantId, projectId: sample.projectId, action: 'sample.disposed', entity: 'sample', entityId: sample.id, metadata: { actorId } });
    this.store.addOutbox({ tenantId: sample.tenantId, projectId: sample.projectId, topic: 'sample.disposed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, actorId }) });
  }

  private validateScopedIdentity(input: CreateSampleInput): void {
    assertCondition(input.tenantId.trim().length > 0, 'scope.invalid_tenant', 'tenant is required');
    assertCondition(input.projectId.trim().length > 0, 'scope.invalid_project', 'project is required');
    assertCondition(input.containerBarcode.trim().length >= 3, 'sample.invalid_barcode', 'container barcode is too short');
    assertCondition(input.sealCode.trim().length >= 3, 'sample.invalid_seal', 'seal code is too short');
    const tenantProjects = [...this.store.containers.values()]
      .filter((item) => item.tenantId === input.tenantId && item.barcode === input.containerBarcode)
      .map((item) => item.projectId);
    assertCondition(new Set(tenantProjects).size <= 1, 'scope.ambiguous_barcode', 'barcode has ambiguous tenant history');
    assertCondition(input.clientDeviceId.trim().length > 0, 'sample.invalid_device', 'client device is required');
    assertCondition(Number.isInteger(input.clientSequence) && input.clientSequence >= 0, 'sample.invalid_sequence', 'client sequence is invalid');
  }

  private findContainerByScopedBarcode(tenantId: string, projectId: string, barcode: string): SampleContainer | undefined {
    const candidates = [...this.store.containers.values()].filter((item) => item.barcode === barcode);
    const sameProject = candidates.filter((item) => item.projectId === projectId);
    const sameTenant = candidates.filter((item) => item.tenantId === tenantId);
    if (sameProject.length > 0) return sameProject[0];
    if (sameTenant.length > 0 && sameTenant.some((item) => item.projectId !== projectId)) {
      return sameTenant.find((item) => item.projectId !== projectId);
    }
    return candidates[0];
  }
}

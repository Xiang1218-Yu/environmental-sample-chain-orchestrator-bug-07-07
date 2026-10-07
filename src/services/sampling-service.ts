import type { SampleContainer, SamplingRecord } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { type Scope, assertScope, assertValidScope, sameScope } from '../domain/scope.js';
import { Store } from '../store/store.js';

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
    this.validate(input);
    // 设备+序列的幂等键严格限定在 (tenant, project, device) 内；
    // 不同项目的同一台设备、同一序号是互不相关的两条操作。
    const existing = [...this.store.samples.values()].find(
      (sample) => sample.tenantId === input.tenantId && sample.projectId === input.projectId
        && sample.clientDeviceId === input.clientDeviceId && sample.clientSequence === input.clientSequence,
    );
    if (existing) {
      // 同一幂等键再次提交：内容一致才算重放，内容不一致必须进冲突处理，不能静默返回旧样本。
      if (!this.sameSealingPayload(existing, input)) {
        throw new DomainError('sample.client_op_conflict', 'sample client operation was replayed with a different payload');
      }
      const container = assertFound(existing.containerId ? this.store.containers.get(existing.containerId) : undefined, 'sample.container_missing', 'sample container missing');
      assertScope(container, input);
      return { sample: existing, container };
    }
    if (input.sampleId) {
      const colliding = this.store.samples.get(input.sampleId);
      if (colliding) {
        if (sameScope(colliding, input)) {
          throw new DomainError('sample.id_conflict', 'sample id already exists in this project');
        }
        throw new DomainError('sample.id_conflict', 'sample id already exists in another project');
      }
    }
    assertCondition(input.totalVolumeMl > 0, 'sample.invalid_volume', 'sample volume must be positive');
    assertCondition(input.preservation.temperatureCelsius >= -80 && input.preservation.temperatureCelsius <= 40, 'sample.invalid_temperature', 'sample preservation temperature is outside supported range');
    // 容器条码只在同一 (tenant, project) 内唯一；相同条码在其他项目/租户中合法存在。
    if (this.findContainerByBarcode(input.tenantId, input.projectId, input.containerBarcode)) {
      throw new DomainError('sample.barcode_conflict', 'container barcode already belongs to another sample in this project');
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
    this.store.samples.set(sample.id, sample);
    this.store.containers.set(container.id, container);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.sealed', entity: 'sample', entityId: sample.id, metadata: { containerId, protocolVersion: input.protocolVersion } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.sealed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId, protocolVersion: input.protocolVersion }) });
    return { sample, container };
  }

  markDisposed(sampleId: string, scope: Scope, actorId: string): void {
    assertValidScope(scope);
    const sample = assertFound(this.store.samples.get(sampleId), 'sample.not_found', 'sample not found');
    assertScope(sample, scope);
    const container = assertFound(sample.containerId ? this.store.containers.get(sample.containerId) : undefined, 'sample.container_missing', 'sample container missing');
    assertScope(container, scope);
    assertCondition(sample.status === 'RECEIVED' || sample.status === 'ISOLATED' || sample.status === 'CONSUMED', 'sample.invalid_dispose_state', 'sample cannot be disposed from its current state');
    sample.status = 'DISPOSED';
    sample.version += 1;
    container.custodyStatus = 'ISOLATED';
    container.version += 1;
    this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'sample.disposed', entity: 'sample', entityId: sample.id, metadata: { actorId } });
    this.store.addOutbox({ tenantId: scope.tenantId, projectId: scope.projectId, topic: 'sample.disposed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, actorId }) });
  }

  private findContainerByBarcode(tenantId: string, projectId: string, barcode: string): SampleContainer | undefined {
    return [...this.store.containers.values()].find((item) => item.tenantId === tenantId && item.projectId === projectId && item.barcode === barcode);
  }

  private validate(input: CreateSampleInput): void {
    assertCondition(input.containerBarcode.trim().length >= 3, 'sample.invalid_barcode', 'container barcode is too short');
    assertCondition(input.sealCode.trim().length >= 3, 'sample.invalid_seal', 'seal code is too short');
    assertCondition(input.clientDeviceId.trim().length > 0, 'sample.invalid_device', 'client device is required');
    assertCondition(Number.isInteger(input.clientSequence) && input.clientSequence >= 0, 'sample.invalid_sequence', 'client sequence is invalid');
  }

  private sameSealingPayload(sample: SamplingRecord, input: CreateSampleInput): boolean {
    return sample.collectorId === input.collectorId
      && sample.protocolVersion === input.protocolVersion
      && sample.medium === input.medium
      && sample.collectedAt === input.collectedAt
      && sample.location.siteCode === input.location.siteCode
      && sample.location.latitude === input.location.latitude
      && sample.location.longitude === input.location.longitude
      && sample.preservation.temperatureCelsius === input.preservation.temperatureCelsius
      && sample.preservation.method === input.preservation.method
      && sample.preservation.maxTransitHours === input.preservation.maxTransitHours
      && sample.containerId !== undefined
      && this.containerMatches(sample.containerId, input);
  }

  private containerMatches(containerId: string, input: CreateSampleInput): boolean {
    const container = this.store.containers.get(containerId);
    if (!container) return false;
    return container.barcode === input.containerBarcode
      && container.sealCode === input.sealCode
      && container.totalVolumeMl === input.totalVolumeMl;
  }
}

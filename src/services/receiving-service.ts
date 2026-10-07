import type { ReceivingDecision, ReceivingRecord } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { type Scope, assertScope, assertValidScope } from '../domain/scope.js';
import { Store } from '../store/store.js';

export interface ReceiveInput extends Scope {
  containerId: string;
  receivedBy: string;
  receivedAt: string;
  temperatureCelsius: number;
  sealStatus: 'INTACT' | 'BROKEN' | 'MISSING' | 'RESEALED';
  decision: ReceivingDecision;
  reason?: string;
  clientOperationId: string;
}

export class ReceivingService {
  constructor(private readonly store: Store) {}

  receive(input: ReceiveInput): ReceivingRecord {
    assertValidScope(input);
    // 接收操作号只在 (tenant, project) 内幂等；同号不同容器/结论属于冲突。
    const duplicate = [...this.store.receiving.values()].find(
      (item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.clientOperationId === input.clientOperationId,
    );
    if (duplicate) {
      if (!this.sameReceivePayload(duplicate, input)) {
        throw new DomainError('receiving.op_conflict', 'client operation id was submitted with a different receiving payload');
      }
      return duplicate;
    }
    const container = assertFound(this.store.containers.get(input.containerId), 'receiving.container_not_found', 'container not found');
    assertScope(container, input);
    assertCondition(container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'HANDED_OVER', 'receiving.invalid_state', 'container is not ready for receiving');
    const id = this.store.nextId('receiving');
    const record: ReceivingRecord = {
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      decision: input.decision,
      receivedBy: input.receivedBy,
      receivedAt: input.receivedAt,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus: input.sealStatus,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.receiving.set(id, record);
    container.custodyStatus = input.decision === 'ACCEPTED' ? 'RELEASED_TO_LAB' : 'ISOLATED';
    container.sealStatus = input.sealStatus;
    container.version += 1;
    const sample = assertFound(this.store.samples.get(container.sampleId), 'receiving.sample_not_found', 'sample not found');
    assertScope(sample, input);
    sample.status = input.decision === 'ACCEPTED' ? 'RECEIVED' : 'ISOLATED';
    sample.receivedAt = input.receivedAt;
    sample.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.received', entity: 'container', entityId: container.id, metadata: { decision: input.decision, sealStatus: input.sealStatus, receivingId: id } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.received', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, decision: input.decision }) });
    return record;
  }

  private sameReceivePayload(existing: ReceivingRecord, input: ReceiveInput): boolean {
    return existing.containerId === input.containerId
      && existing.decision === input.decision
      && existing.receivedBy === input.receivedBy
      && existing.receivedAt === input.receivedAt
      && existing.temperatureCelsius === input.temperatureCelsius
      && existing.sealStatus === input.sealStatus
      && (existing.reason ?? null) === (input.reason ?? null);
  }
}

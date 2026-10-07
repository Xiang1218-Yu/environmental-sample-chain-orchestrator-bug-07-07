import type { ReceivingDecision } from '../domain/types.js';
import { assertCondition, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';
import { assertInScope, assertValidScope, type Scope } from '../domain/scope.js';

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

  receive(input: ReceiveInput) {
    assertValidScope(input);
    // Authorise the container first: a wrong-project request must never get
    // another project's receiving record back via the idempotency shortcut and
    // must never mutate the container/sample state.
    const container = assertInScope(this.store.containers.get(input.containerId), input, 'receiving.container_not_found', 'container not found');

    const duplicate = this.store.findScoped(
      this.store.receiving.values(),
      (item) => item.clientOperationId === input.clientOperationId,
      input,
    );
    if (duplicate) {
      if (this.signature(input) !== this.duplicateSignature(duplicate)) {
        throw new DomainError('receiving.operation_conflict', 'client operation id was already used in this project with a different payload');
      }
      return duplicate;
    }

    assertCondition(container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'HANDED_OVER', 'receiving.invalid_state', 'container is not ready for receiving');
    const id = this.store.nextId('receiving');
    const record = {
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
    const sample = assertInScope(this.store.findSample(container.sampleId, input), input, 'receiving.sample_not_found', 'sample not found');
    sample.status = input.decision === 'ACCEPTED' ? 'RECEIVED' : 'ISOLATED';
    sample.receivedAt = input.receivedAt;
    sample.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.received', entity: 'container', entityId: container.id, metadata: { decision: input.decision, sealStatus: input.sealStatus, receivingId: id } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.received', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, decision: input.decision }) });
    return record;
  }

  private signature(input: ReceiveInput): string {
    return JSON.stringify([input.containerId, input.receivedBy, input.receivedAt, input.temperatureCelsius, input.sealStatus, input.decision, input.reason ?? null]);
  }

  private duplicateSignature(record: { containerId: string; receivedBy: string; receivedAt: string; temperatureCelsius: number; sealStatus: string; decision: string; reason?: string }): string {
    return JSON.stringify([record.containerId, record.receivedBy, record.receivedAt, record.temperatureCelsius, record.sealStatus, record.decision, record.reason ?? null]);
  }
}

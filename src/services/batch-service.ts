import type { AnalysisBatch, ControlRequirement } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { type Scope, assertScope, assertValidScope } from '../domain/scope.js';
import { Store } from '../store/store.js';
import { AliquotService } from './aliquot-service.js';

export interface CreateBatchInput extends Scope {
  protocolVersion: string;
  instrumentType: string;
  requiredControls: ControlRequirement[];
  createdBy: string;
}

export class BatchService {
  constructor(private readonly store: Store, private readonly aliquots: AliquotService) {}

  create(input: CreateBatchInput): AnalysisBatch {
    assertValidScope(input);
    assertCondition(input.requiredControls.every((control) => control.minimumCount > 0), 'batch.invalid_controls', 'control minimums must be positive');
    const batch: AnalysisBatch = {
      id: this.store.nextId('batch'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      protocolVersion: input.protocolVersion,
      instrumentType: input.instrumentType,
      status: 'DRAFT',
      memberAliquotIds: [],
      requiredControls: structuredClone(input.requiredControls),
      controlResultIds: [],
      createdBy: input.createdBy,
      createdAt: this.store.now(),
      version: 1,
    };
    this.store.batches.set(batch.id, batch);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.created', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: input.protocolVersion } });
    return batch;
  }

  addAliquot(batchId: string, aliquotId: string, scope: Scope): AnalysisBatch {
    assertValidScope(scope);
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertScope(batch, scope);
    const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
    assertScope(aliquot, scope);
    assertCondition(batch.status === 'DRAFT' || batch.status === 'READY', 'batch.members_locked', 'batch members are locked after execution starts');
    if (!batch.memberAliquotIds.includes(aliquotId)) {
      this.aliquots.allocate(aliquotId, batchId, scope);
      batch.memberAliquotIds.push(aliquotId);
      batch.version += 1;
    }
    return batch;
  }

  markReady(batchId: string, scope: Scope): AnalysisBatch {
    assertValidScope(scope);
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertScope(batch, scope);
    assertCondition(batch.status === 'DRAFT' && batch.memberAliquotIds.length > 0, 'batch.not_ready', 'batch needs at least one aliquot before it can be prepared');
    batch.status = 'READY';
    batch.version += 1;
    this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'batch.ready', entity: 'batch', entityId: batch.id, metadata: { memberCount: batch.memberAliquotIds.length } });
    return batch;
  }

  start(batchId: string, startedAt: string, scope: Scope): AnalysisBatch {
    assertValidScope(scope);
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertScope(batch, scope);
    assertCondition(batch.status === 'READY', 'batch.invalid_start', 'only ready batches can start');
    batch.status = 'RUNNING';
    batch.startedAt = startedAt;
    batch.frozenAt = startedAt;
    batch.version += 1;
    for (const aliquotId of batch.memberAliquotIds) {
      const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'batch member aliquot not found');
      assertScope(aliquot, scope);
      assertCondition(aliquot.status === 'ALLOCATED', 'batch.member_not_allocated', 'all batch members must be allocated');
    }
    this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'batch.started', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: batch.protocolVersion } });
    this.store.addOutbox({ tenantId: scope.tenantId, projectId: scope.projectId, topic: 'batch.started', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, version: batch.version }) });
    return batch;
  }

  attachControlResult(batchId: string, resultId: string, scope: Scope): void {
    assertValidScope(scope);
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertScope(batch, scope);
    const result = assertFound(this.store.results.get(resultId), 'result.not_found', 'control result not found');
    assertScope(result, scope);
    assertCondition(result.batchId === batch.id, 'batch.control_result_batch_mismatch', 'control result belongs to a different batch');
    assertCondition(!batch.controlResultIds.includes(resultId), 'batch.duplicate_control', 'control result already attached');
    batch.controlResultIds.push(resultId);
    batch.version += 1;
    this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'batch.control_attached', entity: 'batch', entityId: batch.id, metadata: { resultId } });
  }
}

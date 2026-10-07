import { assertCondition } from '../domain/errors.js';
import { assertInScope, assertValidScope, sameScope } from '../domain/scope.js';
export class BatchService {
    store;
    aliquots;
    constructor(store, aliquots) {
        this.store = store;
        this.aliquots = aliquots;
    }
    create(input) {
        assertValidScope(input);
        assertCondition(input.requiredControls.every((control) => control.minimumCount > 0), 'batch.invalid_controls', 'control minimums must be positive');
        const batch = {
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
    addAliquot(input) {
        assertValidScope(input);
        const batch = assertInScope(this.store.batches.get(input.batchId), input, 'batch.not_found', 'batch not found');
        const aliquot = assertInScope(this.store.aliquots.get(input.aliquotId), input, 'aliquot.not_found', 'aliquot not found');
        // sameScope is guaranteed above; keep an explicit guard for future indexes.
        assertCondition(sameScope(batch, aliquot), 'scope.forbidden', 'batch and aliquot belong to different projects');
        assertCondition(batch.status === 'DRAFT' || batch.status === 'READY', 'batch.members_locked', 'batch members are locked after execution starts');
        if (!batch.memberAliquotIds.includes(input.aliquotId)) {
            this.aliquots.allocate(input.aliquotId, input.batchId);
            batch.memberAliquotIds.push(input.aliquotId);
            batch.version += 1;
        }
        return batch;
    }
    markReady(input) {
        assertValidScope(input);
        const batch = assertInScope(this.store.batches.get(input.batchId), input, 'batch.not_found', 'batch not found');
        assertCondition(batch.status === 'DRAFT' && batch.memberAliquotIds.length > 0, 'batch.not_ready', 'batch needs at least one aliquot before it can be prepared');
        batch.status = 'READY';
        batch.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.ready', entity: 'batch', entityId: batch.id, metadata: { memberCount: batch.memberAliquotIds.length } });
        return batch;
    }
    start(input) {
        assertValidScope(input);
        const batch = assertInScope(this.store.batches.get(input.batchId), input, 'batch.not_found', 'batch not found');
        assertCondition(batch.status === 'READY', 'batch.invalid_start', 'only ready batches can start');
        batch.status = 'RUNNING';
        batch.startedAt = input.startedAt;
        batch.frozenAt = input.startedAt;
        batch.version += 1;
        for (const aliquotId of batch.memberAliquotIds) {
            const aliquot = assertInScope(this.store.aliquots.get(aliquotId), input, 'aliquot.not_found', 'batch member aliquot not found');
            assertCondition(aliquot.status === 'ALLOCATED', 'batch.member_not_allocated', 'all batch members must be allocated');
        }
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.started', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: batch.protocolVersion } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'batch.started', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, version: batch.version }) });
        return batch;
    }
    attachControlResult(input) {
        assertValidScope(input);
        const batch = assertInScope(this.store.batches.get(input.batchId), input, 'batch.not_found', 'batch not found');
        // A control result from another project/tenant can never be attached here.
        const result = assertInScope(this.store.results.get(input.resultId), input, 'quality.result_not_found', 'result not found');
        assertCondition(result.batchId === batch.id, 'batch.control_batch_mismatch', 'control result belongs to a different batch');
        assertCondition(!batch.controlResultIds.includes(input.resultId), 'batch.duplicate_control', 'control result already attached');
        batch.controlResultIds.push(input.resultId);
        batch.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.control_attached', entity: 'batch', entityId: batch.id, metadata: { resultId: input.resultId } });
    }
}

import { assertCondition, DomainError } from '../domain/errors.js';
import { scopedIdKey } from '../domain/scope.js';
export class SyncService {
    store;
    sampling;
    custody;
    receiving;
    aliquots;
    conflictCounts = new Map();
    constructor(store, sampling, custody, receiving, aliquots) {
        this.store = store;
        this.sampling = sampling;
        this.custody = custody;
        this.receiving = receiving;
        this.aliquots = aliquots;
    }
    async apply(envelope) {
        this.validateEnvelope(envelope);
        return this.store.transaction(() => {
            // Dedup key already carries tenant+project+device: the same operation id
            // in another project is an independent operation.
            const key = scopedIdKey({ tenantId: envelope.tenantId, projectId: envelope.projectId }, `${envelope.deviceId}|${envelope.operationId}`);
            const existing = this.store.syncRecords.get(key);
            if (existing) {
                if (existing.envelope.payloadHash !== envelope.payloadHash) {
                    // Same project, same operation, different payload: record the conflict
                    // as a first-class terminal result. No dispatch runs, so there are no
                    // side effects; the original APPLIED record stays untouched.
                    this.recordConflict(key, envelope, 'same operation id was submitted with a different payload');
                    return 'CONFLICT';
                }
                // Identical replay: the operation is already anchored in this scope.
                return 'DUPLICATE';
            }
            const priorSequence = [...this.store.syncRecords.values()]
                .filter((record) => record.envelope.tenantId === envelope.tenantId
                && record.envelope.projectId === envelope.projectId
                && record.envelope.deviceId === envelope.deviceId
                && record.result !== 'CONFLICT')
                .map((record) => record.envelope.clientSequence)
                .sort((a, b) => b - a)[0];
            if (priorSequence !== undefined && envelope.clientSequence < priorSequence - 1000) {
                this.record(key, envelope, 'STALE', undefined, 'client sequence is outside the accepted replay window');
                return 'STALE';
            }
            const resultReference = this.dispatch(envelope);
            this.record(key, envelope, 'APPLIED', resultReference);
            return 'APPLIED';
        });
    }
    validateEnvelope(envelope) {
        assertCondition(typeof envelope.tenantId === 'string' && envelope.tenantId.trim().length > 0, 'scope.invalid_tenant', 'sync envelope must include tenant');
        assertCondition(typeof envelope.projectId === 'string' && envelope.projectId.trim().length > 0, 'scope.invalid_project', 'sync envelope must include project');
        assertCondition(typeof envelope.deviceId === 'string' && envelope.deviceId.trim().length > 0, 'sync.invalid_device', 'sync envelope must include device id');
        assertCondition(typeof envelope.operationId === 'string' && envelope.operationId.trim().length > 0, 'sync.invalid_operation', 'sync envelope must include operation id');
        assertCondition(Number.isInteger(envelope.clientSequence) && envelope.clientSequence >= 0, 'sync.invalid_sequence', 'sync envelope client sequence is invalid');
    }
    dispatch(envelope) {
        switch (envelope.type) {
            case 'CREATE_SAMPLE': {
                const input = envelope.payload;
                const created = this.sampling.createSealedSample({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientDeviceId: envelope.deviceId, clientSequence: envelope.clientSequence });
                return created.sample.id;
            }
            case 'CUSTODY_TRANSFER': {
                const input = envelope.payload;
                return this.custody.handOver({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
            }
            case 'RECEIVE_CONTAINER': {
                const input = envelope.payload;
                return this.receiving.receive({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
            }
            case 'CREATE_ALIQUOT': {
                const input = envelope.payload;
                return this.aliquots.createMany({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, operationId: envelope.operationId }).map((item) => item.id).join(',');
            }
            default:
                throw new DomainError('sync.unknown_type', `unsupported sync envelope type: ${String(envelope.type)}`);
        }
    }
    record(key, envelope, result, resultReference, conflictReason) {
        this.store.syncRecords.set(key, { key, envelope: structuredClone(envelope), result, ...(resultReference === undefined ? {} : { resultReference }), ...(conflictReason === undefined ? {} : { conflictReason }), appliedAt: this.store.now() });
    }
    conflictKey(key) {
        const count = (this.conflictCounts.get(key) ?? 0) + 1;
        this.conflictCounts.set(key, count);
        return `${key}#conflict#${count}`;
    }
    recordConflict(key, envelope, reason) {
        // Keep the conflict envelope itself under a derived key so the applied
        // record for the operation remains the canonical idempotency anchor.
        this.record(this.conflictKey(key), envelope, 'CONFLICT', undefined, reason);
    }
}

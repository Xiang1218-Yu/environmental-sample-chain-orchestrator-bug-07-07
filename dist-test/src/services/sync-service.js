import { assertCondition, DomainError } from '../domain/errors.js';
export class SyncService {
    store;
    sampling;
    custody;
    receiving;
    aliquots;
    constructor(store, sampling, custody, receiving, aliquots) {
        this.store = store;
        this.sampling = sampling;
        this.custody = custody;
        this.receiving = receiving;
        this.aliquots = aliquots;
    }
    async apply(envelope) {
        return this.store.transaction(() => {
            assertCondition(envelope.projectId.trim().length > 0 && envelope.tenantId.trim().length > 0, 'sync.invalid_scope', 'sync envelope must include tenant and project');
            // 去重键包含完整边界 (tenant, project, device, operationId)：
            // 相同操作号在不同项目/租户是互不相关的两条信封。
            const key = this.scopedKey(envelope);
            const existing = this.store.syncRecords.get(key);
            if (existing) {
                if (existing.result === 'REJECTED')
                    return 'REJECTED';
                if (existing.envelope.payloadHash !== envelope.payloadHash) {
                    // 同项目同操作号不同 payload：冲突必须持久化并中止派发，不能回滚丢记录。
                    const reason = 'same operation id was submitted with a different payload';
                    if (!this.hasConflictMarker(key, envelope)) {
                        this.record(this.conflictKey(key), envelope, 'CONFLICT', undefined, reason);
                        this.store.addAudit({ tenantId: envelope.tenantId, projectId: envelope.projectId, action: 'sync.payload_conflict', entity: 'sync_envelope', entityId: envelope.operationId, metadata: { entityId: envelope.entityId, deviceId: envelope.deviceId } });
                    }
                    return 'CONFLICT';
                }
                return existing.result === 'APPLIED' ? 'DUPLICATE' : existing.result;
            }
            const priorSequence = [...this.store.syncRecords.values()]
                .filter((record) => record.result !== 'CONFLICT' && record.result !== 'REJECTED'
                && record.envelope.tenantId === envelope.tenantId
                && record.envelope.projectId === envelope.projectId
                && record.envelope.deviceId === envelope.deviceId)
                .map((record) => record.envelope.clientSequence)
                .sort((a, b) => b - a)[0];
            if (priorSequence !== undefined && envelope.clientSequence < priorSequence - 1000) {
                this.record(key, envelope, 'STALE', undefined, 'client sequence is outside the accepted replay window');
                return 'STALE';
            }
            try {
                const resultReference = this.dispatch(envelope);
                this.record(key, envelope, 'APPLIED', resultReference);
                return 'APPLIED';
            }
            catch (error) {
                // 越权引用其他项目的实体时，底层服务在任何写入前抛 scope.forbidden；
                // 事务会撤销副作用，这里把拒绝结果持久化到主 key，重放稳定返回 REJECTED。
                if (error instanceof DomainError && error.code === 'scope.forbidden') {
                    this.store.addAudit({ tenantId: envelope.tenantId, projectId: envelope.projectId, action: 'sync.scope_rejected', entity: 'sync_envelope', entityId: envelope.operationId, metadata: { entityId: envelope.entityId } });
                    this.record(key, envelope, 'REJECTED', undefined, error.message);
                    return 'REJECTED';
                }
                throw error;
            }
        });
    }
    scopedKey(envelope) {
        return `${envelope.tenantId}|${envelope.projectId}|${envelope.deviceId}|${envelope.operationId}`;
    }
    conflictKey(key) {
        return `${key}#conflict#${this.store.nextId('synccf')}`;
    }
    hasConflictMarker(key, envelope) {
        const prefix = `${key}#conflict#`;
        for (const record of this.store.syncRecords.values()) {
            if (record.key.startsWith(prefix) && record.result === 'CONFLICT' && record.envelope.payloadHash === envelope.payloadHash) {
                return true;
            }
        }
        return false;
    }
    dispatch(envelope) {
        switch (envelope.type) {
            case 'CREATE_SAMPLE': {
                const input = envelope.payload;
                // 边界一律以信封为准，忽略 payload 中夹带的 tenant/project/device 字段。
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
        }
    }
    record(key, envelope, result, resultReference, conflictReason) {
        this.store.syncRecords.set(key, { key, envelope: structuredClone(envelope), result, ...(resultReference === undefined ? {} : { resultReference }), ...(conflictReason === undefined ? {} : { conflictReason }), appliedAt: this.store.now() });
    }
}

import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { assertScope, assertValidScope } from '../domain/scope.js';
export class EvidenceService {
    store;
    constructor(store) {
        this.store = store;
    }
    generate(input) {
        assertValidScope(input);
        const inScope = (items) => {
            const scoped = [];
            for (const item of items)
                if (item.tenantId === input.tenantId && item.projectId === input.projectId)
                    scoped.push(item);
            return scoped;
        };
        const existing = [...this.store.evidence.values()].find((item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.requestKey === input.requestKey);
        if (existing && (existing.status === 'READY' || existing.status === 'FROZEN'))
            return existing;
        const projectSamples = inScope(this.store.samples.values());
        const projectContainers = inScope(this.store.containers.values());
        const projectBatches = inScope(this.store.batches.values()).filter((batch) => input.includeRejected || batch.status === 'APPROVED');
        const batchIds = new Set(projectBatches.map((batch) => batch.id));
        const containerIds = new Set(projectContainers.map((container) => container.id));
        const results = inScope(this.store.results.values()).filter((result) => batchIds.has(result.batchId) && result.status === 'CURRENT');
        const resultIds = new Set(results.map((result) => result.id));
        const quality = inScope(this.store.quality.values()).filter((decision) => resultIds.has(decision.resultId) && batchIds.has(decision.batchId));
        const transfers = inScope(this.store.transfers.values()).filter((transfer) => containerIds.has(transfer.containerId));
        const receiving = inScope(this.store.receiving.values()).filter((record) => containerIds.has(record.containerId));
        assertCondition(projectSamples.length > 0, 'evidence.no_samples', 'project has no samples to export');
        assertCondition(projectBatches.every((batch) => batch.status === 'APPROVED' || input.includeRejected), 'evidence.batch_not_approved', 'all exported batches must be approved');
        const packageId = existing?.id ?? this.store.nextId('evidence');
        // 快照版本只统计本项目的活动，其他项目的写入不能改变本项目证据包的哈希。
        const snapshotVersion = inScope(this.store.audit).length + inScope(this.store.outbox).length
            + projectSamples.length + projectContainers.length + projectBatches.length + results.length
            + quality.length + transfers.length + receiving.length;
        const sourceIds = { sampleIds: projectSamples.map((sample) => sample.id), containerIds: projectContainers.map((container) => container.id), batchIds: projectBatches.map((batch) => batch.id), resultIds: results.map((result) => result.id), qualityDecisionIds: quality.map((decision) => decision.id) };
        const manifest = JSON.stringify({
            tenantId: input.tenantId,
            projectId: input.projectId,
            sourceIds,
            transferIds: transfers.map((transfer) => transfer.id),
            receivingIds: receiving.map((record) => record.id),
            snapshotVersion,
        });
        const manifestHash = stableHash(manifest);
        const fileKey = `evidence/${input.tenantId}/${input.projectId}/${packageId}/${manifestHash}.json`;
        const packageRecord = existing ?? {
            id: packageId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            requestKey: input.requestKey,
            status: 'GENERATING',
            snapshotVersion,
            sourceIds,
            fileKeys: [],
            version: 1,
        };
        packageRecord.status = 'READY';
        packageRecord.snapshotVersion = snapshotVersion;
        packageRecord.sourceIds = sourceIds;
        packageRecord.manifestHash = manifestHash;
        packageRecord.fileKeys = [fileKey];
        packageRecord.version += 1;
        packageRecord.frozenAt = this.store.now();
        this.store.evidence.set(packageRecord.id, packageRecord);
        this.store.files.set(fileKey, { key: fileKey, contentHash: manifestHash, createdAt: this.store.now(), status: 'COMMITTED' });
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'evidence.generated', entity: 'evidence', entityId: packageRecord.id, metadata: { snapshotVersion, sourceCount: results.length } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'evidence.ready', aggregateId: packageRecord.id, payload: JSON.stringify({ evidenceId: packageRecord.id, manifestHash, fileKey }) });
        return packageRecord;
    }
    freeze(evidenceId, scope) {
        assertValidScope(scope);
        const packageRecord = assertFound(this.store.evidence.get(evidenceId), 'evidence.not_found', 'evidence package not found');
        assertScope(packageRecord, scope);
        if (packageRecord.status === 'FROZEN')
            return packageRecord;
        if (packageRecord.status !== 'READY')
            throw new DomainError('evidence.not_ready', 'only ready evidence packages can be frozen');
        packageRecord.status = 'FROZEN';
        packageRecord.version += 1;
        this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'evidence.frozen', entity: 'evidence', entityId: packageRecord.id, metadata: { manifestHash: packageRecord.manifestHash ?? null } });
        return packageRecord;
    }
}
function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

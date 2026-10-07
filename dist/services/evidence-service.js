import { DomainError } from '../domain/errors.js';
import { assertInScope, assertValidScope } from '../domain/scope.js';
export class EvidenceService {
    store;
    constructor(store) {
        this.store = store;
    }
    generate(input) {
        assertValidScope(input);
        const existing = this.store.findScoped(this.store.evidence.values(), (item) => item.requestKey === input.requestKey, input);
        if (existing && (existing.status === 'READY' || existing.status === 'FROZEN'))
            return existing;
        const projectSamples = this.store.inScope(this.store.samples.values(), input);
        const projectContainers = this.store.inScope(this.store.containers.values(), input);
        const projectBatches = this.store.inScope(this.store.batches.values(), input)
            .filter((batch) => input.includeRejected || batch.status === 'APPROVED');
        const batchIds = new Set(projectBatches.map((batch) => batch.id));
        const results = this.store.inScope(this.store.results.values(), input)
            .filter((result) => batchIds.has(result.batchId) && result.status === 'CURRENT');
        const resultIds = new Set(results.map((result) => result.id));
        const quality = this.store.inScope(this.store.quality.values(), input)
            .filter((decision) => resultIds.has(decision.resultId));
        const containerIds = new Set(projectContainers.map((container) => container.id));
        const transfers = this.store.inScope(this.store.transfers.values(), input)
            .filter((transfer) => containerIds.has(transfer.containerId));
        if (projectSamples.length === 0)
            throw new DomainError('evidence.no_samples', 'project has no samples to export');
        if (!input.includeRejected && projectBatches.some((batch) => batch.status !== 'APPROVED')) {
            throw new DomainError('evidence.batch_not_approved', 'all exported batches must be approved');
        }
        const packageId = existing?.id ?? this.store.nextId('evidence');
        // Snapshot versioning counts only this project's own records so activity in
        // another project can never shift the manifest hash of an export.
        const snapshotVersion = this.scopedAuditCount(input) + this.scopedOutboxCount(input)
            + projectSamples.length + results.length + projectBatches.length + projectContainers.length
            + transfers.length + quality.length;
        const sourceIds = { sampleIds: projectSamples.map((sample) => sample.id), containerIds: projectContainers.map((container) => container.id), batchIds: projectBatches.map((batch) => batch.id), resultIds: results.map((result) => result.id), qualityDecisionIds: quality.map((decision) => decision.id) };
        const manifest = JSON.stringify({ tenantId: input.tenantId, projectId: input.projectId, sourceIds, transferIds: transfers.map((transfer) => transfer.id), snapshotVersion });
        const manifestHash = stableHash(manifest);
        const fileKey = `evidence/${encodeURIComponent(input.tenantId)}/${encodeURIComponent(input.projectId)}/${packageId}/${manifestHash}.json`;
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
    freeze(input) {
        assertValidScope(input);
        const packageRecord = assertInScope(this.store.evidence.get(input.evidenceId), input, 'evidence.not_found', 'evidence package not found');
        if (packageRecord.status === 'FROZEN')
            return packageRecord;
        if (packageRecord.status !== 'READY')
            throw new DomainError('evidence.not_ready', 'only ready evidence packages can be frozen');
        packageRecord.status = 'FROZEN';
        packageRecord.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'evidence.frozen', entity: 'evidence', entityId: packageRecord.id, metadata: { manifestHash: packageRecord.manifestHash ?? null } });
        return packageRecord;
    }
    scopedAuditCount(scope) {
        let count = 0;
        for (const record of this.store.audit) {
            if (record.tenantId === scope.tenantId && record.projectId === scope.projectId)
                count += 1;
        }
        return count;
    }
    scopedOutboxCount(scope) {
        let count = 0;
        for (const message of this.store.outbox) {
            if (message.tenantId === scope.tenantId && message.projectId === scope.projectId)
                count += 1;
        }
        return count;
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

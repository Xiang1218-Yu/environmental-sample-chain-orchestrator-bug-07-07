import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { assertInScope, assertValidScope } from '../domain/scope.js';
export class AliquotService {
    store;
    constructor(store) {
        this.store = store;
    }
    createMany(input) {
        assertValidScope(input);
        // Resolve the parent container and enforce the project boundary before the
        // idempotency lookup so another project cannot read this project's aliquots
        // by replaying the same operation id.
        const container = assertInScope(this.store.containers.get(input.parentContainerId), input, 'aliquot.container_not_found', 'parent container not found');
        const prior = this.store.inScope(this.store.aliquots.values(), input).filter((item) => item.sourceOperationId === input.operationId);
        if (prior.length > 0) {
            if (!this.sameAsPrior(input, prior)) {
                throw new DomainError('aliquot.operation_conflict', 'operation id was already used in this project with a different payload');
            }
            return prior;
        }
        assertCondition(container.custodyStatus === 'RELEASED_TO_LAB', 'aliquot.container_not_released', 'container has not been released to the laboratory');
        assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'aliquot.seal_invalid', 'container seal is not acceptable for aliquoting');
        assertCondition(input.items.length > 0, 'aliquot.empty_request', 'at least one aliquot is required');
        const normalized = input.items.map((item) => ({ ...item, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
        const total = normalized.reduce((sum, item) => sum + item.volumeMl, 0);
        assertCondition(total > 0 && total <= container.availableVolumeMl, 'aliquot.insufficient_volume', 'requested aliquot volume exceeds available volume');
        const duplicateBarcode = normalized.find((item, index) => normalized.findIndex((candidate) => candidate.barcode === item.barcode) !== index);
        assertCondition(!duplicateBarcode, 'aliquot.duplicate_barcode', 'aliquot barcodes must be unique within an operation');
        // Barcode uniqueness is scoped per project: another project may reuse it.
        for (const item of normalized) {
            const existing = this.store.findScoped(this.store.aliquots.values(), (aliquot) => aliquot.barcode === item.barcode, input);
            if (existing)
                throw new DomainError('aliquot.barcode_conflict', `aliquot barcode already exists in this project: ${item.barcode}`);
        }
        const created = [];
        for (const item of normalized) {
            const aliquot = {
                id: this.store.nextId('aliquot'),
                tenantId: input.tenantId,
                projectId: input.projectId,
                parentContainerId: input.parentContainerId,
                barcode: item.barcode,
                volumeMl: item.volumeMl,
                unit: 'ML',
                protocolVersion: input.protocolVersion,
                createdBy: input.createdBy,
                createdAt: this.store.now(),
                status: 'AVAILABLE',
                sourceOperationId: input.operationId,
                version: 1,
            };
            this.store.aliquots.set(aliquot.id, aliquot);
            created.push(aliquot);
        }
        container.availableVolumeMl -= total;
        container.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'aliquot.created', entity: 'container', entityId: container.id, metadata: { operationId: input.operationId, count: created.length, volumeMl: total } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'aliquot.created', aggregateId: container.id, payload: JSON.stringify({ operationId: input.operationId, aliquotIds: created.map((item) => item.id), volumeMl: total }) });
        return created;
    }
    /**
     * Internal allocation from BatchService, which has already verified that
     * aliquot and batch share the same scope.
     */
    allocate(aliquotId, batchId) {
        const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
        assertCondition(aliquot.status === 'AVAILABLE', 'aliquot.not_available', 'aliquot is not available');
        aliquot.status = 'ALLOCATED';
        aliquot.version += 1;
        this.store.addAudit({ tenantId: aliquot.tenantId, projectId: aliquot.projectId, action: 'aliquot.allocated', entity: 'aliquot', entityId: aliquot.id, metadata: { batchId } });
        return aliquot;
    }
    toMilliliters(value, unit) {
        assertCondition(Number.isFinite(value) && value > 0, 'aliquot.invalid_volume', 'aliquot volume must be positive');
        if (unit === 'L')
            return value * 1000;
        if (unit === 'G')
            return value;
        return value;
    }
    /**
     * Replayed operation is idempotent only when it targets the same container
     * and reproduces the same aliquots (barcode + normalized ML volume). The
     * stored aliquots record normalized ML volumes, so L/ML rewrites of the same
     * effective volume still match while any content change is a conflict.
     */
    sameAsPrior(input, prior) {
        if (prior.length !== input.items.length)
            return false;
        if (prior.some((item) => item.parentContainerId !== input.parentContainerId || item.protocolVersion !== input.protocolVersion || item.createdBy !== input.createdBy))
            return false;
        const byBarcode = new Map(prior.map((item) => [item.barcode, item]));
        return input.items.every((item) => {
            const stored = byBarcode.get(item.barcode);
            return stored !== undefined && stored.volumeMl === this.toMilliliters(item.volumeMl, item.unit);
        });
    }
}

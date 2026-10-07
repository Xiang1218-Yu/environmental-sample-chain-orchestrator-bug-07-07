import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { assertScope, assertValidScope } from '../domain/scope.js';
export class AliquotService {
    store;
    constructor(store) {
        this.store = store;
    }
    createMany(input) {
        assertValidScope(input);
        // 操作号幂等域为 (tenant, project)。
        const prior = [...this.store.aliquots.values()].filter((item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.sourceOperationId === input.operationId);
        if (prior.length > 0) {
            if (!this.sameOperationPayload(prior, input)) {
                throw new DomainError('aliquot.op_conflict', 'aliquot operation id was submitted with a different container or item set');
            }
            return prior;
        }
        const container = assertFound(this.store.containers.get(input.parentContainerId), 'aliquot.container_not_found', 'parent container not found');
        assertScope(container, input);
        assertCondition(container.custodyStatus === 'RELEASED_TO_LAB', 'aliquot.container_not_released', 'container has not been released to the laboratory');
        assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'aliquot.seal_invalid', 'container seal is not acceptable for aliquoting');
        assertCondition(input.items.length > 0, 'aliquot.empty_request', 'at least one aliquot is required');
        const normalized = input.items.map((item) => ({ ...item, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
        const total = normalized.reduce((sum, item) => sum + item.volumeMl, 0);
        assertCondition(total > 0 && total <= container.availableVolumeMl, 'aliquot.insufficient_volume', 'requested aliquot volume exceeds available volume');
        const duplicateBarcode = normalized.find((item, index) => normalized.findIndex((candidate) => candidate.barcode === item.barcode) !== index);
        assertCondition(!duplicateBarcode, 'aliquot.duplicate_barcode', 'aliquot barcodes must be unique within an operation');
        for (const item of normalized) {
            // 分装条码只要求 (tenant, project) 内唯一；其他项目允许使用相同条码。
            const existing = [...this.store.aliquots.values()].find((aliquot) => aliquot.tenantId === input.tenantId && aliquot.projectId === input.projectId && aliquot.barcode === item.barcode);
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
    allocate(aliquotId, batchId, scope) {
        assertValidScope(scope);
        const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
        assertScope(aliquot, scope);
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        assertScope(batch, scope);
        assertCondition(aliquot.status === 'AVAILABLE', 'aliquot.not_available', 'aliquot is not available');
        aliquot.status = 'ALLOCATED';
        aliquot.version += 1;
        this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'aliquot.allocated', entity: 'aliquot', entityId: aliquot.id, metadata: { batchId } });
        return aliquot;
    }
    sameOperationPayload(prior, input) {
        if (prior.some((item) => item.parentContainerId !== input.parentContainerId || item.protocolVersion !== input.protocolVersion || item.createdBy !== input.createdBy)) {
            return false;
        }
        const expected = input.items.map((item) => `${item.barcode}:${this.toMilliliters(item.volumeMl, item.unit)}`).sort();
        const actual = prior.map((item) => `${item.barcode}:${item.volumeMl}`).sort();
        return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
    }
    toMilliliters(value, unit) {
        assertCondition(Number.isFinite(value) && value > 0, 'aliquot.invalid_volume', 'aliquot volume must be positive');
        if (unit === 'L')
            return value * 1000;
        if (unit === 'G')
            return value;
        return value;
    }
}

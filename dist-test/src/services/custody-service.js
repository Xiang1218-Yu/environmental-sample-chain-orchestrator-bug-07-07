import { assertCondition, DomainError } from '../domain/errors.js';
import { assertInScope, assertValidScope } from '../domain/scope.js';
export class CustodyService {
    store;
    constructor(store) {
        this.store = store;
    }
    handOver(input) {
        assertValidScope(input);
        // Resolve and authorise the aggregate before any idempotency shortcut so a
        // request from another project can never confirm/return this project's
        // transfer or mutate the container.
        const container = assertInScope(this.store.containers.get(input.containerId), input, 'custody.container_not_found', 'container not found');
        const duplicate = this.store.findScoped(this.store.transfers.values(), (item) => item.clientOperationId === input.clientOperationId, input);
        if (duplicate) {
            if (this.handoverSignature(input, container.barcode) !== this.duplicateSignature(duplicate)) {
                throw new DomainError('custody.operation_conflict', 'client operation id was already used in this project with a different payload');
            }
            return duplicate;
        }
        assertCondition(container.currentHolderId === input.fromHolderId, 'custody.holder_mismatch', 'container is held by a different user');
        assertCondition(container.custodyStatus === 'SEALED' || container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'RELEASED_TO_LAB', 'custody.invalid_state', 'container cannot be handed over in its current state');
        const prior = this.store.inScope(this.store.transfers.values(), input)
            .filter((item) => item.containerId === input.containerId)
            .sort((a, b) => b.transferSequence - a.transferSequence)[0];
        const transfer = {
            id: this.store.nextId('transfer'),
            tenantId: input.tenantId,
            projectId: input.projectId,
            containerId: input.containerId,
            transferSequence: (prior?.transferSequence ?? 0) + 1,
            fromHolderId: input.fromHolderId,
            toHolderId: input.toHolderId,
            fromLocation: input.fromLocation,
            toLocation: input.toLocation,
            handedOverAt: input.handedOverAt,
            temperatureCelsius: input.temperatureCelsius,
            sealStatus: input.sealStatus,
            status: input.sealStatus === 'INTACT' ? 'PENDING_RECEIPT' : 'ISOLATED',
            clientOperationId: input.clientOperationId,
            version: 1,
        };
        this.store.transfers.set(transfer.id, transfer);
        container.currentHolderId = input.toHolderId;
        container.currentLocation = input.toLocation;
        container.custodyStatus = transfer.status === 'ISOLATED' ? 'ISOLATED' : 'HANDED_OVER';
        container.sealStatus = input.sealStatus;
        container.temperatureLog.push({ recordedAt: input.handedOverAt, celsius: input.temperatureCelsius, source: 'HANDHELD' });
        container.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'custody.handed_over', entity: 'container', entityId: container.id, metadata: { transferId: transfer.id, sequence: transfer.transferSequence, sealStatus: input.sealStatus } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'custody.handed-over', aggregateId: container.id, payload: JSON.stringify({ transferId: transfer.id, transferSequence: transfer.transferSequence, containerId: container.id }) });
        return transfer;
    }
    confirmReceipt(transferId, input) {
        assertValidScope(input);
        const transfer = assertInScope(this.store.transfers.get(transferId), input, 'custody.transfer_not_found', 'transfer not found');
        const container = assertInScope(this.store.containers.get(transfer.containerId), input, 'custody.container_not_found', 'container not found');
        if (transfer.status === 'CONFIRMED' || transfer.status === 'ISOLATED')
            return transfer;
        assertCondition(transfer.status === 'PENDING_RECEIPT', 'custody.not_pending', 'transfer is not pending receipt');
        assertCondition(transfer.toHolderId === input.receiverId, 'custody.receiver_mismatch', 'receiver does not match the transfer');
        transfer.receivedAt = input.receivedAt;
        transfer.sealStatus = input.sealStatus;
        transfer.status = input.sealStatus === 'INTACT' ? 'CONFIRMED' : 'ISOLATED';
        transfer.version += 1;
        container.custodyStatus = transfer.status === 'CONFIRMED' ? 'RECEIVED' : 'ISOLATED';
        container.sealStatus = input.sealStatus;
        container.temperatureLog.push({ recordedAt: input.receivedAt, celsius: input.temperatureCelsius, source: 'LAB_RECEIPT' });
        container.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'custody.received', entity: 'transfer', entityId: transfer.id, metadata: { sequence: transfer.transferSequence, sealStatus: input.sealStatus } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'custody.received', aggregateId: container.id, payload: JSON.stringify({ transferId, containerId: container.id, status: transfer.status }) });
        return transfer;
    }
    handoverSignature(input, barcode) {
        return JSON.stringify([input.containerId, barcode, input.fromHolderId, input.toHolderId, input.fromLocation, input.toLocation, input.handedOverAt, input.temperatureCelsius, input.sealStatus]);
    }
    duplicateSignature(transfer) {
        const container = this.store.containers.get(transfer.containerId);
        return JSON.stringify([transfer.containerId, container?.barcode, transfer.fromHolderId, transfer.toHolderId, transfer.fromLocation, transfer.toLocation, transfer.handedOverAt, transfer.temperatureCelsius, transfer.sealStatus]);
    }
}

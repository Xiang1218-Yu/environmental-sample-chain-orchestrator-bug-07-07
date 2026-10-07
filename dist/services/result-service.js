import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { assertScope, assertValidScope } from '../domain/scope.js';
export class ResultService {
    store;
    constructor(store) {
        this.store = store;
    }
    registerRun(input) {
        assertValidScope(input);
        // 先解析并鉴权批次，再做外部运行号幂等查询，避免越权探测他项目的运行。
        const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
        assertScope(batch, input);
        assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING', 'result.batch_not_running', 'batch is not accepting instrument runs');
        // 外部运行号只在 (tenant, project) 内幂等；两个项目可合法使用同一个号。
        const existing = [...this.store.runs.values()].find((run) => run.tenantId === input.tenantId && run.projectId === input.projectId && run.externalRunId === input.externalRunId);
        if (existing) {
            // 同运行号不同内容属于冲突，不能静默返回旧 run。
            if (existing.rawFileHash !== input.rawFileHash
                || existing.batchId !== input.batchId
                || existing.instrumentSoftwareVersion !== input.instrumentSoftwareVersion) {
                throw new DomainError('result.run_conflict', 'external run id was submitted with a different batch, raw file or instrument software');
            }
            return existing;
        }
        const run = {
            id: this.store.nextId('run'),
            tenantId: input.tenantId,
            projectId: input.projectId,
            batchId: input.batchId,
            externalRunId: input.externalRunId,
            rawFileHash: input.rawFileHash,
            instrumentSoftwareVersion: input.instrumentSoftwareVersion,
            startedAt: input.startedAt,
            status: 'REGISTERED',
            version: 1,
        };
        this.store.runs.set(run.id, run);
        batch.status = 'RESULTS_PENDING';
        batch.version += 1;
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'instrument.run_registered', entity: 'run', entityId: run.id, metadata: { batchId: batch.id, externalRunId: input.externalRunId } });
        return run;
    }
    completeRun(runId, completedAt, status, scope) {
        assertValidScope(scope);
        const run = assertFound(this.store.runs.get(runId), 'result.run_not_found', 'instrument run not found');
        assertScope(run, scope);
        assertCondition(run.status === 'REGISTERED' || run.status === 'RUNNING', 'result.run_closed', 'instrument run is already closed');
        run.status = status;
        run.completedAt = completedAt;
        run.version += 1;
        this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'instrument.run_completed', entity: 'run', entityId: run.id, metadata: { status } });
        return run;
    }
    ingestRevision(input) {
        assertValidScope(input);
        const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
        assertScope(batch, input);
        const run = assertFound(this.store.runs.get(input.runId), 'result.run_not_found', 'instrument run not found');
        assertScope(run, input);
        assertCondition(run.batchId === batch.id, 'scope.forbidden', 'run does not belong to the requested batch');
        if (input.aliquotId) {
            const aliquot = assertFound(this.store.aliquots.get(input.aliquotId), 'aliquot.not_found', 'aliquot not found');
            assertScope(aliquot, input);
            assertCondition(batch.memberAliquotIds.includes(aliquot.id), 'result.aliquot_not_in_batch', 'aliquot is not a member of the target batch');
        }
        const current = this.findCurrent(input);
        if (current) {
            if (current.contentHash === input.contentHash)
                return current;
            const next = this.findNextRevision(input, current);
            return this.createRevision(input, next, current.id);
        }
        return this.createRevision(input, 1);
    }
    createRevision(input, revisionNumber, supersedesRevisionId) {
        const result = {
            id: this.store.nextId('result'),
            tenantId: input.tenantId,
            projectId: input.projectId,
            batchId: input.batchId,
            runId: input.runId,
            ...(input.aliquotId === undefined ? {} : { aliquotId: input.aliquotId }),
            ...(input.controlKind === undefined ? {} : { controlKind: input.controlKind }),
            analyte: input.analyte,
            value: input.value,
            unit: input.unit,
            detectionLimit: input.detectionLimit,
            qualityFlags: [...input.qualityFlags],
            instrumentSoftwareVersion: input.instrumentSoftwareVersion,
            contentHash: input.contentHash,
            revisionNumber,
            ...(supersedesRevisionId === undefined ? {} : { supersedesRevisionId }),
            status: 'CURRENT',
            createdAt: this.store.now(),
            version: 1,
        };
        if (supersedesRevisionId) {
            const prior = assertFound(this.store.results.get(supersedesRevisionId), 'result.previous_missing', 'previous result revision not found');
            assertScope(prior, input);
            prior.status = 'SUPERSEDED';
            prior.version += 1;
        }
        this.store.results.set(result.id, result);
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.revision_created', entity: 'result', entityId: result.id, metadata: { batchId: input.batchId, revisionNumber, analyte: input.analyte } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'result.revision-created', aggregateId: result.id, payload: JSON.stringify({ resultId: result.id, batchId: input.batchId, revisionNumber }) });
        return result;
    }
    findCurrent(input) {
        return [...this.store.results.values()]
            .filter((result) => result.tenantId === input.tenantId && result.projectId === input.projectId
            && result.batchId === input.batchId && result.analyte === input.analyte
            && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind && result.status === 'CURRENT')
            .sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
    }
    findNextRevision(input, current) {
        const revisions = [...this.store.results.values()]
            .filter((result) => result.tenantId === input.tenantId && result.projectId === input.projectId
            && result.batchId === input.batchId && result.analyte === input.analyte
            && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind)
            .map((result) => result.revisionNumber + 1);
        return Math.max(current.revisionNumber + 1, ...revisions);
    }
}

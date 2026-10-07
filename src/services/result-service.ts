import type { InstrumentRun, ResultRevision } from '../domain/types.js';
import { assertCondition } from '../domain/errors.js';
import { Store } from '../store/store.js';
import { assertInScope, assertValidScope, sameScope, type Scope } from '../domain/scope.js';

export interface RegisterRunInput extends Scope {
  batchId: string;
  externalRunId: string;
  rawFileHash: string;
  instrumentSoftwareVersion: string;
  startedAt: string;
}

export interface CompleteRunInput extends Scope {
  runId: string;
  completedAt: string;
  status: 'COMPLETED' | 'FAILED';
}

export interface ResultInput extends Scope {
  batchId: string;
  runId: string;
  aliquotId?: string;
  controlKind?: 'BLANK' | 'CALIBRATION' | 'POSITIVE_CONTROL' | 'NEGATIVE_CONTROL';
  analyte: string;
  value: number;
  unit: string;
  detectionLimit: number;
  qualityFlags: string[];
  instrumentSoftwareVersion: string;
  contentHash: string;
}

export class ResultService {
  constructor(private readonly store: Store) {}

  registerRun(input: RegisterRunInput): InstrumentRun {
    assertValidScope(input);
    // External run ids are unique only within (tenant, project): the same run
    // id may legitimately appear in another project. Resolve the batch first so
    // a wrong-scope request can never attach its run to this project's batch.
    const batch = assertInScope(this.store.batches.get(input.batchId), input, 'batch.not_found', 'batch not found');

    const existing = this.store.findScoped(
      this.store.runs.values(),
      (run) => run.externalRunId === input.externalRunId,
      input,
    );
    if (existing) {
      // Same project + same external run id but a different raw file is a
      // conflict; identical raw file is an idempotent replay.
      assertCondition(existing.rawFileHash === input.rawFileHash, 'result.run_conflict', 'external run id has a different raw file');
      return existing;
    }

    assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING', 'result.batch_not_running', 'batch is not accepting instrument runs');
    const run: InstrumentRun = { id: this.store.nextId('run'), tenantId: input.tenantId, projectId: input.projectId, batchId: input.batchId, externalRunId: input.externalRunId, rawFileHash: input.rawFileHash, instrumentSoftwareVersion: input.instrumentSoftwareVersion, startedAt: input.startedAt, status: 'REGISTERED', version: 1 };
    this.store.runs.set(run.id, run);
    batch.status = 'RESULTS_PENDING';
    batch.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'instrument.run_registered', entity: 'run', entityId: run.id, metadata: { batchId: batch.id, externalRunId: input.externalRunId } });
    return run;
  }

  completeRun(input: CompleteRunInput): InstrumentRun {
    assertValidScope(input);
    const run = assertInScope(this.store.runs.get(input.runId), input, 'result.run_not_found', 'instrument run not found');
    assertCondition(run.status === 'REGISTERED' || run.status === 'RUNNING', 'result.run_closed', 'instrument run is already closed');
    run.status = input.status;
    run.completedAt = input.completedAt;
    run.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'instrument.run_completed', entity: 'run', entityId: run.id, metadata: { status: input.status } });
    return run;
  }

  ingestRevision(input: ResultInput): ResultRevision {
    assertValidScope(input);
    const run = assertInScope(this.store.runs.get(input.runId), input, 'result.run_not_found', 'instrument run not found');
    const batch = assertInScope(this.store.batches.get(input.batchId), input, 'batch.not_found', 'batch not found');
    assertCondition(run.batchId === batch.id && sameScope(run, batch), 'scope.forbidden', 'result does not belong to the requested batch');
    if (input.aliquotId !== undefined) {
      const aliquot = assertInScope(this.store.aliquots.get(input.aliquotId), input, 'aliquot.not_found', 'aliquot not found');
      assertCondition(batch.memberAliquotIds.includes(aliquot.id), 'result.aliquot_not_in_batch', 'aliquot is not a member of the target batch');
    }
    const current = this.findCurrent(input);
    if (current) {
      if (current.contentHash === input.contentHash) return current;
      const next = this.findNextRevision(input, current);
      return this.createRevision(input, next, current.id);
    }
    return this.createRevision(input, 1);
  }

  private createRevision(input: ResultInput, revisionNumber: number, supersedesRevisionId?: string): ResultRevision {
    const result: ResultRevision = {
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
      const prior = assertInScope(this.store.results.get(supersedesRevisionId), input, 'result.previous_missing', 'previous result revision not found');
      prior.status = 'SUPERSEDED';
      prior.version += 1;
    }
    this.store.results.set(result.id, result);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.revision_created', entity: 'result', entityId: result.id, metadata: { batchId: input.batchId, revisionNumber, analyte: input.analyte } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'result.revision-created', aggregateId: result.id, payload: JSON.stringify({ resultId: result.id, batchId: input.batchId, revisionNumber }) });
    return result;
  }

  private findCurrent(input: ResultInput): ResultRevision | undefined {
    return this.store.inScope(this.store.results.values(), input)
      .filter((result) => result.batchId === input.batchId && result.analyte === input.analyte && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind && result.status === 'CURRENT')
      .sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
  }

  private findNextRevision(input: ResultInput, current: ResultRevision): number {
    return Math.max(current.revisionNumber + 1, ...this.store.inScope(this.store.results.values(), input)
      .filter((result) => result.batchId === input.batchId && result.analyte === input.analyte && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind)
      .map((result) => result.revisionNumber + 1));
  }
}

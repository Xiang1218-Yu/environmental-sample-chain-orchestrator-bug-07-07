import type { QualityDecision, QualityDecisionType } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { type Scope, assertScope, assertValidScope } from '../domain/scope.js';
import { Store } from '../store/store.js';

export interface QualityDecisionInput extends Scope {
  batchId: string;
  resultId: string;
  decision: QualityDecisionType;
  reason: string;
  ruleVersion: string;
  reviewerId: string;
}

export class QualityService {
  constructor(private readonly store: Store) {}

  decide(input: QualityDecisionInput): QualityDecision {
    assertValidScope(input);
    const result = assertFound(this.store.results.get(input.resultId), 'quality.result_not_found', 'result not found');
    assertScope(result, input);
    const batch = assertFound(this.store.batches.get(input.batchId), 'quality.batch_not_found', 'batch not found');
    assertScope(batch, input);
    assertCondition(result.batchId === batch.id, 'scope.forbidden', 'result does not belong to the requested batch');
    assertCondition(result.status === 'CURRENT', 'quality.result_not_current', 'only the current result revision can be reviewed');
    const previous = [...this.store.quality.values()].find(
      (decision) => decision.tenantId === input.tenantId && decision.projectId === input.projectId
        && decision.resultId === result.id && decision.decision === input.decision && decision.ruleVersion === input.ruleVersion,
    );
    if (previous) {
      if (previous.reason !== input.reason || previous.reviewerId !== input.reviewerId) {
        throw new DomainError('quality.decision_conflict', 'quality decision was resubmitted with a different reason or reviewer');
      }
      return previous;
    }
    const decision: QualityDecision = {
      id: this.store.nextId('quality'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      batchId: input.batchId,
      resultId: input.resultId,
      decision: input.decision,
      reason: input.reason,
      ruleVersion: input.ruleVersion,
      reviewerId: input.reviewerId,
      decidedAt: this.store.now(),
      version: 1,
    };
    this.store.quality.set(decision.id, decision);
    if (input.decision === 'RETEST_REQUIRED' || input.decision === 'REJECTED') {
      batch.status = 'REJECTED';
      batch.version += 1;
    }
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: `quality.${input.decision.toLowerCase()}`, entity: 'result', entityId: result.id, metadata: { batchId: batch.id, ruleVersion: input.ruleVersion, reviewerId: input.reviewerId } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'quality.decision-recorded', aggregateId: result.id, payload: JSON.stringify({ decisionId: decision.id, resultId: result.id, decision: input.decision }) });
    return decision;
  }

  approveBatch(batchId: string, reviewerId: string, scope: Scope): void {
    assertValidScope(scope);
    const batch = assertFound(this.store.batches.get(batchId), 'quality.batch_not_found', 'batch not found');
    assertScope(batch, scope);
    assertCondition(batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'quality.batch_not_reviewable', 'batch is not ready for approval');
    const currentResults = [...this.store.results.values()].filter((result) => result.tenantId === scope.tenantId && result.projectId === scope.projectId && result.batchId === batch.id && result.status === 'CURRENT');
    assertCondition(currentResults.length > 0, 'quality.no_results', 'batch has no current results');
    const controlKinds = new Map<string, number>();
    for (const result of currentResults) {
      if (result.controlKind) controlKinds.set(result.controlKind, (controlKinds.get(result.controlKind) ?? 0) + 1);
    }
    for (const requirement of batch.requiredControls) {
      assertCondition((controlKinds.get(requirement.kind) ?? 0) >= requirement.minimumCount, 'quality.control_missing', `missing control: ${requirement.kind}`);
    }
    for (const result of currentResults) {
      const decisions = [...this.store.quality.values()].filter((decision) => decision.tenantId === scope.tenantId && decision.projectId === scope.projectId && decision.resultId === result.id && decision.decision === 'APPROVED');
      assertCondition(decisions.length > 0, 'quality.result_unapproved', `result ${result.id} has not been approved`);
    }
    batch.status = 'APPROVED';
    batch.approvedAt = this.store.now();
    batch.version += 1;
    this.store.addAudit({ tenantId: scope.tenantId, projectId: scope.projectId, action: 'batch.approved', entity: 'batch', entityId: batch.id, metadata: { reviewerId, resultCount: currentResults.length } });
    this.store.addOutbox({ tenantId: scope.tenantId, projectId: scope.projectId, topic: 'batch.approved', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, reviewerId }) });
  }
}

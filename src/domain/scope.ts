import type { ProjectId, TenantId } from './types.js';
import { assertCondition, assertFound } from './errors.js';

/**
 * Every aggregate belongs to exactly one (tenantId, projectId) scope.
 * Identifiers that clients control (container barcodes, external run ids,
 * client operation ids, client device sequences) are only unique *within*
 * a scope and may legitimately be reused by other projects/tenants.
 */
export interface Scope {
  tenantId: TenantId;
  projectId: ProjectId;
}

export interface Scoped {
  tenantId: TenantId;
  projectId: ProjectId;
}

/** Composite key used by any index that must not leak across tenants/projects. */
export function scopeKey(scope: Scope): string {
  return `${scope.tenantId} ${scope.projectId}`;
}

/** Compound key for identifiers whose uniqueness is scoped to a project. */
export function scopedIdKey(scope: Scope, id: string): string {
  return `${scopeKey(scope)} ${id}`;
}

export function sameScope(actual: Scoped, expected: Scope): boolean {
  return actual.tenantId === expected.tenantId && actual.projectId === expected.projectId;
}

/**
 * Authorisation boundary. A missing aggregate keeps its own "not found" code,
 * while an aggregate that exists outside the caller's scope always fails with
 * `scope.forbidden` and must never be returned or mutated.
 */
export function assertInScope<T extends Scoped>(value: T | undefined, scope: Scope, notFoundCode: string, notFoundMessage: string): T {
  const found = assertFound(value, notFoundCode, notFoundMessage);
  assertCondition(sameScope(found, scope), 'scope.forbidden', 'object does not belong to the requested tenant/project');
  return found;
}

/** Validate scope arguments themselves before any lookup is performed. */
export function assertValidScope(scope: Scope): void {
  assertCondition(scope.tenantId.trim().length > 0, 'scope.invalid_tenant', 'tenant is required');
  assertCondition(scope.projectId.trim().length > 0, 'scope.invalid_project', 'project is required');
}

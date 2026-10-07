import { assertCondition, assertFound } from './errors.js';
/** Composite key used by any index that must not leak across tenants/projects. */
export function scopeKey(scope) {
    return `${scope.tenantId} ${scope.projectId}`;
}
/** Compound key for identifiers whose uniqueness is scoped to a project. */
export function scopedIdKey(scope, id) {
    return `${scopeKey(scope)} ${id}`;
}
export function sameScope(actual, expected) {
    return actual.tenantId === expected.tenantId && actual.projectId === expected.projectId;
}
/**
 * Authorisation boundary. A missing aggregate keeps its own "not found" code,
 * while an aggregate that exists outside the caller's scope always fails with
 * `scope.forbidden` and must never be returned or mutated.
 */
export function assertInScope(value, scope, notFoundCode, notFoundMessage) {
    const found = assertFound(value, notFoundCode, notFoundMessage);
    assertCondition(sameScope(found, scope), 'scope.forbidden', 'object does not belong to the requested tenant/project');
    return found;
}
/** Validate scope arguments themselves before any lookup is performed. */
export function assertValidScope(scope) {
    assertCondition(scope.tenantId.trim().length > 0, 'scope.invalid_tenant', 'tenant is required');
    assertCondition(scope.projectId.trim().length > 0, 'scope.invalid_project', 'project is required');
}

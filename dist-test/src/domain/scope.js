import { assertCondition } from './errors.js';
export function assertValidScope(scope) {
    assertCondition(typeof scope.tenantId === 'string' && scope.tenantId.trim().length > 0, 'scope.invalid_tenant', 'tenant is required');
    assertCondition(typeof scope.projectId === 'string' && scope.projectId.trim().length > 0, 'scope.invalid_project', 'project is required');
}
export function sameScope(actual, expected) {
    return actual.tenantId === expected.tenantId && actual.projectId === expected.projectId;
}
export function assertScope(actual, expected) {
    assertCondition(sameScope(actual, expected), 'scope.forbidden', 'object does not belong to the requested tenant or project');
}

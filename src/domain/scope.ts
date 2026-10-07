import type { ProjectId, TenantId } from './types.js';
import { assertCondition } from './errors.js';

/**
 * 所有领域对象和请求的硬边界：(tenantId, projectId)。
 * 条码、外部运行号、客户端操作号等自然键只在该作用域内唯一或幂等，
 * 跨作用域同名是合法的，不允许互相解析、去重或产生副作用。
 */
export interface Scope {
  tenantId: TenantId;
  projectId: ProjectId;
}

export function assertValidScope(scope: Scope): void {
  assertCondition(typeof scope.tenantId === 'string' && scope.tenantId.trim().length > 0, 'scope.invalid_tenant', 'tenant is required');
  assertCondition(typeof scope.projectId === 'string' && scope.projectId.trim().length > 0, 'scope.invalid_project', 'project is required');
}

export function sameScope(actual: Scope, expected: Scope): boolean {
  return actual.tenantId === expected.tenantId && actual.projectId === expected.projectId;
}

export function assertScope(actual: Scope, expected: Scope): void {
  assertCondition(sameScope(actual, expected), 'scope.forbidden', 'object does not belong to the requested tenant or project');
}

import type { Role } from '@dayson/domain';

/**
 * Roles that may record dealer stock observations and consignment sales
 * (rpc_floor dealer_observation / consignment_consume require these roles).
 */
export const DEALER_SCREEN_ROLES: readonly Role[] = ['sales_rep', 'ops_manager', 'owner'];

export function canUseDealerScreen(role: Role | null | undefined): boolean {
  return !!role && DEALER_SCREEN_ROLES.includes(role);
}

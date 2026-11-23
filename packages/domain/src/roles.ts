/**
 * Roles (spec section 12.1) and the screens each role sees.
 * The database enforces access (RLS + permission table); the UI only hides
 * what the database would refuse.
 */

export const ROLES = [
  'owner',
  'ops_manager',
  'operator',
  'qc',
  'planner',
  'sales_rep',
  'finance',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Back-office sections, in sidebar order. */
export const OFFICE_SCREENS = [
  'dashboard',
  'stock',
  'orders',
  'shipping',
  'supply',
  'planning',
  'campaigns',
  'dealers',
  'reconciliation',
  'approvals',
  'alerts',
  'masters',
  'audit',
] as const;
export type OfficeScreen = (typeof OFFICE_SCREENS)[number];

/** The nine floor screens of section 5.1, in home-tile order. */
export const FLOOR_SCREENS = [
  'tasks',
  'receive',
  'qc',
  'putaway',
  'pick',
  'load',
  'count',
  'transfer',
  'query',
] as const;
export type FloorScreen = (typeof FLOOR_SCREENS)[number];

export type Screen = `office.${OfficeScreen}` | `floor.${FloorScreen}`;

const office = (...s: OfficeScreen[]): Screen[] => s.map((x) => `office.${x}` as const);
const floor = (...s: FloorScreen[]): Screen[] => s.map((x) => `floor.${x}` as const);

const ALL_OFFICE = office(...OFFICE_SCREENS);
const ALL_FLOOR = floor(...FLOOR_SCREENS);

export const ROLE_SCREENS: Record<Role, readonly Screen[]> = {
  // Everything, including parameter publish and role assignment.
  owner: [...ALL_OFFICE, ...ALL_FLOOR],
  // Approves adjustments, weight overrides, scrap; manages locations and tasks.
  ops_manager: [...ALL_OFFICE, ...ALL_FLOOR],
  // Receive, put away, pick, load, count through the floor app.
  operator: floor('tasks', 'receive', 'putaway', 'pick', 'load', 'count', 'transfer', 'query'),
  // Release, reject, block lots; decide on expiry-blocked stock. Cannot ship.
  qc: [...office('stock', 'alerts'), ...floor('tasks', 'qc', 'query')],
  // Forecast overrides, suggestions, orders, campaigns up to simulated.
  planner: office(
    'dashboard', 'stock', 'orders', 'shipping', 'supply', 'planning', 'campaigns', 'dealers', 'approvals', 'alerts', 'masters',
  ),
  // Own dealers: orders, visits, dealer stock observations, consignment counts.
  sales_rep: [...office('orders', 'dealers'), ...floor('tasks', 'count', 'query')],
  // Read all; run and sign reconciliation; export files. Posts no stock.
  finance: office(
    'dashboard', 'stock', 'orders', 'shipping', 'supply', 'planning', 'campaigns', 'dealers', 'reconciliation', 'alerts', 'masters',
  ),
  // Read all, including the audit log. Writes nothing.
  auditor: ALL_OFFICE,
};

export function canSee(role: Role | null | undefined, screen: Screen): boolean {
  return !!role && ROLE_SCREENS[role].includes(screen);
}

export function officeScreensFor(role: Role | null | undefined): OfficeScreen[] {
  return OFFICE_SCREENS.filter((s) => canSee(role, `office.${s}`));
}

export function floorScreensFor(role: Role | null | undefined): FloorScreen[] {
  return FLOOR_SCREENS.filter((s) => canSee(role, `floor.${s}`));
}

/** Coarse capabilities used to hide buttons; the database is the authority. */
export const CAPABILITIES = [
  'stock.post',
  'stock.adjust.approve',
  'truck.weight_override.approve',
  'scrap.request',
  'scrap.approve',
  'lot.qc_decide',
  'location.manage',
  'task.manage',
  'order.edit',
  'forecast.override',
  'campaign.edit',
  'campaign.approve',
  'params.propose',
  'params.publish',
  'role.assign',
  'recon.sign',
  'logo.export',
  'audit.read',
  'scanlog.read',
  'dealer.observe',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  owner: CAPABILITIES,
  ops_manager: [
    'stock.post', 'stock.adjust.approve', 'truck.weight_override.approve', 'scrap.approve', 'location.manage',
    'task.manage', 'order.edit', 'campaign.approve', 'audit.read', 'scanlog.read',
  ],
  operator: ['stock.post'],
  qc: ['lot.qc_decide', 'scrap.request'],
  planner: ['order.edit', 'forecast.override', 'campaign.edit', 'params.propose'],
  sales_rep: ['order.edit', 'dealer.observe'],
  finance: ['recon.sign', 'logo.export'],
  auditor: ['audit.read'],
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  return !!role && ROLE_CAPABILITIES[role].includes(capability);
}

/** Where a role lands after sign-in. */
export function homePathFor(role: Role | null | undefined): string {
  if (!role) return '/login';
  if (role === 'operator') return '/floor';
  const first = officeScreensFor(role)[0];
  return first ? `/${first}` : '/floor';
}

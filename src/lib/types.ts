export type Privacy = 'PUBLIC' | 'PRIVATE' | 'SECRET';
export type ValueType = 'text' | 'number' | 'boolean' | 'date' | 'url' | 'json';
export type EventType = 'EXPIRY' | 'RENEWAL' | 'REVIEW' | 'PAYMENT_DUE' | 'CUSTOM';
export type EventStatus = 'UPCOMING' | 'DONE' | 'DISMISSED' | 'UNKNOWN';

export interface SourceOfTruth {
  kind: 'ATLAS' | 'EXTERNAL';
  provider?: string;
  reference?: string;
}

export interface Field {
  id: string;
  entityId: string;
  key: string;
  valueType: ValueType;
  value: unknown;
  privacy: Privacy;
  searchable: boolean;
  sourceOfTruth?: SourceOfTruth;
}

export interface Entity {
  id: string;
  name: string;
  templateId?: string;
  category: string;
  status: string;
  privacy: Privacy;
  tags: string[];
  fields: Field[];
  createdAt: string;
  updatedAt: string;
}

export interface Relation {
  id: string;
  sourceId: string;
  type: string;
  targetId: string;
  note?: string;
  privacy: Privacy;
  createdAt: string;
}

export interface LifecycleEvent {
  id: string;
  entityId: string;
  type: EventType;
  dueAt?: string;
  recurrence?: string;
  policy?: 'AUTO_RENEW' | 'MANUAL' | 'DO_NOT_RENEW' | 'REVIEW';
  status: EventStatus;
  note?: string;
}

export interface VaultSnapshot {
  revision: number;
  entities: Entity[];
  relations: Relation[];
  events: LifecycleEvent[];
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  entityCount: number;
  seedAvailable?: boolean;
  bridgeError?: string;
}

export interface ImportPreview {
  entityCount: number;
  relationCount: number;
  eventCount: number;
  duplicateEntityCount: number;
  duplicateRelationCount: number;
  duplicateEventCount: number;
}

export interface CaptureRequest {
  title: string;
  url: string;
  favicon?: string;
  identityId: string;
}

export interface Template {
  id: string;
  label: string;
  category: string;
  fields: Array<{ key: string; valueType: ValueType; privacy: Privacy; searchable: boolean }>;
}

export const RELATION_TYPES = [
  'REGISTERED_WITH',
  'AUTHENTICATES_WITH',
  'RECOVERS_WITH',
  'OWNS_ADDRESS',
  'MANAGES',
  'USES',
  'DEPENDS_ON',
  'HOSTS',
  'HOSTED_ON',
  'CONNECTED_VIA',
  'EXPOSED_AT',
  'SOURCE_IN',
  'DEPLOYED_ON',
  'PAID_BY',
  'BILLED_FOR',
  'ISSUED_BY',
  'STORED_IN',
  'RELATED_TO'
] as const;

export const TEMPLATES: Template[] = [
  { id: 'email', label: 'Email', category: 'Email', fields: [{ key: 'address', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'provider', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'region', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'identity', label: 'Identity', category: 'Identity', fields: [{ key: 'provider', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'region', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'role', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'website-account', label: 'Website Account', category: 'Website Account', fields: [{ key: 'origin', valueType: 'url', privacy: 'PRIVATE', searchable: true }, { key: 'username', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'server', label: 'Server', category: 'Server', fields: [{ key: 'provider', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'region', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'role', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'domain', label: 'Domain', category: 'Domain', fields: [{ key: 'fqdn', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'registrar', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'sim', label: 'SIM / Phone', category: 'SIM', fields: [{ key: 'country', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'carrier', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'role', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'subscription', label: 'Subscription', category: 'Subscription', fields: [{ key: 'provider', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'cost', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'renewal', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'project', label: 'Project', category: 'Project', fields: [{ key: 'purpose', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'url', valueType: 'url', privacy: 'PRIVATE', searchable: true }] },
  { id: 'repository', label: 'Repository', category: 'Repository', fields: [{ key: 'host', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'url', valueType: 'url', privacy: 'PRIVATE', searchable: true }] },
  { id: 'ai-provider-account', label: 'AI Provider Account', category: 'AI Provider Account', fields: [{ key: 'provider', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'plan', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'role', valueType: 'text', privacy: 'PRIVATE', searchable: true }] },
  { id: 'payment-card', label: 'Payment Card', category: 'Payment Card', fields: [{ key: 'issuer', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'last4', valueType: 'text', privacy: 'PRIVATE', searchable: true }, { key: 'expires', valueType: 'date', privacy: 'PRIVATE', searchable: true }] }
];

export function emptySnapshot(): VaultSnapshot {
  return { revision: 0, entities: [], relations: [], events: [] };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

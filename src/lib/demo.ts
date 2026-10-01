import type { Entity, Field, LifecycleEvent, Relation, VaultSnapshot } from './types';

const date = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();

function fields(entityId: string, values: Record<string, unknown>): Field[] {
  return Object.entries(values).map(([key, value]) => ({
    id: `${entityId}-${key}`,
    entityId,
    key,
    valueType: typeof value === 'number' ? 'number' : key === 'url' || key === 'origin' ? 'url' : 'text',
    value,
    privacy: 'PRIVATE',
    searchable: true
  }));
}

function entity(id: string, name: string, category: string, values: Record<string, unknown>, tags: string[] = []): Entity {
  const createdAt = date(-Math.floor(Math.random() * 900));
  return { id, name, templateId: category.toLowerCase(), category, status: 'ACTIVE', privacy: 'PRIVATE', tags, fields: fields(id, values), createdAt, updatedAt: createdAt };
}

export function demoSnapshot(): VaultSnapshot {
  const entities: Entity[] = [
    entity('id-google-jp', 'Google Account JP Main', 'Identity', { provider: 'Google', region: 'JP', role: 'main' }, ['google', 'core']),
    entity('email-gmail-main', 'amiyadesiwa@gmail.com', 'Email', { address: 'amiyadesiwa@gmail.com', provider: 'Gmail', region: 'JP' }, ['mail', 'core']),
    entity('id-google-hk', 'Google Account HK Small', 'Identity', { provider: 'Google', region: 'HK', role: 'secondary' }, ['google', 'secondary']),
    entity('email-gmail-hk', 'amiyadesi111@gmail.com', 'Email', { address: 'amiyadesi111@gmail.com', provider: 'Gmail', region: 'HK' }, ['mail']),
    entity('service-reddit', 'Reddit Main', 'Website Account', { origin: 'https://www.reddit.com', username: 'main operated account' }, ['social']),
    entity('service-x', 'X Secondary', 'Website Account', { origin: 'https://x.com', username: 'secondary account' }, ['social']),
    entity('cloudflare-main', 'Cloudflare Main', 'Identity', { provider: 'Cloudflare', region: 'Global', role: 'DNS / CDN' }, ['cloud', 'core']),
    entity('domain-sayori', 'sayori.org', 'Domain', { fqdn: 'sayori.org', registrar: 'Cloudflare' }, ['domain', 'core']),
    entity('server-home', 'Home-01', 'Server', { provider: 'Home', region: 'private', role: 'personal node' }, ['infra']),
    entity('service-vaultwarden', 'Vaultwarden', 'Project', { purpose: 'External secret source', url: 'https://vaultwarden.example.invalid' }, ['security', 'core']),
    entity('project-geoscore', 'GeoScore', 'Project', { purpose: 'Evidence-first SEO / GEO audit', url: 'https://geo.sayori.org' }, ['project']),
    entity('project-search-gateway', 'Search Gateway', 'Project', { purpose: 'Search and extraction gateway', url: 'https://search.example.invalid' }, ['project', 'infra']),
    entity('sim-saily', 'Saily +1 US number', 'SIM', { country: 'US', carrier: 'Saily', role: 'backup / collection' }, ['backup', 'review']),
    entity('subscription-grok', 'SuperGrok', 'Subscription', { provider: 'xAI', cost: 'monthly', renewal: 'DO_NOT_RENEW' }, ['review']),
    entity('card-primary', 'Primary payment card', 'Payment Card', { issuer: 'Personal bank', last4: '••••' }, ['billing'])
  ];
  const relations: Relation[] = [
    { id: 'rel-1', sourceId: 'id-google-jp', type: 'OWNS_ADDRESS', targetId: 'email-gmail-main', privacy: 'PRIVATE', createdAt: date(-90) },
    { id: 'rel-2', sourceId: 'id-google-hk', type: 'OWNS_ADDRESS', targetId: 'email-gmail-hk', privacy: 'PRIVATE', createdAt: date(-90) },
    { id: 'rel-3', sourceId: 'service-reddit', type: 'REGISTERED_WITH', targetId: 'email-gmail-hk', privacy: 'PRIVATE', createdAt: date(-60), note: 'main operated Reddit account' },
    { id: 'rel-4', sourceId: 'service-x', type: 'REGISTERED_WITH', targetId: 'email-gmail-hk', privacy: 'PRIVATE', createdAt: date(-60) },
    { id: 'rel-5', sourceId: 'cloudflare-main', type: 'MANAGES', targetId: 'domain-sayori', privacy: 'PRIVATE', createdAt: date(-60) },
    { id: 'rel-6', sourceId: 'server-home', type: 'HOSTS', targetId: 'service-vaultwarden', privacy: 'PRIVATE', createdAt: date(-40) },
    { id: 'rel-7', sourceId: 'project-geoscore', type: 'USES', targetId: 'project-search-gateway', privacy: 'PRIVATE', createdAt: date(-20) },
    { id: 'rel-8', sourceId: 'subscription-grok', type: 'PAID_BY', targetId: 'card-primary', privacy: 'PRIVATE', createdAt: date(-20) }
  ];
  const events: LifecycleEvent[] = [
    { id: 'event-1', entityId: 'subscription-grok', type: 'RENEWAL', dueAt: date(18), policy: 'DO_NOT_RENEW', status: 'UPCOMING', note: 'review cancellation before renewal' },
    { id: 'event-2', entityId: 'sim-saily', type: 'REVIEW', dueAt: date(35), policy: 'REVIEW', status: 'UPCOMING' },
    { id: 'event-3', entityId: 'domain-sayori', type: 'EXPIRY', dueAt: date(92), policy: 'MANUAL', status: 'UPCOMING' }
  ];
  return { revision: 1, entities, relations, events };
}

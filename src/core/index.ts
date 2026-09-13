export * from './domain/index.js';
export * from './application/index.js';

/*
 * Disambiguate `AttentionItem`: the domain module (types.ts) and the
 * attention use-case module (attention-item.ts) export different
 * `AttentionItem` interfaces — a legacy persistence projection versus the
 * operational inbox shape. The operational use-case type is the
 * package-facing canonical export; the legacy projection remains
 * explicitly importable from `src/core/domain/types.ts` until issue #91's
 * repository/command migration reconciles the two.
 */
export type { AttentionItem } from './application/use-cases/attention/attention-item.js';

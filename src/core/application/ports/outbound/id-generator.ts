import type { EntityId } from '../../../domain/types.js';

export interface IdGeneratorPort {
  generate(prefix: string): EntityId;
}

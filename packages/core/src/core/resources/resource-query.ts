/**
 * Resource Query
 *
 * Parse user input into name + optional type filter for resource lookups.
 * Extracted from which-pipeline.ts for reuse across resource-spec, list, etc.
 */

import { normalizeType } from './resource-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResourceQuery {
  /** Raw input from user */
  raw: string;
  /** Extracted resource name */
  name: string;
  /** Optional type filter from qualified input (e.g. "skills/skill-dev" → "skill") */
  typeFilter?: string;
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/**
 * Parse a user query into name + optional type filter.
 *
 * - Bare name: `skill-dev` → { name: "skill-dev" }
 * - Qualified:  `skills/skill-dev` → { name: "skill-dev", typeFilter: "skill" }
 */
export function parseResourceQuery(input: string): ResourceQuery {
  const slashIndex = input.indexOf('/');
  if (slashIndex === -1) {
    return { raw: input, name: input };
  }

  const prefix = input.slice(0, slashIndex);
  const name = input.slice(slashIndex + 1);

  if (!name) {
    return { raw: input, name: input };
  }

  const typeFilter = normalizeType(prefix);
  // If normalizeType falls back to 'other', the prefix wasn't a known type
  if (typeFilter === 'other') {
    return { raw: input, name: input };
  }

  return { raw: input, name, typeFilter };
}

/**
 * Tests for sync options normalizer — --force direction-aware behavior.
 *
 * Validates that:
 * 1. --force + --push → conflicts: 'workspace'
 * 2. --force + --pull → conflicts: 'source'
 * 3. --force alone (bidirectional) → throws error
 * 4. Explicit --conflicts takes precedence over --force
 * 5. --json defaults to 'auto' conflict strategy
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSyncOptions } from '../../../packages/core/src/core/sync/sync-options-normalizer.js';

describe('sync-options-normalizer', () => {
  // ── --force direction-aware ────────────────────────────────────

  it('--force + --push → conflicts: workspace', () => {
    const opts = normalizeSyncOptions({ push: true, force: true });
    assert.equal(opts.direction, 'push');
    assert.equal(opts.conflicts, 'workspace');
  });

  it('--force + --pull → conflicts: source', () => {
    const opts = normalizeSyncOptions({ pull: true, force: true });
    assert.equal(opts.direction, 'pull');
    assert.equal(opts.conflicts, 'source');
  });

  it('--force alone (bidirectional) → throws', () => {
    assert.throws(
      () => normalizeSyncOptions({ force: true }),
      /--force requires --push or --pull/
    );
  });

  it('--force + --push + --pull (bidirectional) → throws', () => {
    assert.throws(
      () => normalizeSyncOptions({ push: true, pull: true, force: true }),
      /--force requires --push or --pull/
    );
  });

  // ── Explicit --conflicts takes precedence ──────────────────────

  it('--conflicts source + --force + --push → conflicts: source (explicit wins)', () => {
    const opts = normalizeSyncOptions({ push: true, force: true, conflicts: 'source' });
    assert.equal(opts.conflicts, 'source');
  });

  it('--conflicts workspace + --force + --pull → conflicts: workspace (explicit wins)', () => {
    const opts = normalizeSyncOptions({ pull: true, force: true, conflicts: 'workspace' });
    assert.equal(opts.conflicts, 'workspace');
  });

  // ── Direction detection ────────────────────────────────────────

  it('--push only → direction: push', () => {
    const opts = normalizeSyncOptions({ push: true });
    assert.equal(opts.direction, 'push');
  });

  it('--pull only → direction: pull', () => {
    const opts = normalizeSyncOptions({ pull: true });
    assert.equal(opts.direction, 'pull');
  });

  it('neither → direction: bidirectional', () => {
    const opts = normalizeSyncOptions({});
    assert.equal(opts.direction, 'bidirectional');
  });

  it('both --push and --pull → direction: bidirectional', () => {
    const opts = normalizeSyncOptions({ push: true, pull: true });
    assert.equal(opts.direction, 'bidirectional');
  });

  // ── JSON mode ──────────────────────────────────────────────────

  it('--json without explicit conflicts → conflicts: auto', () => {
    const opts = normalizeSyncOptions({ json: true });
    assert.equal(opts.conflicts, 'auto');
  });

  it('--json with explicit conflicts → preserves explicit', () => {
    const opts = normalizeSyncOptions({ json: true, conflicts: 'skip' });
    assert.equal(opts.conflicts, 'skip');
  });

  // ── Invalid strategy ───────────────────────────────────────────

  it('invalid --conflicts value → throws', () => {
    assert.throws(
      () => normalizeSyncOptions({ conflicts: 'invalid' }),
      /Invalid --conflicts strategy/
    );
  });
});

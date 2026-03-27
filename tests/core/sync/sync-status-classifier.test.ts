/**
 * Tests for sync status classifier — diverged file handling.
 *
 * Validates that:
 * 1. Diverged files in push-only mode create conflict actions (abort) by default
 * 2. Diverged files in pull-only mode create conflict actions (abort) by default
 * 3. Explicit --conflicts strategy resolves diverged files regardless of direction
 * 4. Non-diverged statuses behave as before (modified→push, outdated→pull, etc.)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyFileActions } from '../../../packages/core/src/core/sync/sync-status-classifier.js';
import type { ContentStatus } from '../../../packages/core/src/core/list/content-status-checker.js';
import type { SyncConflictStrategy, SyncDirection } from '../../../packages/core/src/core/sync/sync-types.js';

function classify(
  status: ContentStatus,
  direction: SyncDirection,
  conflicts?: SyncConflictStrategy,
) {
  const map = new Map([['src/file.ts::src/file.ts', status]]);
  return classifyFileActions(map, direction, conflicts);
}

describe('sync-status-classifier', () => {
  // ── Diverged files: default behavior (no --conflicts) ──────────

  it('push-only + diverged → conflict (abort)', () => {
    const actions = classify('diverged', 'push');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'conflict');
  });

  it('pull-only + diverged → conflict (abort)', () => {
    const actions = classify('diverged', 'pull');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'conflict');
  });

  it('bidirectional + diverged + no strategy → conflict (abort)', () => {
    const actions = classify('diverged', 'bidirectional');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'conflict');
  });

  // ── Diverged files: explicit strategy ──────────────────────────

  it('push + diverged + --conflicts workspace → push', () => {
    const actions = classify('diverged', 'push', 'workspace');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'push');
  });

  it('push + diverged + --conflicts source → pull', () => {
    const actions = classify('diverged', 'push', 'source');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'pull');
  });

  it('pull + diverged + --conflicts source → pull', () => {
    const actions = classify('diverged', 'pull', 'source');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'pull');
  });

  it('pull + diverged + --conflicts workspace → push', () => {
    const actions = classify('diverged', 'pull', 'workspace');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'push');
  });

  it('any direction + diverged + --conflicts skip → skip', () => {
    for (const dir of ['push', 'pull', 'bidirectional'] as SyncDirection[]) {
      const actions = classify('diverged', dir, 'skip');
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'skip');
    }
  });

  it('any direction + diverged + --conflicts auto → skip', () => {
    for (const dir of ['push', 'pull', 'bidirectional'] as SyncDirection[]) {
      const actions = classify('diverged', dir, 'auto');
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'skip');
    }
  });

  // ── Non-diverged statuses: unchanged behavior ──────────────────

  it('modified + push → push', () => {
    const actions = classify('modified', 'push');
    assert.equal(actions[0].type, 'push');
  });

  it('modified + pull → skip', () => {
    const actions = classify('modified', 'pull');
    assert.equal(actions[0].type, 'skip');
  });

  it('outdated + pull → pull', () => {
    const actions = classify('outdated', 'pull');
    assert.equal(actions[0].type, 'pull');
  });

  it('outdated + push → skip', () => {
    const actions = classify('outdated', 'push');
    assert.equal(actions[0].type, 'skip');
  });

  it('clean → no actions', () => {
    const actions = classify('clean', 'push');
    assert.equal(actions.length, 0);
  });
});

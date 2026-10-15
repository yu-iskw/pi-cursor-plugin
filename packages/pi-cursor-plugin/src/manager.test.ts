import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseSource,
  readManifest,
  safeJoin,
  loadRegistry,
  addMarketplace,
  resolvePlugin,
} from './manager.js';
describe('plugin manager', () => {
  it('parses GitHub repositories and subdirectories', () => {
    expect(parseSource('github:cursor/plugins/pstack')).toEqual({
      repo: 'cursor/plugins',
      subdir: 'pstack',
    });
    expect(parseSource('https://github.com/cursor/plugins/tree/main/thermos')).toEqual({
      repo: 'cursor/plugins',
      ref: 'main',
      subdir: 'thermos',
    });
  });
  it('rejects traversal', () => expect(() => safeJoin('/tmp/plugins', '../secrets')).toThrow());
  it('recognizes both manifest formats', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-plugin-'));
    try {
      writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'example' }));
      expect(readManifest(root).format).toBe('agent');
      mkdirSync(join(root, '.cursor-plugin'));
      writeFileSync(
        join(root, '.cursor-plugin', 'plugin.json'),
        JSON.stringify({ name: 'example-cursor' }),
      );
      expect(readManifest(root).format).toBe('cursor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('persists marketplaces and resolves names', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-registry-'));
    try {
      addMarketplace('official', 'github:cursor/plugins', root);
      expect(resolvePlugin('pstack', root)).toBe('github:cursor/plugins/pstack');
      expect(loadRegistry(root).marketplaces.official).toBe('github:cursor/plugins');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

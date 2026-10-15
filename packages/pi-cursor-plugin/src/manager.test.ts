import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addMarketplace,
  commitInstalledPlugin,
  loadRegistry,
  parseSource,
  readManifest,
  resolvePlugin,
  safeJoin,
  setEnabled,
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
  it('replaces a plugin without dropping a disabled install', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-install-'));
    const source = join(root, 'source');
    const home = join(root, 'home');
    try {
      mkdirSync(source);
      writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'example', version: '1' }));
      commitInstalledPlugin({
        sourceDir: source,
        source: 'github:example/plugins/example',
        sourcePath: 'example',
        revision: 'abc',
        home,
      });
      setEnabled('example', false, home);
      writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'example', version: '2' }));
      writeFileSync(join(source, 'README.md'), 'updated\n');
      const updated = commitInstalledPlugin({
        sourceDir: source,
        source: 'github:example/plugins/example',
        sourcePath: 'example',
        revision: 'def',
        home,
      });
      expect(updated.enabled).toBe(false);
      expect(loadRegistry(home).plugins.example.enabled).toBe(false);
      expect(loadRegistry(home).plugins.example.revision).toBe('def');
      expect(readFileSync(join(home, 'plugins', 'example', 'README.md'), 'utf8')).toBe('updated\n');
      expect(() =>
        commitInstalledPlugin({
          sourceDir: join(root, 'missing'),
          source: 'github:example/plugins/example',
          sourcePath: 'example',
          revision: 'fff',
          home,
        }),
      ).toThrow('No supported plugin manifest');
      expect(readFileSync(join(home, 'plugins', 'example', 'README.md'), 'utf8')).toBe('updated\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = dirname(fileURLToPath(import.meta.url));
const root = resolve(output, '../../../../..');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = cwd => {
  const tracked = git(cwd, ['diff', 'HEAD', '--name-only', '-z']).split('\0').filter(Boolean);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].filter(p => !p.startsWith('.jarvis/context/evidence/code-review/cr_migration_audit_20260923/'));
  const groups = {};
  const inventory = files.map(path => {
    const group = path.startsWith('packages/') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
    groups[group] = (groups[group] ?? 0) + 1;
    try {
      const data = readFileSync(resolve(cwd, path));
      return { path, untracked: untracked.includes(path), bytes: data.length, sha256: sha(data) };
    } catch { return { path, untracked: untracked.includes(path), absentOrUnreadable: true }; }
  });
  return { head: git(cwd, ['rev-parse', 'HEAD']).trim(), branch: git(cwd, ['branch', '--show-current']).trim(), trackedChanged: tracked.length, untracked: untracked.length, groups, trackedDiffSha256: sha(git(cwd, ['diff', 'HEAD', '--binary'])), inventory };
};
const result = { observedAt: new Date().toISOString(), v2: snapshot(root), v1: snapshot(resolve(root, '../../..')) };
const name = process.argv[2] === 'end' ? 'workspace-end.json' : 'workspace-start.json';
writeFileSync(resolve(output, name), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ observedAt: result.observedAt, v2: { ...result.v2, inventory: undefined }, v1: { ...result.v1, inventory: undefined } }, null, 2));

#!/usr/bin/env node
// Link the CLI into ~/.local/bin so `printer` resolves regardless of which
// Node toolchain (mise, Hermes, nvm, system) happens to be active in a shell.
import { mkdir, symlink, unlink, lstat, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const binDir = path.join(os.homedir(), '.local', 'bin');
const link = path.join(binDir, 'printer');
await mkdir(binDir, { recursive: true });
await chmod(target, 0o755);
try { await lstat(link); await unlink(link); } catch {}
await symlink(target, link);
console.log(`Linked ${link} -> ${target}`);
const onPath = (process.env.PATH || '').split(path.delimiter).includes(binDir);
if (!onPath) console.log(`Add ${binDir} to your PATH, e.g. in ~/.zshrc:\n  export PATH="$HOME/.local/bin:$PATH"`);
console.log('Try: printer print https://example.com/article');

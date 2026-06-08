#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

const cwd = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const child = spawn(npmCmd, ['run', 'dev'], {
  cwd,
  env: { ...process.env, COMPOSER_AUTO_TEST_EXPORT: '1' },
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code);
});

child.on('error', (err) => {
  console.error('Failed to start dev server:', err);
  process.exit(1);
});

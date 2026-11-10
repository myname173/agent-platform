#!/usr/bin/env node
/** Validate exactly the assertions implemented by the live/replay engine. */
import path from 'node:path';
import { loadTools, loadSuites } from './eval-contract.mjs';
try {
  const root = path.resolve(import.meta.dirname, '..');
  const tools = loadTools(path.join(root, 'workflows', 'chat-gateway.json'));
  const { cases, suiteHash } = loadSuites(path.join(root, 'eval', 'suites'), tools);
  console.log(`validation OK: ${cases.length} cases, suite_hash=${suiteHash}`);
} catch (e) {
  console.error(`validation FAILED: ${e.message}`);
  process.exitCode = 1;
}

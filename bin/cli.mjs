#!/usr/bin/env node

import module from 'node:module';

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

// Fork-local: always-on debug logging to the default state file.
// Explicit overrides still win: SKILLS_DEBUG=stderr, SKILLS_DEBUG=/path,
// SKILLS_DEBUG_FILE=..., or --debug=/path. Unset => default file.
if (!process.env.SKILLS_DEBUG && !process.env.SKILLS_DEBUG_FILE) {
  process.env.SKILLS_DEBUG = '1';
}

await import('../dist/cli.mjs');

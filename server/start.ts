/**
 * server/start.ts — entry point for `bun run server`.
 *
 * Loads .env synchronously BEFORE any server module is imported, then
 * dynamically imports server/index.ts to start the Express server.
 *
 * This two-file pattern is necessary because ES module static imports are
 * hoisted and executed before any top-level code in the importing file,
 * making it impossible to guarantee env loading runs first inside index.ts
 * itself.  By using a dynamic import here, load-env.ts runs to completion
 * before a single line of index.ts (or its transitive imports) executes.
 */

import './load-env.js'
await import('./index.js')

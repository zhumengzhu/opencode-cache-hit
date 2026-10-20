/**
 * V2 server entry discovered from the package root.
 *
 * V2 resolves local directory plugins as `<dir>/server` and `<dir>/tui`
 * (`Host.resolve`), not through `package.json` exports. Package-name installs
 * still resolve `exports["."]`. This shim keeps the intentional no-op server
 * entry reachable from both paths.
 */
export { default } from "./src/v2/server.ts"

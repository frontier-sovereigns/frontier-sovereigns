/** Compute isolates need local module loading and temporary files, never endpoint
 * configuration, tokens, or NODE_OPTIONS inherited from the gateway process.
 * Constructors must also set execArgv: []: Node re-reads inherited --env-file
 * arguments and executes inherited preloads even with an empty worker env. */
export function computeWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'NODE_ENV']);
  const environment: Record<string, string> = {};
  for (const name of Object.keys(source)) if (allowed.has(name.toUpperCase())) {
    const value = source[name]; if (value !== undefined) environment[name] = value;
  }
  return environment;
}

// Vitest globalSetup for the integration project: probes the environment once and
// hands the outcome to the tests, which skip (with the reason) when it failed.
import type { TestProject } from 'vitest/node';
import { loadEnv, probe } from '../support/probe.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    mssql: { connectionString: string | null; reason: string };
  }
}

export default async function setup(project: TestProject): Promise<void> {
  loadEnv();
  const connectionString = process.env['MSSQL_CONNECTION_STRING'];
  const result = await probe(connectionString);
  const failed = result.checks.filter((c) => !c.ok);
  const reason = failed.map((c) => `${c.name}: ${c.detail}`).join('; ');
  if (failed.length) console.warn(`[mssql-ffi] integration tests skipped -> ${reason}`);
  project.provide('mssql', {
    connectionString: result.ok && connectionString ? connectionString : null,
    reason,
  });
}

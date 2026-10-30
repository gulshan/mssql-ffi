// probe.ts - development-only environment checks, shared by `node --run probe` and the
// integration test gate. Not part of the published library.
import { existsSync } from 'node:fs';
import * as C from '../../src/odbc/constants.ts';
import { odbc } from '../../src/odbc/ffi.ts';
import { environment, ok } from '../../src/odbc/handles.ts';
import { currentPlatform } from '../../src/odbc/platform.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  checks: Check[];
  drivers: string[];
  /** Set when the server answered. */
  serverVersion?: string | undefined;
}

/** Loads `.env` from the working directory if there is one. */
export function loadEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

function attempt(checks: Check[], name: string, fn: () => string): boolean {
  try {
    checks.push({ name, ok: true, detail: fn() });
    return true;
  } catch (e) {
    checks.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

function listDrivers(): string[] {
  const api = odbc();
  const env = environment();
  const desc = Buffer.alloc(1024);
  const descLen = Buffer.alloc(2);
  const attr = Buffer.alloc(4096);
  const attrLen = Buffer.alloc(2);
  const drivers: string[] = [];
  let direction = C.SQL_FETCH_FIRST;
  while (ok(api.SQLDriversW(env, direction, desc, 512, descLen, attr, 2048, attrLen))) {
    drivers.push(desc.toString('utf16le', 0, descLen.readInt16LE(0) * 2));
    direction = C.SQL_FETCH_NEXT;
  }
  return drivers;
}

/** Runs the checks; connects when a connection string is given. */
export async function probe(connectionString?: string): Promise<ProbeResult> {
  const checks: Check[] = [];
  const result: ProbeResult = { ok: false, checks, drivers: [] };

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 26 || (major === 26 && minor >= 1);
  checks.push({ name: 'node', ok: nodeOk, detail: `v${process.versions.node} (need >= 26.1)` });
  if (!nodeOk) return result;

  if (
    !attempt(
      checks,
      'platform',
      () => `${process.platform}/${process.arch} -> ${currentPlatform().library}`,
    )
  ) {
    return result;
  }
  if (
    !attempt(checks, 'node:ffi', () => {
      if (!process.getBuiltinModule('node:ffi')) throw new Error('not available in this build');
      return 'available';
    })
  ) {
    return result;
  }
  if (!attempt(checks, 'driver manager', () => (odbc(), 'loaded'))) return result;

  attempt(checks, 'drivers', () => {
    result.drivers = listDrivers();
    const sqlServer = result.drivers.filter((d) => /SQL Server/i.test(d));
    if (!sqlServer.length) throw new Error('no SQL Server ODBC driver installed');
    return sqlServer.join(', ');
  });

  if (!connectionString) {
    checks.push({ name: 'server', ok: false, detail: 'MSSQL_CONNECTION_STRING is not set' });
  } else {
    try {
      const { open } = await import('../../src/index.ts');
      await using conn = await open(connectionString, { loginTimeoutSecs: 5 });
      const r = await conn.query<{ v: string }>('SELECT @@VERSION AS v');
      result.serverVersion = r.first[0]?.v.split('\n')[0]?.trim();
      checks.push({ name: 'server', ok: true, detail: result.serverVersion ?? 'connected' });
    } catch (e) {
      checks.push({
        name: 'server',
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  result.ok = checks.every((c) => c.ok);
  return result;
}

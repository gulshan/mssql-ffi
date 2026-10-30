// Development probe: node --run probe
// Checks Node, platform, node:ffi, the ODBC driver manager, installed drivers and the
// server named by MSSQL_CONNECTION_STRING (from .env).
import { styleText } from 'node:util';
import { loadEnv, probe } from '../tests/support/probe.ts';

loadEnv();
const result = await probe(process.env['MSSQL_CONNECTION_STRING']);

for (const c of result.checks) {
  const mark = c.ok ? styleText('green', 'ok  ') : styleText('red', 'FAIL');
  console.log(`${mark} ${c.name.padEnd(15)} ${c.detail}`);
}
if (result.drivers.length) {
  console.log(styleText('dim', `\nODBC drivers: ${result.drivers.join(' | ')}`));
}
process.exitCode = result.ok ? 0 : 1;

// Run with: node --run demo   (reads MSSQL_CONNECTION_STRING from .env)
import { open, sql } from '../src/index.ts';

const connectionString = process.env['MSSQL_CONNECTION_STRING'];
if (!connectionString) throw new Error('Set MSSQL_CONNECTION_STRING (see .env.example)');

await using db = await open(connectionString);

const r = await db.query(
  'SELECT TOP 5 name, database_id, create_date FROM sys.databases WHERE database_id > ? ORDER BY database_id',
  [sql.Int(0)],
);
console.table(r.first);

const multi = await db.query(
  "SELECT 1 AS a; SELECT N'héllo' AS b, CAST(1.5 AS decimal(5,2)) AS c, SYSDATETIMEOFFSET() AS now",
);
console.log(multi.results);

for await (const row of db.stream('SELECT TOP 3 name FROM sys.objects ORDER BY name')) {
  console.log(row);
}

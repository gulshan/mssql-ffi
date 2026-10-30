// proc.ts - stored procedure calls with output parameters and return code.
//
// The call runs as one parameterized batch:
//   DECLARE @__rc int; DECLARE @__o1 nvarchar(50) = ?;
//   EXEC @__rc = [dbo].[proc] @a = ?, @b = @__o1 OUTPUT;
//   SELECT @__rc AS [returns], @__o1 AS [b];
// The trailing result set is split off into `returns` and `output`.
import { isTypedParam, typed } from './sql.ts';
import type { Param, SqlTypeName } from './types.ts';

export interface ProcParam {
  /** Name including the leading `@`. */
  name: string;
  type: string;
  maxLength: number;
  precision: number;
  scale: number;
  isOutput: boolean;
}

export interface ProcParamInfo {
  /** Schema-qualified, quoted name resolved by the server. */
  qualifiedName: string;
  params: ProcParam[];
}

export const PROC_META_SQL = `
DECLARE @id int = OBJECT_ID(?);
IF @id IS NULL OR OBJECTPROPERTY(@id, 'IsProcedure') = 0
  THROW 50000, 'Stored procedure not found', 1;
SELECT QUOTENAME(OBJECT_SCHEMA_NAME(@id)) + '.' + QUOTENAME(OBJECT_NAME(@id)) AS qualifiedName;
SELECT p.name, TYPE_NAME(p.user_type_id) AS type, p.max_length AS maxLength,
       p.precision, p.scale, p.is_output AS isOutput
FROM sys.all_parameters p WHERE p.object_id = @id ORDER BY p.parameter_id;`;

const SQL_TYPES: ReadonlySet<string> = new Set<SqlTypeName>([
  'bit',
  'tinyint',
  'smallint',
  'int',
  'bigint',
  'float',
  'real',
  'decimal',
  'numeric',
  'money',
  'smallmoney',
  'char',
  'varchar',
  'text',
  'nchar',
  'nvarchar',
  'ntext',
  'xml',
  'binary',
  'varbinary',
  'image',
  'uniqueidentifier',
  'date',
  'time',
  'datetime',
  'datetime2',
  'smalldatetime',
  'datetimeoffset',
]);

/** T-SQL type declaration for a procedure parameter, e.g. `nvarchar(50)`, `decimal(18,2)`. */
export function declareType(p: ProcParam): string {
  switch (p.type) {
    case 'nchar':
    case 'nvarchar':
      return `${p.type}(${p.maxLength === -1 ? 'max' : p.maxLength / 2})`;
    case 'char':
    case 'varchar':
    case 'binary':
    case 'varbinary':
      return `${p.type}(${p.maxLength === -1 ? 'max' : p.maxLength})`;
    case 'decimal':
    case 'numeric':
      return `${p.type}(${p.precision},${p.scale})`;
    case 'time':
    case 'datetime2':
    case 'datetimeoffset':
      return `${p.type}(${p.scale})`;
    default:
      return p.type;
  }
}

/** Gives an untyped value the parameter's declared SQL type when it is a known one. */
function typeFor(p: ProcParam, value: Param): Param {
  if (value === null || value === undefined || isTypedParam(value) || !SQL_TYPES.has(p.type)) {
    return value;
  }
  const type = p.type as SqlTypeName;
  const length = p.maxLength === -1 ? undefined : p.maxLength;
  switch (type) {
    case 'decimal':
    case 'numeric':
      return typed(type, value, { precision: p.precision, scale: p.scale });
    case 'nchar':
    case 'nvarchar':
      return typed(type, value, length === undefined ? {} : { length: length / 2 });
    case 'char':
    case 'varchar':
    case 'binary':
    case 'varbinary':
      return typed(type, value, length === undefined ? {} : { length });
    case 'time':
    case 'datetime2':
    case 'datetimeoffset':
      return typed(type, value, { scale: p.scale });
    default:
      return typed(type, value);
  }
}

const bare = (name: string): string => name.replace(/^@/, '');

export interface ProcCall {
  sql: string;
  params: Param[];
  /** Output parameter names (without `@`), in the order of the trailing result set. */
  outputs: string[];
}

/** Builds the batch for a call. `args` is positional or keyed by name (with or without `@`). */
export function buildProcCall(
  info: ProcParamInfo,
  args: readonly Param[] | Readonly<Record<string, Param>> = [],
): ProcCall {
  const byName = new Map<string, Param>();
  if (Array.isArray(args)) {
    if (args.length > info.params.length) {
      throw new RangeError(`${info.qualifiedName} takes ${info.params.length} parameters`);
    }
    args.forEach((v: Param, i: number) => byName.set(bare(info.params[i]!.name).toLowerCase(), v));
  } else {
    const known = new Set(info.params.map((p) => bare(p.name).toLowerCase()));
    for (const [k, v] of Object.entries(args)) {
      const key = bare(k).toLowerCase();
      if (!known.has(key))
        throw new RangeError(`${info.qualifiedName} has no parameter @${bare(k)}`);
      byName.set(key, v);
    }
  }

  const declares = ['DECLARE @__rc int;'];
  const assigns: string[] = [];
  const selects = ['@__rc AS [returns]'];
  const params: Param[] = [];
  const execParams: Param[] = [];
  const outputs: string[] = [];
  info.params.forEach((p, i) => {
    const key = bare(p.name).toLowerCase();
    const has = byName.has(key);
    const value = typeFor(p, byName.get(key));
    if (p.isOutput) {
      const local = `@__o${i}`;
      declares.push(`DECLARE ${local} ${declareType(p)}${has ? ' = ?' : ''};`);
      if (has) params.push(value);
      assigns.push(`${p.name} = ${local} OUTPUT`);
      selects.push(`${local} AS [${bare(p.name).replaceAll(']', ']]')}]`);
      outputs.push(bare(p.name));
    } else if (has) {
      assigns.push(`${p.name} = ?`);
      execParams.push(value);
    }
  });
  params.push(...execParams);
  const sql = [
    ...declares,
    `EXEC @__rc = ${info.qualifiedName}${assigns.length ? ` ${assigns.join(', ')}` : ''};`,
    `SELECT ${selects.join(', ')};`,
  ].join('\n');
  return { sql, params, outputs };
}

import { describe, expect, it } from 'vitest';
import { buildProcCall, declareType } from '../../src/proc.ts';
import type { ProcParam, ProcParamInfo } from '../../src/proc.ts';
import { isTypedParam, sql } from '../../src/sql.ts';

const param = (p: Partial<ProcParam> & Pick<ProcParam, 'name' | 'type'>): ProcParam => ({
  maxLength: 4,
  precision: 10,
  scale: 0,
  isOutput: false,
  ...p,
});

const info: ProcParamInfo = {
  qualifiedName: '[dbo].[p]',
  params: [
    param({ name: '@a', type: 'int' }),
    param({ name: '@b', type: 'nvarchar', maxLength: 100 }),
    param({ name: '@total', type: 'decimal', precision: 18, scale: 2, isOutput: true }),
  ],
};

describe('declareType', () => {
  it.each([
    [param({ name: '@x', type: 'nvarchar', maxLength: 100 }), 'nvarchar(50)'],
    [param({ name: '@x', type: 'nvarchar', maxLength: -1 }), 'nvarchar(max)'],
    [param({ name: '@x', type: 'varbinary', maxLength: 16 }), 'varbinary(16)'],
    [param({ name: '@x', type: 'decimal', precision: 18, scale: 2 }), 'decimal(18,2)'],
    [param({ name: '@x', type: 'datetime2', scale: 3 }), 'datetime2(3)'],
    [param({ name: '@x', type: 'int' }), 'int'],
  ])('%#', (p, expected) => {
    expect(declareType(p)).toBe(expected);
  });
});

describe('buildProcCall', () => {
  it('named arguments, output parameter and return code', () => {
    const call = buildProcCall(info, { a: 1, '@B': 'x' });
    expect(call.sql).toBe(
      [
        'DECLARE @__rc int;',
        'DECLARE @__o2 decimal(18,2);',
        'EXEC @__rc = [dbo].[p] @a = ?, @b = ?, @total = @__o2 OUTPUT;',
        'SELECT @__rc AS [returns], @__o2 AS [total];',
      ].join('\n'),
    );
    expect(call.outputs).toEqual(['total']);
    expect(call.params).toHaveLength(2);
    expect(call.params.every(isTypedParam)).toBe(true);
    expect(call.params[1]).toMatchObject({ type: 'nvarchar', length: 50, value: 'x' });
  });

  it('positional arguments; an input/output value initialises the local', () => {
    const call = buildProcCall(info, [1, 'x', 5]);
    expect(call.sql).toContain('DECLARE @__o2 decimal(18,2) = ?;');
    // The output initialiser comes first, matching the order of the markers.
    expect(call.params[0]).toMatchObject({ type: 'decimal', value: 5 });
  });

  it('omitted inputs are left to the procedure defaults', () => {
    expect(buildProcCall(info, { a: 1 }).sql).toContain('EXEC @__rc = [dbo].[p] @a = ?, @total');
  });

  it('keeps explicitly typed values', () => {
    const v = sql.VarChar('y');
    expect(buildProcCall(info, { b: v }).params[0]).toBe(v);
  });

  it('rejects unknown names and too many arguments', () => {
    expect(() => buildProcCall(info, { nope: 1 })).toThrow(/no parameter @nope/);
    expect(() => buildProcCall(info, [1, 2, 3, 4])).toThrow(/takes 3 parameters/);
  });
});

import { inject } from 'vitest';

const env = inject('mssql');

/** Connection string from the probe (null when the integration environment is unavailable). */
export const connectionString: string = env.connectionString ?? '';
/** True when tests must be skipped; the reason is printed by the global setup. */
export const skip: boolean = env.connectionString === null;

// ODBC constants (sql.h, sqlext.h, msodbcsql.h)

// SQLRETURN
export const SQL_SUCCESS = 0;
export const SQL_SUCCESS_WITH_INFO = 1;
export const SQL_NO_DATA = 100;
export const SQL_ERROR = -1;

export const SQL_NTS = -3;
/** Length/indicator values (SQLLEN). */
export const SQL_NULL_DATA = -1n;
export const SQL_NO_TOTAL = -4n;

// Handle types
export const SQL_HANDLE_ENV = 1;
export const SQL_HANDLE_DBC = 2;
export const SQL_HANDLE_STMT = 3;

// Attributes (integer values are passed in the pointer argument)
export const SQL_ATTR_ODBC_VERSION = 200;
// 3.8 is required for driver-specific C types (SQL_C_SS_TIME2, SQL_C_SS_TIMESTAMPOFFSET).
export const SQL_OV_ODBC3_80 = 380n;
export const SQL_ATTR_AUTOCOMMIT = 102;
export const SQL_AUTOCOMMIT_OFF = 0n;
export const SQL_AUTOCOMMIT_ON = 1n;
export const SQL_ATTR_LOGIN_TIMEOUT = 103;
export const SQL_ATTR_TXN_ISOLATION = 108;
export const SQL_IS_UINTEGER = -5;
export const SQL_IS_POINTER = -4;
export const SQL_ATTR_QUERY_TIMEOUT = 0;
export const SQL_ATTR_ROW_BIND_TYPE = 5;
export const SQL_BIND_BY_COLUMN = 0n;
export const SQL_ATTR_ROWS_FETCHED_PTR = 26;
export const SQL_ATTR_ROW_ARRAY_SIZE = 27;

// Isolation levels
export const SQL_TXN_READ_UNCOMMITTED = 1n;
export const SQL_TXN_READ_COMMITTED = 2n;
export const SQL_TXN_REPEATABLE_READ = 4n;
export const SQL_TXN_SERIALIZABLE = 8n;
export const SQL_TXN_SS_SNAPSHOT = 32n;

// SQLEndTran
export const SQL_COMMIT = 0;
export const SQL_ROLLBACK = 1;

// SQLFreeStmt
export const SQL_CLOSE = 0;
export const SQL_UNBIND = 2;
export const SQL_RESET_PARAMS = 3;

// SQLDrivers
export const SQL_FETCH_NEXT = 1;
export const SQL_FETCH_FIRST = 2;

export const SQL_DRIVER_NOPROMPT = 0;
export const SQL_PARAM_INPUT = 1;
export const SQL_DESC_TYPE_NAME = 14;

// SQL Server specific diagnostic fields
export const SQL_DIAG_SS_SEVERITY = -1151;
export const SQL_DIAG_SS_SRVNAME = -1152;
export const SQL_DIAG_SS_PROCNAME = -1153;
export const SQL_DIAG_SS_LINE = -1154;

// C data types
export const SQL_C_CHAR = 1;
export const SQL_C_DOUBLE = 8;
export const SQL_C_BINARY = -2;
export const SQL_C_BIT = -7;
export const SQL_C_WCHAR = -8;
export const SQL_C_SLONG = -16;
export const SQL_C_SBIGINT = -25;
export const SQL_C_TYPE_DATE = 91;
export const SQL_C_TYPE_TIMESTAMP = 93;
export const SQL_C_SS_TIME2 = 0x4000;
export const SQL_C_SS_TIMESTAMPOFFSET = 0x4001;

// SQL data types
export const SQL_CHAR = 1;
export const SQL_NUMERIC = 2;
export const SQL_DECIMAL = 3;
export const SQL_INTEGER = 4;
export const SQL_SMALLINT = 5;
export const SQL_FLOAT = 6;
export const SQL_REAL = 7;
export const SQL_DOUBLE = 8;
export const SQL_VARCHAR = 12;
export const SQL_TYPE_DATE = 91;
export const SQL_TYPE_TIME = 92;
export const SQL_TYPE_TIMESTAMP = 93;
export const SQL_LONGVARCHAR = -1;
export const SQL_BINARY = -2;
export const SQL_VARBINARY = -3;
export const SQL_LONGVARBINARY = -4;
export const SQL_BIGINT = -5;
export const SQL_TINYINT = -6;
export const SQL_BIT = -7;
export const SQL_WCHAR = -8;
export const SQL_WVARCHAR = -9;
export const SQL_WLONGVARCHAR = -10;
export const SQL_GUID = -11;
export const SQL_SS_VARIANT = -150;
export const SQL_SS_UDT = -151;
export const SQL_SS_XML = -152;
export const SQL_SS_TIME2 = -154;
export const SQL_SS_TIMESTAMPOFFSET = -155;

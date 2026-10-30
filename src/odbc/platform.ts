// platform.ts - where the ODBC driver manager lives on each supported platform.
// Only Windows is supported for now; unixODBC (libodbc.so.2, 2-byte SQLWCHAR) slots in here later.

export interface PlatformInfo {
  /** Library passed to dlopen. */
  library: string;
}

const PLATFORMS: Partial<Record<NodeJS.Platform, PlatformInfo>> = {
  win32: { library: 'odbc32.dll' },
};

const ARCHES: ReadonlySet<string> = new Set(['x64', 'arm64']);

/** Returns the platform description, or throws if this platform/arch is unsupported. */
export function currentPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformInfo {
  const info = PLATFORMS[platform];
  if (!info) throw new Error(`mssql-ffi: unsupported platform '${platform}' (supported: win32)`);
  // Handles and SQLLEN are read as 64-bit values throughout.
  if (!ARCHES.has(arch))
    throw new Error(`mssql-ffi: unsupported architecture '${arch}' (64-bit only)`);
  return info;
}

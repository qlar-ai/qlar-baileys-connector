import * as path from 'path'

// Where session.json / wa_session/ live. Inside a pkg-built binary,
// process.execPath correctly points at the exe itself, so data always lands
// next to it no matter what directory the user launched it from. In dev
// (ts-node-dev) execPath points at the system node.exe instead, so fall back
// to cwd there.
export const APP_DIR = (process as { pkg?: unknown }).pkg ? path.dirname(process.execPath) : process.cwd()

import { Layer } from "effect";
import { DbProvider, type ExecutorDbHandle } from "@executor-js/api/server";
import type { SqliteFumaDb } from "./sqlite-fuma-store";
export {
  createSqliteFumaDb,
  type SqliteFumaDb,
  type CreateSqliteFumaDbOptions,
} from "./sqlite-fuma-store";

// Shared DbProvider seam (P2a). Local builds its libSQL handle once at boot
// (driver-open + WAL PRAGMA + the SQL-loop schema bring-up above stay here) and
// then re-exposes it under the shared `DbProvider` tag. The handle's lifecycle
// is owned by the caller's acquireRelease, so this projection's `close` is a
// no-op to avoid double-closing the connection.
export const localDbProviderLayer = (handle: SqliteFumaDb): Layer.Layer<DbProvider> =>
  Layer.succeed(DbProvider)({
    db: handle.db,
    fuma: handle.fuma,
    close: async () => {},
  } satisfies ExecutorDbHandle);

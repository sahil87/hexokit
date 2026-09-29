// Side-effect module: runs the legacy localStorage copy at evaluation time.
// main.tsx imports it FIRST — ESM evaluates imports in source order, so this
// body runs before the router chain (app.tsx → quake-terminal →
// compose-draft-store), which hydrates from localStorage at module scope.
// Keep this module's import graph free of app modules, or they would evaluate
// before the copy.
import { migrateLegacyStorageKeys } from "./legacy-storage-migration";

migrateLegacyStorageKeys();

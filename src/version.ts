// Package version is read from the single package metadata source.
export const PACKAGE_VERSION: string = (
  require("../package.json") as { version: string }
).version;
export const CODEX_COMMIT = "55c099a142eb302188fee00ab9e9062f2db1c359";

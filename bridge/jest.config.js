// Jest runs the TypeScript tests as native ESM (hence --experimental-vm-modules in
// `npm test`). @swc/jest only strips types; `tsc` does the type checking.
/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.ts$": [
      "@swc/jest",
      { jsc: { parser: { syntax: "typescript" }, target: "es2023" }, module: { type: "es6" } },
    ],
  },
  // Sources import siblings as ./x.js (nodenext); point Jest at the .ts file.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
};

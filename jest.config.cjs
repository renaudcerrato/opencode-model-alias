module.exports = {
  testEnvironment: "node",
  moduleNameMapper: {
    "^@opencode-ai/plugin$": "<rootDir>/node_modules/@opencode-ai/plugin/dist/index.js",
  },
  transformIgnorePatterns: ["/node_modules/(?!(@opencode-ai/plugin|zod)/)"],
  setupFiles: ["<rootDir>/tests/setup.cjs"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
      },
    ],
    ".*/@opencode-ai/plugin/dist/.*.js$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.tool-js.json",
      },
    ],
  },
  collectCoverageFrom: ["src/**/*.ts"],
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
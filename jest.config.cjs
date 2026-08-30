module.exports = {
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@opentui/solid/jsx-runtime$": "<rootDir>/tests/jsx-runtime-stub.cjs",
    "^@opentui/solid/jsx-dev-runtime$": "<rootDir>/tests/jsx-runtime-stub.cjs",
  },
  setupFiles: ["<rootDir>/tests/setup.cjs"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/tui.tsx"],
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
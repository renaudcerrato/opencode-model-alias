module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/setup.cjs"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
  collectCoverageFrom: ["src/**/*.ts"],
};

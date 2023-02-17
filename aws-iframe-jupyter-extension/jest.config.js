module.exports = {
  collectCoverage: true,
  coverageReporters: ["lcov", "text", "text-summary"],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  restoreMocks: true,
  setupFiles: ["<rootDir>/tests/setup.js"],
  transform: {
    "^.+\\.ts$": "ts-jest",
    "^.+\\.js$": "babel-jest",
    "^.+\\.svg$": "<rootDir>/tests/transform.js",
  },
  testRegex: "\\.test\\.ts?$",
  transformIgnorePatterns: ["/node_modules/(?!@jupyterlab)"],
};

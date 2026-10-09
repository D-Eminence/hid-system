module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'], rootDir: '.', testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  setupFiles: ['reflect-metadata'], collectCoverageFrom: ['src/**/*.{ts,js}', '!src/main.ts'],
  coverageDirectory: 'coverage', testEnvironment: 'node',
};

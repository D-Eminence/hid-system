module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'], rootDir: '.', testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: ['src/**/*.{ts,js}', '!src/main.ts'],
  coverageDirectory: 'coverage', testEnvironment: 'node',
};

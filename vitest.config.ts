export default {
  test: {
    include: ['**/*.vitest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/**'],
    environment: 'node',
    globals: true,
  },
};

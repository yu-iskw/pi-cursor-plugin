import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@yu-iskw/pi-cursor-plugin',
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**'],
  },
});

import { defineConfig } from "vitest/config"

export const testConfig = defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
})

export { testConfig as default }

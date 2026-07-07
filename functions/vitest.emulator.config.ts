import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.emulator.test.ts"],
    // Emulator round-trips are slower than the pure-math suite; give them room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // All emulator test files share one Firestore emulator and wipe it in
    // beforeEach — parallel files would clobber each other's state.
    fileParallelism: false,
  },
});

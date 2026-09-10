import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:'lease-preview/preview.spec.ts',
  timeout:30_000,workers:1,retries:0,
  use:{screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],
});

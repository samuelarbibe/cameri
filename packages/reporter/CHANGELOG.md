# @camerihq/playwright-reporter

## 0.1.0

### Minor Changes

- 6ce256b: First published release.
  
  The reporter streams Playwright results to a cameri server as the run happens —
  live shard progress, per-attempt steps, errors and attachments — and closes the
  run when the last shard reports in. The CLI resolves the reporting environment
  once per shard and injects it, and `cameri info` prints what it detected when CI
  disagrees with you.

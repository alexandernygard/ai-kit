# @alexandernygard/ai-kit

## 0.2.0

### Minor Changes

- ea9d92e: Stop tool calls from spinning forever after a run dies. Runs now hold a lease on their session (`runLeaseMs`, default 15 seconds); once it lapses, loading the session ends the run, fails its unfinished tool calls as "Interrupted." and marks the message `aborted`. `Chat` treats a stream that closes without `run-finish` as a drop, and if reconnecting fails it checks the session until the run is gone (`lostRunTimeoutMs`). `isToolActive(t, message)` returns false once the message has stopped streaming.

## 0.1.1

### Patch Changes

- a5f234b: `kit.generate` infers `output`'s type from the schema you pass, and `RunResult` takes the output type as a parameter.

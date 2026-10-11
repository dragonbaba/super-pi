# T07.1: image resize worker responses

## Design gate

Baseline: `215280db9b38fc2d5b093d77957978bc85c2b5dd`, Windows x64,
Node 26.4.0. The parent accepts any object and listens for only one message.
An unrelated Node worker message arriving first therefore resolves `null` and
terminates image processing. A missing result is not an explicit null result.

Reproduce through the public `resizeImage` function with a small PNG and an
intercepted `Worker.postMessage`: deliver unrelated messages before forwarding
the real request to the real worker. Keep the caller's input intact and observe
the actual worker result, exit and listeners.

Audited chain:

- CLI `processFileArguments`, the image branch of `createReadToolDefinition`,
  and `AgentSession`'s final tool-result hook / `normalizeToolResultImages`
  call `processImage` once during image preparation.
- `processImage` normalizes the format, then calls `resizeImage` /
  `resizeImageInWorker`. The parent transfers one existing owned byte copy.
- `image-resize-worker` calls `resizeImageInProcess`; Photon decoding,
  orientation, resizing and encoding stay in that worker. Photon image handles
  are freed by the core's existing `finally` blocks.
- The parent receives one typed success (including explicit null) or error,
  waits for termination, then releases its listeners before returning. Runtime
  errors, early exits and synchronous post failures retain existing fallback
  behavior. The fallback starts only after worker cleanup.
- `read` cancellation already rejects its outer operation and discards the
  eventual image result. The resize API has no AbortSignal: this task does not
  invent a cancellation API or claim immediate cancellation of WASM work.

Scope is the one-shot worker protocol/lifecycle. It does not change provider
deltas, progress delivery, interactive updates, rendering, image caches or
terminal writes. The message callback is created once per worker; ignored
messages require only constant-time field checks and retain nothing. Validation
does not scan/copy/decode base64. No new cache, pool, queue, timer or controller.
One worker, one transfer copy and one response envelope remain per attempt;
the existing termination promise will be awaited rather than detached. The
exclusive worker owner releases listeners after termination on every exit path.

Use focused protocol/lifecycle regressions, typecheck and the affected package
build locally. Required Linux/Windows full-suite CI remains the repository's
single validation chain. No unrelated allocation benchmark is evidence for
this non-rendering operation boundary.

## Validation

The baseline regression failed with `actual: null` at the assertion that extra
messages must not omit the image. The candidate passes all eight cases in
`tests/image-resize-worker.test.ts`:

- Unrelated messages and malformed tagged payloads precede a real 8x4 PNG
  resize to 4x2; the returned value matches the actual tagged worker response,
  and caller bytes are unchanged.
- Explicit null remains null. Typed errors (including an empty error string),
  worker errors, early exit and synchronous post failures preserve fallback;
  late success cannot overwrite an error.
- The real worker emits a tagged error for an invalid request.
- An actual `read` cancellation rejects once; after releasing the gated request,
  the real worker exits and the discarded image cannot complete that read again.

Seven parent-operation fixtures each observe exactly one worker exit,
`threadId === -1` and zero `message`, `error` and `exit` listeners. The direct
worker protocol fixture also awaits its worker termination in `finally`.
No file fixtures, servers or detached processes are created. Test-owned worker
references and prototype mocks are released by the test runner.

Executed locally:

```text
node --experimental-strip-types --test --test-name-pattern 'resize ignores' tests/image-resize-worker.test.ts
  baseline: failed as expected (image incorrectly null)
node --experimental-strip-types --test tests/image-resize-worker.test.ts
  final test file: 8 passed, 0 failed
npm.cmd run check
  passed after the final test changes
npm.cmd run build --workspace @super-pi/coding-agent
  passed; production sources unchanged afterward
```

No full local suite or unrelated hot-path benchmark was repeated. Linux and
Node 22.19 validation are delegated to the required PR CI. Bun compiled layouts
and real terminals were not exercised; T07.2/T07.3 remain separate tasks.
The existing in-process fallback remains only for worker failures; ignored
messages do not trigger it. The resize API still has no timeout or abort input.

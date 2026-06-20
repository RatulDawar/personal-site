---
title: "Cache Padding & False Sharing"
description: "How 56 bytes of padding turned a 749ms benchmark into 163ms — the hidden cost of cache-line ping-pong."
date: 2026-02-28
tag: "CPU"
---

Two threads, each incrementing their own counter. Should be embarrassingly parallel, right?

Wrong. Without cache-line padding, both counters lived on the same 64-byte cache line. Every increment caused the cores to invalidate each other's caches — **false sharing**.

## The fix

```rust
struct PaddedCounter {
    value: AtomicU64,
    _pad: [u8; 56],
}
```

56 bytes of padding pushed each counter onto its own cache line. Runtime dropped from **749ms to 163ms** — a 4.6× speedup from layout alone.

## The takeaway

Before reaching for atomics, SIMD, or a new algorithm, check your memory layout. The hardware doesn't care about your logical separation if the bytes sit side by side.

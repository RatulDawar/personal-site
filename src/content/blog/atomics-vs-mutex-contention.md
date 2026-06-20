---
title: "Atomics vs Mutex in Rust: Why Mutex Won Under Heavy Contention"
date: 2026-03-04
description: "Why a mutex beat atomics under heavy contention — with flamegraphs and a counterintuitive takeaway."
tag: "Concurrency"
---

What if I told you a mutex beat atomics in a tight shared-counter benchmark?

That happened in my Rust experiment when I compared:

- `AtomicU64::fetch_add`
- `Mutex<u64>`

At low thread counts, atomics were clearly faster. At high contention, mutex pulled ahead.

## The Benchmark Setup

I benchmarked a single shared counter with Criterion:

- Threads: 2, 4, 8
- Increments per thread: 200,000 and 1,000,000 (plus extra 5,000,000 checks)
- Workload: each thread repeatedly increments the same shared counter

The code is intentionally simple and contention-heavy.

## The Performance Data

Here are the main results (Criterion midpoint):

| Increments/thread | Threads | Atomic | Mutex | Winner |
|-------------------|---------|--------|-------|--------|
| 200,000 | 2 | 1.44 ms | 7.15 ms | Atomic (~4.98x) |
| 200,000 | 4 | 6.40 ms | 11.65 ms | Atomic (~1.82x) |
| 200,000 | 8 | 25.75 ms | 19.18 ms | Mutex (~1.34x) |
| 1,000,000 | 2 | 7.63 ms | 45.83 ms | Atomic (~6.00x) |
| 1,000,000 | 4 | 35.21 ms | 60.59 ms | Atomic (~1.72x) |
| 1,000,000 | 8 | 133.23 ms | 97.88 ms | Mutex (~1.36x) |

I also reran only 2-thread cases with larger input sizes:

- 200k/thread: atomic ~10.7x faster
- 1M/thread: atomic ~6.2x faster
- 5M/thread: atomic ~3.5x faster

So lower contention strongly favors atomic.

## The Counterintuitive Part

If atomics are "lighter" than mutexes, why does mutex win at 8 threads here?

Because this benchmark is not measuring lock overhead in isolation.

It is measuring **contention on one shared cache line**.

## What Actually Happens in the CPU

### Atomic path (`fetch_add`)

Even if your code only updates and never explicitly reads, `fetch_add` is still a hardware read-modify-write operation.

That means the core needs exclusive ownership of the cache line before updating.

With many threads on one shared counter:

- cache-line ownership keeps moving between cores
- coherence traffic increases sharply
- the atomic instruction becomes the bottleneck

This is cache-line ping-pong (line handoff).

### Mutex path

Mutex still contends, but lock arbitration changes behavior:

- threads do not all hammer the same line at full speed simultaneously
- some contenders spin/park/wake
- coherence pressure can be lower than naive atomic hot-loop contention

So under very high contention, mutex can be less bad than a single shared atomic increment loop.

## Profiling Evidence

I profiled the `1M x 8 threads` case with Linux `perf` and flamegraphs.

### Atomic flamegraph

The hotspot was dominated by:

- `__aarch64_ldadd8_relax`

That is the atomic RMW instruction itself, matching the "contended atomic" hypothesis.

![Atomic flamegraph (1M x 8 threads)](/assets/atomic-1m-8t.svg)

### Mutex flamegraph

Time was spread across lock paths:

- `Mutex::lock_contended`
- CAS/SWAP primitives
- futex/syscall paths

So atomic cost was concentrated in one heavily contended instruction; mutex cost was distributed across lock arbitration.

![Mutex flamegraph (1M x 8 threads)](/assets/mutex-1m-8t.svg)

## Difference: Atomics vs Mutex Lock

Both are synchronization tools, but they solve different problems.

| Aspect | Atomics | Mutex Lock |
|--------|---------|------------|
| Scope | Single value / primitive operations | Critical section over one or more shared values |
| Blocking behavior | No lock acquisition API; operation executes atomically | Can block/wait when lock is contended (spin/park/wake) |
| Low-contention cost | Usually lower overhead | Usually higher overhead per operation |
| High-contention behavior | Can bottleneck badly on one hot location (cache-line ping-pong) | Can sometimes outperform naive atomics by arbitration/serialization |
| Correctness model | Harder for multi-step state transitions | Easier for compound shared-state updates |
| Typical use | Counters, flags, state bits, lock-free primitives | Multi-step shared data mutations requiring mutual exclusion |
| Rule of thumb | Use for simple independent state changes | Use when correctness needs compound updates |

## Practical Takeaways

1. Atomics are not automatically faster under all contention levels.
2. A single global atomic counter can scale poorly with many writers.
3. Mutex can outperform naive atomics in highly contended single-counter patterns.
4. The best optimization is often reducing contention, not changing one primitive to another.

## Better Designs for Production

If your workload looks like this benchmark, these patterns usually help more:

- per-thread local counters + final reduce
- sharded atomics (N counters) + sum
- batched updates (local accumulation, occasional global flush)
- avoid one global hot counter on critical paths

## Run It Yourself

Code is available here:

**🔗 [github.com/RatulDawar/rust-experiments](https://github.com/RatulDawar/rust-experiments)**

The benchmark crate used here is `atomics-vs-mutex`.

## The Bottom Line

The real question is not just:

> atomics vs mutex?

The real question is:

> how much shared cache-line contention does this design create?

Under low contention, atomics shine.

Under heavy contention on one shared location, mutex can win.

---
title: "The Hidden Performance Killer: How 56 Bytes of Padding Made My Rust Code 4.6x Faster"
date: 2026-02-28
description: "How 56 bytes of padding turned a 749ms benchmark into 163ms — the hidden cost of cache-line false sharing."
tag: "CPU"
---

What if I told you that adding 112 bytes of "wasted" memory could make your code run 4.6 times faster?

That's exactly what happened when I stumbled upon one of the most counterintuitive performance problems in concurrent programming: **false sharing**.

## The Innocent Code That Ran Slow

I was benchmarking a simple concurrent counter in Rust. Two threads, each incrementing their own atomic variable 100 million times:

```rust
pub struct Counters {
    pub counter1: AtomicU64,
    pub counter2: AtomicU64,
}
```

Thread 1 increments counter1. Thread 2 increments counter2. They're completely separate variables, so they shouldn't interfere with each other.

Right?

This took **749 milliseconds** to complete.

Then I changed exactly one thing and it dropped to **163 milliseconds**.

What did I change? I added some empty space.

## The Fix That Makes No Sense

```rust
#[repr(C, align(64))]
pub struct PaddedCounters {
    pub counter1: AtomicU64,
    _pad1: [u8; 56],          // ← 56 bytes of "nothing"
    pub counter2: AtomicU64,
    _pad2: [u8; 56],          // ← 56 more bytes of "nothing"
}
```

I added 112 bytes of padding that serves no purpose except to push the counters apart in memory.

And somehow, the code got 4.6x faster.

## What's Actually Happening

Here's the thing about CPUs that most programmers don't think about: they don't read memory one byte at a time.

Instead, they load entire **cache lines** — typically 64 bytes at once.

My AtomicU64 counters are 8 bytes each. When the CPU loads counter1 into its cache, it also grabs counter2 because they're both in the same 64-byte chunk.

Now watch what happens:

**Step 1:** Thread 1 (on CPU Core 1) writes to counter1

**Step 2:** The entire 64-byte cache line containing both counters is marked as "modified" on Core 1

**Step 3:** Thread 2 (on CPU Core 2) tries to read counter2

**Step 4:** Core 2's cached copy is now invalid (because Core 1 modified the cache line), so it must reload the entire line from Core 1

**Step 5:** Thread 2 writes to counter2

**Step 6:** Now Core 1's cache is invalidated

**Step 7:** Thread 1 needs to reload the cache line from Core 2

Repeat this 100 million times.

The two threads are playing an expensive game of cache-line ping-pong, even though they're working on completely separate variables.

This is **false sharing** — they're not actually sharing data, but the CPU's cache system treats them like they are.

## Proving It With Math

Let me show you the actual memory addresses. I added code to print where each counter lives:

```rust
fn cache_line_number(addr: usize) -> usize {
    addr / 64
}

let unpadded = UnpaddedCounters::new();
let c1_addr = &unpadded.counter1 as *const _ as usize;
let c2_addr = &unpadded.counter2 as *const _ as usize;

println!("counter1 at 0x{:x} → cache line #{}", c1_addr, c1_addr / 64);
println!("counter2 at 0x{:x} → cache line #{}", c2_addr, c2_addr / 64);
```

**Output:**

```
UnpaddedCounters:
  counter1 at 0x16db6a1f0 → cache line #95869575
  counter2 at 0x16db6a1f8 → cache line #95869575
  Distance: 8 bytes
  ✗ SAME cache line!

PaddedCounters:
  counter1 at 0x16db6a200 → cache line #95869576
  counter2 at 0x16db6a240 → cache line #95869577
  Distance: 64 bytes
  ✓ DIFFERENT cache lines!
```

The addresses don't lie. Without padding, both counters share cache line #95869575. With padding, they're on separate lines.

## The Performance Data

I ran each version 3 times with 100 million atomic operations:

| Version | Run 1 | Run 2 | Run 3 | Average | Speedup |
|---------|-------|-------|-------|---------|---------|
| **Unpadded (False Sharing)** | 803ms | 733ms | 719ms | **752ms** | 1.0x |
| **Padded (No False Sharing)** | 169ms | 167ms | 164ms | **167ms** | **4.5x** |

**Result: 4.5x faster with padding**

But I wanted to go deeper. I wanted to see the actual cache misses.

## Measuring the Invisible

On macOS, I used Instruments with the CPU Counters profiling template. It samples hardware performance counters and records cache coherency events.

I profiled both versions and extracted the raw counter data:

| Version | Cache Coherency Samples | Difference |
|---------|-------------------------|------------|
| **Unpadded** | 238,430 samples | 289x more |
| **Padded** | 824 samples | baseline |

That's **289 times more cache coherency events** in the unpadded version.

Each of those events represents the CPU stalling, waiting for cache lines to be synchronized between cores. That's why the unpadded version is so slow.

## The Visualization

Here's what's happening inside your CPU:

**Without Padding:**

```
CACHE LINE (64 bytes):
┌───────────────────────────────────────────┐
│ counter1 │ counter2 │ unused space       │
│  (8B)    │  (8B)    │  (48B)             │
└───────────────────────────────────────────┘
     ↑           ↑
  Thread 1   Thread 2

Thread 1 writes → entire line invalidated on Core 2
Thread 2 reads  → cache miss, must reload
Thread 2 writes → entire line invalidated on Core 1
Thread 1 reads  → cache miss, must reload
(repeat 100 million times = 289,000 cache events)
```

**With Padding:**

```
CACHE LINE 1 (64 bytes):     CACHE LINE 2 (64 bytes):
┌─────────────────────────┐  ┌─────────────────────────┐
│ counter1 │ padding      │  │ counter2 │ padding      │
│  (8B)    │  (56B)       │  │  (8B)    │  (56B)       │
└─────────────────────────┘  └─────────────────────────┘
     ↑                            ↑
  Thread 1                    Thread 2

Thread 1 writes → Core 2 unaffected
Thread 2 writes → Core 1 unaffected
(no cache invalidations = 824 cache events)
```

Each counter has its own cache line. The threads can work independently without invalidating each other's cache.

## When Should You Care?

False sharing only matters in specific scenarios:

✓ Multiple threads accessing different variables  
✓ Variables are close together in memory (< 64 bytes apart)  
✓ At least one thread is writing frequently  
✓ You're in a performance-critical hot path

**Real-world examples:**
- Per-thread counters in concurrent data structures
- Statistics tracking in thread pools
- Producer/consumer indices in lock-free queues
- Per-CPU data in high-performance servers

## How to Detect It

**Warning Sign #1:** Adding more threads makes code slower instead of faster

**Warning Sign #2:** High CPU usage but low throughput

**Warning Sign #3:** Threads are constantly context-switching

**To confirm:** Print memory addresses and check if frequently-modified variables share cache lines (within 64 bytes).

## The Cost-Benefit Analysis

**Cost:**
- 112 bytes of memory per struct
- Two lines of padding code

**Benefit:**
- 4.6x performance improvement
- 289x fewer cache coherency events
- Eliminated ~237 million cache misses

In high-performance concurrent code, this is basically free money.

## Run the Benchmark Yourself

Want to reproduce these results? The complete code is available on GitHub:

**🔗 [github.com/RatulDawar/rust-experiments](https://github.com/RatulDawar/rust-experiments)**

```bash
git clone https://github.com/RatulDawar/rust-experiments
cd rust-experiments
cargo run --release -p cache-padding --bin demo
```

The demo will show you:
- Memory addresses and cache line calculations
- Performance comparison (unpadded vs padded)
- Real-time benchmark results

## The Results Table

Here's the complete comparison:

| Metric | Unpadded | Padded | Improvement |
|--------|----------|--------|-------------|
| **Execution Time** | 752ms | 167ms | **4.5x faster** |
| **Cache Line Distance** | 8 bytes | 64 bytes | Separate lines |
| **Cache Coherency Events** | 238,430 | 824 | **289x fewer** |
| **Memory Cost** | 16 bytes | 128 bytes | +112 bytes |

## Why This Matters

False sharing is one of those problems that:

- Doesn't show up in your source code
- Doesn't trigger compiler warnings
- Only appears under concurrent load
- Can kill performance without any obvious cause

And most frustrating of all: **the more CPU cores you have, the worse it gets.**

## Key Takeaways

1. CPU cache lines are 64 bytes, not 1 byte

2. When one thread writes to memory, the entire cache line is invalidated on other cores

3. If two threads access variables in the same cache line, they fight for cache ownership

4. The fix is simple: pad structures so each thread's data is on its own cache line

5. The performance gain can be massive (4-5x in this example)

## Real-World Applications

This isn't just academic. False sharing appears in:

**Thread pools** — per-worker job counts

**Concurrent hash maps** — per-bucket lock states  

**Lock-free queues** — producer/consumer indices

**Game engines** — per-system frame counters

**Databases** — per-connection statistics

Rust's standard library doesn't automatically pad for you. When performance matters, you need to do it explicitly.

## The Bottom Line

Cache lines are invisible in your code but very real in your hardware.

When multiple threads access data that happens to share a cache line, your CPU cores spend more time shuffling cache lines between each other than doing actual work.

56 bytes of padding costs you nothing and buys you 4x performance.

Sometimes the best optimization is just giving your data some space to breathe.

---

*Have you encountered false sharing in your code? How did you identify it? Let me know in the comments below.*

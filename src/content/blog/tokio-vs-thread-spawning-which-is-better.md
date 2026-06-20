---
title: "Async Runtimes vs Threads in Rust: Which Is Better, and When?"
date: 2026-03-10
description: "Tokio wins on tiny and waiting-heavy workloads; threads catch up on pure CPU. A measured guide to when each model fits."
tag: "Async"
---

What if I told you Tokio beat `std::thread::spawn` by about **34x** when the work was tiny, but that advantage mostly disappeared once the workload became pure CPU?

That is exactly what I measured in a new Rust experiment comparing:

- `std::thread::spawn`
- `tokio::spawn`
- `tokio::task::spawn_blocking` for the CPU-bound case

The short version:

- Tokio was dramatically better at spawning lots of lightweight units of work.
- Tokio was clearly better when the work mostly waited.
- For CPU-bound work, plain `tokio::spawn` was actually the slowest option in this experiment.

So the real answer is not "Tokio or threads?"

It is:

> is this workload mostly waiting, or mostly burning CPU?

## The Benchmark Setup

I built a new crate called `tokio-vs-thread-spawning` and ran it on this machine:

- Apple M4 Pro
- 12 CPU cores (8 performance + 4 efficiency)
- 24 GB RAM
- Rust 1.93.1
- Tokio 1.50.0

The Tokio runtime was configured with `worker_threads = 12`, matching available parallelism.

Each scenario ran **5 times**, and I report the **median** time.

I tested three scenarios:

1. **Spawn overhead**: create 1,000 units, return a task id, and exit
2. **Mostly waiting**: create 1,000 units, wait 10 ms, and exit
3. **CPU-bound**: create 24 units, run a compute loop for 20,000,000 rounds, and never yield

This is the key part of the implementation:

```rust
for task_id in 0..task_count {
    set.spawn(async move {
        tokio::time::sleep(sleep).await;
        task_id
    });
}
```

And the thread version:

```rust
for task_id in 0..task_count {
    handles.push(std::thread::spawn(move || {
        std::thread::sleep(sleep);
        task_id
    }));
}
```

For the CPU test, the async task intentionally did **not** call `.await`:

```rust
for task_id in 0..task_count {
    set.spawn(async move { cpu_burn(iterations, task_id as u64) });
}
```

That matters a lot, because a non-yielding CPU task can occupy a Tokio worker thread until it finishes.

## The Results

| Scenario | Workload | std::thread::spawn | tokio::spawn | tokio::task::spawn_blocking | Winner |
|---------|----------|--------------------|--------------|-----------------------------|--------|
| Spawn overhead | 1,000 no-op units | 14.24 ms | 0.42 ms | N/A | `tokio::spawn` |
| Mostly waiting | 1,000 units, 10 ms wait | 27.07 ms | 14.39 ms | N/A | `tokio::spawn` |
| CPU-bound | 24 units, 20M rounds each | 91.75 ms | 99.58 ms | 91.28 ms | `spawn_blocking` / threads |

If you convert those medians into relative speed:

- Tokio spawn was about **34x faster** than OS thread spawning for tiny units of work
- Tokio spawn was about **1.88x faster** for the waiting-heavy case
- In the CPU-bound case, plain `tokio::spawn` was about **9% slower** than `spawn_blocking`

## Why Tokio Crushes Raw Spawn Overhead

This result was the least surprising and still the most dramatic:

| Case | Median |
|------|--------|
| `std::thread::spawn` | 14.24 ms |
| `tokio::spawn` | 0.42 ms |

An OS thread is expensive. It needs kernel scheduling, a stack, and significantly more setup than a Tokio task.

A Tokio task is much smaller. The runtime schedules it onto a fixed worker pool instead of asking the OS for a brand-new thread per unit of work.

That is why Tokio looks so strong when each unit does almost nothing.

If your application fans out huge numbers of tiny tasks, spawning one OS thread per task is simply the wrong cost model.

## Why Tokio Also Wins for Mostly-Waiting Work

The waiting test was:

- 1,000 spawned units
- each unit waited for 10 ms
- then returned

Results:

| Case | Median |
|------|--------|
| `std::thread::spawn` + `sleep` | 27.07 ms |
| `tokio::spawn` + `tokio::time::sleep` | 14.39 ms |

Tokio won because waiting is where async runtimes shine.

When an async task hits `.await`, it yields control and lets the runtime schedule other ready tasks. You do not need 1,000 OS threads to manage 1,000 waiting operations.

That is the core async value proposition:

- lots of concurrent tasks
- most of them are waiting on timers, sockets, or I/O
- only a small subset is actively executing at any one moment

This benchmark used timers rather than real network I/O, but the shape is the same: **waiting-heavy concurrency favors Tokio**.

## Why Plain `tokio::spawn` Is Not a CPU-Work Cheat Code

The CPU-bound scenario changed the story:

| Case | Median |
|------|--------|
| `std::thread::spawn` | 91.75 ms |
| `tokio::spawn` | 99.58 ms |
| `tokio::task::spawn_blocking` | 91.28 ms |

This time, plain `tokio::spawn` was the slowest option.

Why?

Because these tasks never yielded.

In the CPU benchmark, each spawned future immediately entered a tight compute loop and stayed there until completion. That means Tokio was no longer multiplexing many waiting tasks efficiently. It was just running CPU work on its worker threads.

That is not what async runtimes are best at.

`spawn_blocking` performed better because it uses Tokio's blocking pool, which is designed for work that should not occupy the core async worker threads.

The interesting part is that `spawn_blocking` and `std::thread::spawn` were basically tied here:

- `spawn_blocking`: 91.28 ms
- thread spawn: 91.75 ms

So the async advantage disappeared once the workload stopped waiting and started burning CPU continuously.

## Which Should You Use?

Here is the practical version.

| Workload | Prefer |
|----------|--------|
| Thousands of sockets, timers, HTTP requests, or database queries | `tokio::spawn` |
| Large fan-out where tasks spend most of their time waiting | `tokio::spawn` |
| CPU-heavy jobs with little or no `.await` | dedicated threads, a thread pool, Rayon, or `tokio::task::spawn_blocking` |
| Blocking code inside a Tokio application | `tokio::task::spawn_blocking` |
| One OS thread per tiny request | usually a bad idea |

The crucial mental model is:

- **Tokio is for concurrency with waiting**
- **threads or blocking pools are for work that occupies a core**

## Important Caveats

This experiment is useful, but it is not universal truth.

A few important limits:

- I compared **raw thread spawning** against Tokio tasks, not against a prebuilt thread pool like Rayon
- the waiting workload used sleeps, not real sockets
- the CPU benchmark used a synthetic compute loop
- the numbers are machine-specific and come from one Apple M4 Pro laptop

So do not overgeneralize the exact milliseconds.

But the qualitative result is robust:

- thread creation is expensive
- async runtimes are great when work waits
- non-yielding CPU work does not magically become better because it runs inside Tokio

## Run It Yourself

Code is available here:

**🔗 [github.com/RatulDawar/rust-experiments](https://github.com/RatulDawar/rust-experiments)**

Experiment crate:

- `tokio-vs-thread-spawning`

Commands:

```bash
cargo run --release -p tokio-vs-thread-spawning
cargo bench -p tokio-vs-thread-spawning
```

## The Bottom Line

If your Rust program needs to handle **lots of concurrent waiting**, Tokio is the better model.

If your work is **CPU-bound and does not yield**, plain `tokio::spawn` is not the right tool. Use `spawn_blocking`, Rayon, or a dedicated thread-based design instead.

So:

- **Tokio wins for high-concurrency waiting workloads**
- **raw thread spawning loses badly on lightweight fan-out**
- **CPU-bound work is where the async advantage fades**

The better question is not:

> Tokio or threads?

It is:

> what kind of work are you scheduling?

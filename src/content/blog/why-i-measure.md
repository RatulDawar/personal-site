---
title: "Why I Measure Before I Optimize"
description: "A short note on building this site and the philosophy behind writing about systems work with real benchmarks."
date: 2026-06-20
tag: "Meta"
featured: true
---

Most performance advice online is vibes. Someone ran one benchmark on one machine, got a surprising result, and wrote a blog post. I've done it too — and I've also been wrong.

This site is where I publish the longer version: what I tried, what the numbers actually said, and what I'd do differently next time.

## The approach

Every post here follows a simple rule:

1. **Start with a question** — not a conclusion
2. **Measure** — flamegraphs, `criterion`, real datasets where possible
3. **Explain the mechanism** — why the numbers look the way they do

## What you'll find here

- Rust experiments with surprising results (mutexes beating atomics, padding beating cleverness)
- DataFusion deep dives — Parquet pruning, string views, planner changes
- Occasional notes on building data platforms at scale

If that sounds like your kind of rabbit hole, [say hello](mailto:ratuldawar11@gmail.com).

---
title: "Inside a DataFusion Parquet Scan: Skipping Page Index I/O When Statistics Already Decide"
date: 2026-06-20
description: "How the Parquet opener prunes at file, row-group, page, and bloom layers — and why PR #22857 stops loading page index metadata when row-group statistics already prove the filter."
tag: "DataFusion"
---

When you run `SELECT * FROM parquet_table WHERE col IS NOT NULL`, DataFusion may still read Parquet page index structures from object storage even though row-group statistics already prove every surviving row group matches the filter. That extra tail I/O buys nothing.

[PR #22857](https://github.com/apache/datafusion/pull/22857) (merged, closes [#22795](https://github.com/apache/datafusion/issues/22795)) reorders the Parquet opener so page index loading happens only when page-level pruning can still help. No query results change — only unnecessary metadata reads disappear.

## Parquet file anatomy

Parquet is columnar. A file stores data pages grouped into row groups, then packs planning metadata in the footer. Scanners typically read the footer first.

![Parquet file layout](/posts/assets/parquet-file-anatomy.svg)

Three structures matter for pruning:

| Structure | Granularity | What it stores | Typical use |
|-----------|-------------|----------------|-------------|
| Row-group statistics | Entire row group | min, max, null count per column | Skip whole row groups |
| ColumnIndex + OffsetIndex (page index) | Individual data pages | min/max/null per page, byte offsets | Skip pages inside a row group |
| Bloom filters | Row group + column | Probabilistic membership | Skip row groups on equality predicates |

Page index is powerful for range filters (`col > 50`) where row-group min/max is too coarse. It is useless when statistics already prove the predicate is true for every row in every surviving row group.

## The complete DataFusion Parquet scan pipeline

Each file in a scan goes through a state machine in `datafusion/datasource-parquet/src/opener/mod.rs`. The opener interleaves cheap CPU pruning with optional metadata I/O before building the Arrow reader stream.

![DataFusion Parquet opener pipeline](/posts/assets/parquet-scan-pipeline.svg)

Stages in order:

1. **PruneFile** — file-level statistics and partition values. Entire files can be skipped before any footer read.
2. **LoadMetadata** — read the Parquet footer (schema, row-group list, row-group statistics).
3. **PrepareFilters** — specialize the physical predicate to the file schema; build row-group and page pruning predicates.
4. **PruneWithStatistics** — evaluate row-group min/max/null counts. Row groups that cannot match are dropped. Surviving groups may be marked **fully matched** when statistics prove every row satisfies the predicate (for example `IS NOT NULL` on a column with zero nulls in that row group).
5. **LoadPageIndex?** — optional extra footer read for ColumnIndex and OffsetIndex.
6. **LoadBloomFilters / PruneWithBloomFilters** — optional bloom-filter I/O and pruning.
7. **BuildStream** — construct `ParquetRecordBatchStream` with the final row-group and page selection, then decode data pages.

Pruning is layered: each stage narrows what the next stage must consider. The expensive part is not the boolean logic — it is the extra object-store reads for page index and bloom filters.

## What page index pruning actually does

Inside a surviving row group, data is split into pages (often a few thousand rows each). ColumnIndex stores per-page min/max/null statistics. OffsetIndex stores where each page lives on disk.

When page index is loaded, `PagePruningAccessPlanFilter` intersects page selections across single-column predicates. If a page's statistics prove the predicate cannot match, that page is skipped during decode.

Row groups marked **fully matched** already skip page pruning work at evaluation time:

```rust
if access_plan.is_fully_matched(row_group_index) {
    // all rows satisfy the predicate — page-level pruning is wasted work
    continue;
}
```

The bug was earlier in the pipeline: page index was loaded **before** row-group statistics pruning ran, so the opener paid for ColumnIndex/OffsetIndex I/O even when every surviving row group would turn out fully matched.

## The optimization

PR #22857 moves `PruneWithStatistics` before `LoadPageIndex` and adds a gate:

```rust
fn should_load_page_index(
    page_pruning_predicate: Option<&Arc<PagePruningAccessPlanFilter>>,
    row_groups: &RowGroupAccessPlanFilter,
) -> bool {
    page_pruning_predicate.is_some_and(|_| {
        let fully_matched = row_groups.is_fully_matched();
        row_groups
            .row_group_indexes()
            .any(|idx| !fully_matched[idx])
    })
}
```

Page index loads only when all of these hold:

- There is a page-pruning predicate (page index is enabled and the filter can use it).
- At least one surviving row group is **not** fully matched by row-group statistics.

Otherwise the opener jumps straight to bloom-filter loading. When the skip happens and page index would have been relevant, DataFusion increments a `page_index_load_skipped` metric.

![Before vs after page index loading](/posts/assets/parquet-page-index-before-after.svg)

### Concrete example: `IS NOT NULL` on a non-null column

Consider a file where column `a` has no nulls in any row group.

| Step | Row-group statistics | Page index needed? |
|------|----------------------|--------------------|
| Predicate | `a IS NOT NULL` | — |
| After statistics pruning | All surviving row groups marked fully matched | No — every page in those groups already satisfies the predicate |
| Before PR #22857 | Page index loaded anyway | Wasted I/O |
| After PR #22857 | `should_load_page_index` returns false | Skipped; metric incremented |

Range predicates like `a > 50` usually leave row groups **not** fully matched, so page index still loads and still prunes individual pages inside coarse row groups.

## Other details in the PR

- **Cached metadata path** — `DFParquetMetadata` honors `PageIndexPolicy::Skip` so cached readers do not eagerly load page index structures.
- **Observability** — `page_index_load_skipped` counter on `ParquetFileMetrics` (registered via a crate-private helper to avoid a semver-breaking public field).
- **Tests** — unit tests for `should_load_page_index`, integration tests for default and cached reader factories, and sqllogictest updates for the new metric.

## How to observe it

Enable DataFusion execution metrics and look for `page_index_load_skipped` on Parquet scan nodes. A non-zero value on queries where row-group statistics fully prove the filter means the opener avoided page index I/O that would not have changed the scan plan.

Integration tests in the PR assert the counter is `1` for a fully-matched `a > 0` scan over a non-null column and `0` when page index is still required (`a > 50` over the same file). I have not published end-to-end latency benchmarks for this change; the win is eliminating redundant metadata reads on object storage, which matters most on remote files and high file-count scans.

## Practical takeaways

1. **Parquet pruning is hierarchical** — file → row group → page → bloom. Each layer has a cost (I/O or CPU). Load metadata only when a cheaper layer leaves uncertainty.
2. **Fully matched row groups are a strong signal** — when statistics prove all rows match, finer-grained indexes cannot prune further.
3. **Correctness unchanged** — this is pure scan planning efficiency. The same rows are read; fewer footer structures are fetched.

## Links

- Merged PR: https://github.com/apache/datafusion/pull/22857
- Issue: https://github.com/apache/datafusion/issues/22795
- Opener state machine: `datafusion/datasource-parquet/src/opener/mod.rs`
- Page pruning: `datafusion/datasource-parquet/src/page_filter.rs`

# Unit-test shards

`shard-manifest.json` freezes the existing unit tasks into 16 baseline shards.
The initial split uses `shard-weights.json`; CI does not rebalance it on discovery
or when weights change. The six integration partitions remain independent tasks.
Gates and smoke checks continue to run separately with `make test-fast-rest`.

Put new test coverage in new `.test.cjs` files rather than growing baseline test
owners. Each discovered task absent from the manifest automatically receives its
own additional shard. Existing shards never gain tasks. This also works for
parallel delivery branches: they can add tests within their approved file scope
without editing a shared manifest or changing their sealed plans.

CI generates its matrix from the baseline plus the new tasks in sorted order.
Shard numbers beyond the baseline may change as new files arrive, but their
contents remain isolated. All discovered tasks run exactly once. Duplicate,
stale or empty manifest assignments fail matrix generation and the aggregate
`test-fast` gate. Removing or renaming a registered test requires updating its
manifest entry explicitly.

To freeze additional shard numbers, optionally run:

```sh
node tests/unit/shard-files.cjs --append
```

This appends one shard per unregistered task without changing existing entries.
It is not required for delivery. With no new tasks, it changes no assignments.

Inspect the effective matrix and verify the distribution with:

```sh
node tests/unit/shard-files.cjs --matrix
node tests/unit/unit-shard.test.cjs
```

To run one shard locally, use its current index and total from `--matrix`:

```sh
UNIT_SHARD=1/16 ./tests/unit/run.sh
```

An unsharded `./tests/unit/run.sh` still runs all discovered tests. The generic
`assign` helper and positional shard-files CLI remain available for exploratory
weight-based splits; CI and the runner use the frozen baseline plus isolated
new tasks.

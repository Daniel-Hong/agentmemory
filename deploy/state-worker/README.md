# Pinned local State worker

This is a local compatibility artifact, **not** an official State release.
`pin.json` records the exact upstream commit/tag and local patch digest. The
upstream tag is `state/v0.22.22`; its Cargo package version is `0.22.21`.
Artifact version `0.22.22-daniel.1` is distinct from that original package version.

The patch retains compact ACK, immutable boot identity/instance aliases,
cooperative file-store lock, and sealed fsync receipt. ACK alone is not durable.
The advisory lock excludes participating patched workers, not older or
uncooperative processes. Seal drains adapter mutations, remains sealed on error,
and must succeed before an app clean-shutdown marker is published.

## Build from source

Requires Git, Python3 (tarfile data filter), Rust >=1.89, Node22+, pnpm10.32.1 and
cached Cargo/pnpm dependencies, or explicit `--online` for official registries.
No system toolchain or production service is changed by the builder.

```sh
git clone https://github.com/iii-hq/workers workers-source
python3 scripts/state-worker/build.py \
  --workers-source ./workers-source \
  --work-dir ./state-build \
  --output ./state-artifact \
  --jobs 2 --online
```

The builder reads the pinned Git objects, **not** uncommitted source changes,
applies the verified patch, builds the console UI with frozen pnpm lockfile,
and compiles State with locked Cargo dependencies. A marked workspace can be
rebuilt with `--resume` and a new output directory. It records compiler, Node,
pnpm, source archive, Cargo lock and binary digests in `manifest.json`, and emits
a deterministic-layout tar.gz alongside the output. Compiler/platform changes
can change binary bytes; this is reproducible source provenance, not a promise
of cross-toolchain bit-identical builds.

## CLI selection

```sh
export AGENTMEMORY_STATE_WORKER_ARTIFACT="$PWD/state-artifact"
node dist/cli.mjs start
```

Use the directory containing `manifest.json` and `state`. The CLI verifies source
pin, patch digest, target and binary digest, then runs that State binary locally
while keeping the HTTP worker registry-pinned. The normal local-workers override
remains available. Without either override, file-backed Compose refuses early:
official registry State does not provide this custom persistence contract.
Do not edit manifests to relabel another binary as this artifact.

## Container path

`deploy/Dockerfile` builds the same pinned source/patch in its Rust build stage
and copies the artifact into the runtime image. The entrypoint runs
`state-bootstrap.mjs`, which verifies the artifact, selects the local State
worker, and atomically publishes metadata for the actual engine listener owned
by the tracked Compose process tree. App epoch verification still validates the
socket and executable; bootstrap PID metadata alone is not authority.
`STATE_VERSION` is a legacy template input and does not override this artifact.
A native Docker image build/run must be verified separately from host tests.

## Large-overwrite smoke

```sh
node --max-old-space-size=1536 scripts/state-worker/large-overwrite-proof.mjs \
  /path/to/iii ./state-artifact/state /path/to/iii-sdk/dist/index.mjs ./proof-output
```

Uses only new synthetic state and an ephemeral loopback port. Writes and
replaces a >33,556,506-byte JSON value, compares digest/metadata, seals+fsyncs,
restarts only its captured test children, then verifies persisted data. It prints
no source payload. The supplied engine/SDK must be the reviewed0.25.1 versions.

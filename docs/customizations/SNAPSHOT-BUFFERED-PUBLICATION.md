# Bounded snapshot publication writes

2026-10-28, development follow-up to source 23c5bb8a / operating .36.

The existing record serializer emits punctuation, indentation and record strings separately. Node's iterable FileHandle.writeFile awaits each emitted piece without coalescing. Read-only operating metadata showed approximately 565,125 worker write calls during 35,237,230 bytes of temp-file growth in 905 seconds (about 62 bytes/call); those process-wide calls are not a precise attribution of every syscall to this file. The snapshot continues running under the existing manual hold. This is evidence of excessive tiny writes, not proof of the entire CPU or latency cause.

The minimum change is a private 64KiB UTF-8/binary coalescer at publishSnapshotFile's iterable boundary. TextEncoder.encodeInto fills a fixed output buffer without building a whole-record encoded buffer or a whole-archive string. Binary views preserve offsets and bytes. A full buffer is yielded and replaced, so the consumer's bytes cannot be overwritten. The source is pulled sequentially under write backpressure. Scalar string/view publication remains on the existing path, including small scheduler metadata.

The existing fsync, close, atomic rename, directory fsync, and temp cleanup order remains unchanged. Before-rename errors/cancellation retain the previous published snapshot; after-rename directory-sync/Git failure has the same pre-existing boundary and does not imply rollback. Abort checks occur per chunk and encoding/copy iteration; a pending asynchronous source next() is not made immediately abortable. The currently operating snapshot has no newly introduced cancellation mechanism.

64KiB bounds the added staging buffer and each iterable output piece, not the input record, whole archive heap, or direct scalar input. UTF-8 boundaries and independently encoded malformed surrogate chunks retain the previous bytes. This does not add transaction-wide atomicity or a disk-commit receipt.

Validation: the pre-change tiny fixture emitted 2,112 write pieces and an oversized chunk exceeded 64KiB; both new assertions failed before the change. The focused publication/JSON/atomic tests pass (37 tests). Independent review found no critical/important issue. Fixtures use synthetic temporary files only. No production data, engine/socket load, full-suite load, operating patch/restart/resume, or candidate registration is part of this follow-up. Whole-suite/build/package/operating validation must be recorded separately before calling this a deployable candidate. No operational speed claim follows from write-piece reduction alone.

Replace this customization when upstream provides bounded streaming publication with equivalent byte representation, backpressure and failure/atomic publication tests.

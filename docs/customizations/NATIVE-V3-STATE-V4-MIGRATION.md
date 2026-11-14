# Native v3 lease to State-bound v4 migration

Explicit two-phase deployment tool, not automatic upgrade or data repair. Production use requires a separately approved deployment window. It never restores an older store, deletes a marker, clears holds or resets recovery budgets.

## Supported source
A known local native iii 0.22.1 deployment with a valid v3 application marker, native runtime metadata, one built-in iii-state using the expected file-backed KV store, and verifiable live process/executable/config/store/socket identities. Optional metadata fields are checked when present; otherwise process start is derived from marker and /proc. A v3 marker alone does not prove native ownership. Unsupported source layouts and recorded uncertainty are refused.

## Prepare while the native deployment is alive
Use the packaged `dist/native-v3-to-v4.mjs` tool (or the source `scripts/migration/native-v3-to-v4.mjs` from a checked-out repository). Replace every path/port explicitly:

    node dist/native-v3-to-v4.mjs prepare       --store /ABSOLUTE/CURRENT/STORE       --proof /ABSOLUTE/NEW-PROOF-FILE.json       --runtime /ABSOLUTE/NATIVE/RUNTIME       --native-executable /ABSOLUTE/VERIFIED/NATIVE/iii       --engine-url ws://127.0.0.1:ENGINE_PORT

The new proof captures exact marker bytes/hash, process epoch, executable/config/argv hashes. It is not a store-data backup.

## Finalize offline
Stop the approved native application and engine through their owning workflow. Do not start another writer.

    node dist/native-v3-to-v4.mjs finalize       --store /ABSOLUTE/CURRENT/STORE       --proof /ABSOLUTE/NEW-PROOF-FILE.json

Finalization checks exact unchanged evidence, verifies old processes are gone and exclusively holds both application and cooperative State locks. It writes a receipt and completion hash under .agentmemory-migrations, retaining the original marker verbatim. It does not change the marker to v4 yet.

First verified State-bound startup consumes only an exact matching receipt with old processes still gone. The new v4 marker records provenance. Source content, offsets, unknown fields and holds are not rewritten.

On failure inspect evidence. Partial/colliding receipts are not overwritten. Never delete/reset a marker or restore stale data to force admission.

## Disk-clean shutdown
Ordinary SDK completion remains distinct from disk durability. After application drain/freeze, the pinned State instance seals mutation admission, waits admitted mutations, flushes and synchronizes files/directory. Only its matching sealed+synced receipt can certify disk completion. The clean v4 marker is published before SDK disconnect. Failed/mismatched seal remains unclean. An ACK, empty application ledger or process exit alone is not proof.

## Rollback limits
No inverse v4-to-v3 conversion is supplied. Candidate strict native startup rejects v4; upgrade provenance does not permit downgrade. Older binaries cannot be assumed to enforce new guards: do not launch older code against a converted store. Code rollback requires a separately reviewed inverse procedure or isolated copy, never marker deletion/reset or old-data restoration.

The store lock excludes cooperating patched State workers, not hostile same-user processes able to alter binaries, receipts or storage.

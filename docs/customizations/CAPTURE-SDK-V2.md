# Native SDK capture v2 — development preparation

Approved policy: same native selected capture data in the private Ubuntu path HOME/.local/share/agentmemory/capture-spool-sdk-v2, canonical privacy-scrubbed envelope maximum8MiB, physical chunks maximum256KiB, originals256MiB, reference queue5MiB. Old data is not read/moved/deleted/replayed. No original auto-deletion/expiry exists. Actual host activation is separate and has not occurred.

## Explicit selection and unchanged functions

The full local-sdk-v2 package contains all6Codex events and the same selected MCP definition. Only UserPromptSubmit, PostToolUse and Stop add --agentmemory-sdk-capture-v2. Existing native invocation without that flag remains legacy. Global9 definitions and private filters/image extraction/project/context behavior remain unchanged. Stop retains its nonfinal session/end and skips opportunistic backlog work. SDK child and filtered-tool bypasses remain. The existing master preservation opt-out still prevents POST and source collection. Development directory override AGENTMEMORY_SDK_CAPTURE_V2_DIR is explicit; actual host override/endpoint/trust must be reviewed before activation.

## Source and reference ownership

Store root/originals/queue are current-user0700 and actual opened source/manifest/reference/lease files current-user0600, no symlink/nonregular/hardlink acceptance. General ancestor directories are not chmodded. Unknown root layouts fail before new subdirectories are added. Complete source chunks/hash manifest and directories are fsynced and atomically published/read back before a reference and POST. Full canonical JSON bytes including metadata count toward8MiB; existing native text limits/privacy normalization remain intentional. Arrays and own __proto__ keys survive. Same event/content reuses the earliest envelope, including conflict originals; different content stays separate/conflicted and is not transmitted.

All target quotas use one existing /usr/bin/flock inherited-fd lease. Linux/flock absence fails closed; no tool is installed. Process fd closure releases the kernel lock; no stale-lock unlink or signals to other processes exist. Original/partial/conflict source allocation counts conservatively, using file/directory allocation and at least4KiB per entry; queue root/directory/lease have minimum12KiB metadata. This is logical conservative admission, not a filesystem hard quota. All target namespaces share256MiB/5MiB. Only matching target hashes drain; credential-bearing URLs are not stored.

## Completion and recovery

The sender persists sending intent before any POST, then reloads/verifies the stored body. Only matching eventId plus completion:sdk/completed:true/durable:false acknowledges source metadata; source bytes are retained. SDK ACK is not engine disk-flush proof. Unknown sends, interrupted owner epochs, mismatched ACKs and unsupported legacy completion remain held. Known connection refusal and matching retryable admission rejection may back off; same stored reference is used. Fresh same-key completion does not create duplicate POSTs. Local queue/full/ACK-write errors cannot overwrite source or become silent success.

A later successful prompt/tool invocation may attempt at most one eligible pending reference. One monotonic deadline gates the next POST and network wait, including re-checks after source readback and JSON serialization. Required ACK/retry fsync and consistent reporting may finish after that deadline: synchronous I/O has no hard-wall promise. There is no perpetual scheduler or host automatic-retry guarantee.

Normal observe retransmission of a retained image is tested. Existing guarded restore refuses images and inputs over256KiB, and small manual restore requires separate review; no server guard is raised. Local preservation does not prove that every old crash/flush-unknown source can be automatically restored. Past unknowns remain untouched.

## Verification and activation boundary

Use synthetic temp stores/HOME/default forks only. Core covers exact8MiB and256/5MiB saturation, partial writes, concurrency, private ownership/modes, FIFO rejection, conflict reuse, epoch-held outcomes and source preservation after ACK. Transport covers actual loopback nonredirect and redirect traps plus monotonic deadline boundaries. Native tests use actual compiled children and byte/hash checks, including images larger than the former256KiB barrier. Candidate-level final commands/results/hashes are recorded in the external preparation dossier and must be read before claiming completion. The earlier one-shot SDK namespace test was run only against source234c898; it is not a new-source execution or validation exception.

No package preparation installs/trusts hooks, changes operating service/data/credentials, resets protection budgets or pushes Git. Full SDKv2 flavor is the only proposed new capture activation target. Historical partial companion ZIPs are retained but excluded because overlap by event name does not prove equivalent behavior.

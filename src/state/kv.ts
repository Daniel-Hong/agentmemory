import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {bucketScope, reconcileCheckpoint, readRetention, receiptFor, RETAINED_SCOPE, type RetentionReceipt, type RecoverySelection} from './vector-checkpoint-reconciliation.js'
import {KV} from './schema.js'
import {createRecordRecoveryGate, createRecoveryWriteGate} from './recovery-write-gate.js'
import {ownsFileWriterLease,fileWriterReadCurrent,fileWriterRecoveryAdmitted,fileWriterRecoveryReason,type FileWriterLease} from '../ops/file-writer-lease.mjs'
import { createCaptureReceiptPage } from '../capture/receipt-page.js'
import type { IIIClient } from 'iii-sdk'
import { withKeyedLock } from './keyed-mutex.js'
import { getEnvVar } from '../config.js'
import { createStateDurabilityFence } from '../ops/state-durability.mjs'
import { createObservationReader } from '../ops/observation-pages.mjs'
import { createAuditReader } from '../ops/audit-reader.mjs'
import { createSummaryCount } from '../ops/summary-count.mjs'
import { createGraphFileList } from '../ops/graph-file-list.mjs'
import { SAFE_PAYLOAD_BYTES } from './frame-guard.js'
import { resolveGraphScope, notifyGraphGenerationChange } from './graph-generation.js'
import { ensureGraphConsistency, noteGraphSnapshotWrite } from './graph-consistency.js'
import { withGraphIndexMutation, withGraphSnapshotIndexBarrier, withGraphSnapshotUnknownMutation } from './graph-retrieval-index.js'

export type StateBackend = 'file' | 'redis'

export interface StateKVOptions {
  writerLease?: FileWriterLease
  backend?: StateBackend
  durability?: ReturnType<typeof createStateDurabilityFence>
}

type UpdateOp = { type: string; path: string; value?: unknown }

type UpdateResult = { old_value: unknown; new_value: unknown; errors: unknown[] }

const LOCAL_UPDATE_OPS = new Set(['set', 'remove', 'merge'])
const UNSAFE_PATHS = new Set(['__proto__', 'constructor', 'prototype'])
const ORDER_FIELDS = ['createdAt', 'timestamp', 'startedAt', 'updatedAt'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canApplyLocally(ops: UpdateOp[]): boolean {
  return ops.every(
    (op) =>
      LOCAL_UPDATE_OPS.has(op.type) &&
      typeof (op.path ?? '') === 'string' &&
      !UNSAFE_PATHS.has(op.path ?? '') &&
      (op.type !== 'merge' || isPlainObject(op.value)),
  )
}

export function applyUpdateOps(oldValue: unknown, ops: UpdateOp[]): unknown {
  let current: unknown =
    oldValue === null || oldValue === undefined ? {} : structuredClone(oldValue)
  for (const op of ops) {
    const path = op.path ?? ''
    if (op.type === 'set') {
      if (path === '') current = op.value ?? null
      else if (isPlainObject(current)) current[path] = op.value ?? null
    } else if (op.type === 'remove') {
      if (path === '') current = null
      else if (isPlainObject(current)) delete current[path]
    } else if (op.type === 'merge' && isPlainObject(op.value)) {
      if (path === '') {
        if (isPlainObject(current)) Object.assign(current, op.value)
      } else {
        const root: Record<string, unknown> = isPlainObject(current) ? current : {}
        const existing = root[path]
        const target = isPlainObject(existing) ? existing : {}
        Object.assign(target, op.value)
        root[path] = target
        current = root
      }
    }
  }
  return current
}

const MIN_ID_TIME = Date.UTC(2020, 0, 1)
const MAX_ID_TIME = Date.UTC(2100, 0, 1)
let summaryLockSequence = 0

export function generatedIdTime(id: unknown): number | null {
  if (typeof id !== 'string') return null
  const parts = id.split('_')
  if (parts.length < 3) return null
  const segment = parts[parts.length - 2]!
  if (!/^[0-9a-z]{6,10}$/.test(segment)) return null
  const ms = parseInt(segment, 36)
  return ms >= MIN_ID_TIME && ms < MAX_ID_TIME ? ms : null
}

function orderKey(value: unknown): number {
  if (!isPlainObject(value)) return Number.POSITIVE_INFINITY
  const fromId = generatedIdTime(value.id)
  if (fromId !== null) return fromId
  for (const field of ORDER_FIELDS) {
    const raw = value[field]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return Number.POSITIVE_INFINITY
}

function idKey(value: unknown): string {
  if (!isPlainObject(value)) return ''
  const id = value.id ?? value.key
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : ''
}

export function orderLikeInsertion<T>(values: T[]): T[] {
  return values
    .map((value) => ({ value, at: orderKey(value), id: idKey(value) }))
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1
      if (a.id === b.id) return 0
      return a.id < b.id ? -1 : 1
    })
    .map((entry) => entry.value)
}

export class StateKV {
  private readonly summaryNamespaceLock = `summary-namespace:${++summaryLockSequence}`
  private writerLease?:FileWriterLease
  private writerStorePath?:string
  private checkpointStorePath?:string
  private readonly vectorWrites = createRecoveryWriteGate()
  private vectorRevision = 0
  get vectorCheckpointRevision() { return this.vectorRevision }
  private uncertainMutation=false
  get recoveryBlockReason(){return this.uncertainMutation?'WRITER_MUTATION_UNCERTAIN':this.writerLease?fileWriterRecoveryReason(this.writerLease):'FILE_WRITER_UNSUPPORTED'}
  get mutationOutcomeUncertain(){return this.uncertainMutation}
  get recoveryMutationSafe(){return !this.uncertainMutation&&!!this.writerLease&&fileWriterRecoveryAdmitted(this.writerLease)}
  readonly recoveryWrite?: ReturnType<typeof createRecordRecoveryGate>
  readonly backend: StateBackend
  readonly durability: ReturnType<typeof createStateDurabilityFence> | null
  readonly observationReader: ReturnType<typeof createObservationReader> | null
  readonly graphFileList: ReturnType<typeof createGraphFileList> | null
  readonly captureReceiptPage: ReturnType<typeof createCaptureReceiptPage> | null
  readonly auditReader: ReturnType<typeof createAuditReader> | null
  private readonly summaryCount: ReturnType<typeof createSummaryCount> | null

  constructor(
    private sdk: IIIClient,
    options: StateKVOptions = {},
  ) {
    this.backend = options.backend ?? 'file'
    const storePath = this.backend === 'file' ? getEnvVar('AGENTMEMORY_STATE_STORE_PATH') : undefined
    this.checkpointStorePath = storePath
    if (this.backend === 'file' && storePath && ownsFileWriterLease(options.writerLease,storePath)) {this.recoveryWrite=createRecordRecoveryGate();this.writerLease=options.writerLease;this.writerStorePath=storePath;}
    this.durability = this.backend === 'file'
      ? options.durability ?? (storePath ? createStateDurabilityFence({ storePath, completion: 'sdk' }) : null)
      : null
    this.observationReader = this.backend === 'file' && storePath ? createObservationReader({ storePath, kv: this, workContext: () => this.uncertainMutation ? null : this.writerLease && fileWriterReadCurrent(this.writerLease) ? this.writerLease : null }) : null
    this.graphFileList = this.backend === 'file' && storePath ? createGraphFileList({ storePath }) : null
    this.auditReader = this.backend === 'file' && storePath ? createAuditReader({ storePath, kv: this }) : null
    this.summaryCount = this.backend === 'file' && storePath ? createSummaryCount({storePath,kv:this}) : null
    this.captureReceiptPage = this.backend === 'file' && storePath ? createCaptureReceiptPage(storePath) : null
  }

  private guardedMutation<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
    const operation=()=>{if(this.writerLease&&!ownsFileWriterLease(this.writerLease,this.writerStorePath!))return Promise.reject(Error('FILE_WRITER_LOST'));if(this.recoveryWrite?.inExclusive()&&!this.recoveryMutationSafe)return Promise.reject(Error('WRITER_EPOCH_UNVERIFIED'));return fn()}
    const serialized=async()=>{try{return await operation()}catch(error){this.markMutationUncertain(scope);throw error}}
    // Keep queued mutations visible to the durability/shutdown fence. The gate
    // belongs inside the tracked operation, rather than before performMutation.
    const perform=()=>{if(this.writerLease&&!ownsFileWriterLease(this.writerLease,this.writerStorePath!))return Promise.reject(Error('FILE_WRITER_LOST'));return this.performMutation(scope,key,()=>scope==='mem:summaries'?withKeyedLock(this.summaryNamespaceLock,serialized):operation())}
    if (!this.recoveryWrite) return perform()
    const vectorNamespace = scope===KV.vectorPendingLog || scope===RETAINED_SCOPE || scope.startsWith(KV.bm25Index+':vec:') ||
      (scope===KV.bm25Index && key==='vectors:meta')
    if (!vectorNamespace) return this.recoveryWrite.read(scope,key,perform)
    return this.recoveryWrite.read(scope,key,()=>this.vectorWrites.read(async()=>{
      try { return await perform() } finally { this.vectorRevision++ }
    }))
  }

  canUseUnloadedDiskIndex(): boolean {
    // Standalone disk-fenced callers may start with an empty index. Once a receipt
    // exists, only the normal load/revalidation path can admit its retained WAL.
    const store = this.checkpointStorePath
    if (this.durability?.completion !== 'disk' || !store) return false
    try {
      return realpathSync(store) === store && lstatSync(store).isDirectory() &&
        lstatSync(join(store, encodeURIComponent(RETAINED_SCOPE) + '.bin'), {throwIfNoEntry: false}) === undefined
    } catch { return false }
  }

  async readVectorRetention():Promise<RetentionReceipt[]> {
    if (this.backend !== 'file') return []
    if (!this.checkpointStorePath) throw Error('vector_retention_store_unverified')
    return readRetention(this,this.checkpointStorePath,()=>!this.uncertainMutation &&
      (!this.writerLease || ownsFileWriterLease(this.writerLease,this.checkpointStorePath!)))
  }

  async reconcileVectorCheckpoint(selection:RecoverySelection,current:()=>boolean,expectedRevision:number,authorize:boolean,waitForCaptureMeta=false):Promise<RetentionReceipt[]>{
    const gate=this.recoveryWrite, storePath=this.writerStorePath
    if (waitForCaptureMeta && authorize) throw Error('vector_retention_capture_is_read_only')
    if(!gate || !storePath || !this.recoveryMutationSafe || (authorize && this.durability?.completion!=='sdk'))throw Error('vector_recovery_writer_unverified')
    const keys:Array<{scope:string;key:string}>=[{scope:KV.vectorPendingLog,key:'~clear'},{scope:KV.bm25Index,key:'vectors:meta'},
      ...selection.pendingRows.map(({id})=>({scope:KV.vectorPendingLog,key:id}))]
    for(const {bucket,ids} of selection.buckets)for(const id of ids){
      const row=selection.pendingRows.find(item=>item.id===id)
      if(!row)throw Error('vector_recovery_selection_invalid')
      keys.push({scope:bucketScope(bucket),key:id},{scope:RETAINED_SCOPE,key:receiptFor(row,bucket).digest})
    }
    const verify=()=>this.vectorWrites.exclusive(async()=>{
      if (this.vectorRevision!==expectedRevision) throw Error('vector_recovery_checkpoint_changed')
      const admitted=()=>current() && (!authorize || gate.inExclusive()) && this.recoveryMutationSafe
      const existing=await readRetention(this,storePath,admitted)
      return reconcileCheckpoint(this,storePath,selection,existing,authorize,admitted,waitForCaptureMeta)
    })
    // Read-only rechecks can run within capture's existing record gate. They never acquire another record lock.
    return authorize ? gate.exclusive(keys,verify) : verify()
  }

  private markMutationUncertain(scope:string):void {
    this.uncertainMutation=true
    this.observationReader?.invalidateCaptureSummary(scope)
    this.graphFileList?.invalidate(scope)
  }

  private performMutation<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
    const finish = this.observationReader?.beginMutation?.(scope)
    try {
      return (this.durability ? this.durability.mutate(scope, key, fn) : fn()).catch(error => {
        this.markMutationUncertain(scope)
        throw error
      }).finally(() => finish?.())
    } catch (error) {
      this.markMutationUncertain(scope)
      finish?.()
      throw error
    }
  }

  private record(scope: string, key: string, value: unknown, deletedExisting = false): void {
    try { this.observationReader?.record(scope, key, value, deletedExisting) }
    catch (error) { this.observationReader?.invalidateCaptureSummary(scope); throw error }
    this.auditReader?.record(scope, key, value)
    this.graphFileList?.record(scope, key, value)
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    scope = await resolveGraphScope(this, scope)
    await ensureGraphConsistency(this, scope)
    return (await this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
    })) ?? null
  }

  private async mutate<T>(
    scope: string,
    key: string,
    operation: (resolvedScope: string) => Promise<T>,
    knownValue?: { value: unknown; deleted?: boolean },
  ): Promise<T> {
    scope = await resolveGraphScope(this, scope)
    await ensureGraphConsistency(this, scope)
    const write = async () => {
      noteGraphSnapshotWrite(this, scope, key)
      try {
        return await this.guardedMutation(scope, key, () => {
          if(scope==='mem:summaries'&&this.summaryCount)return withKeyedLock(`summary-state:${key}`,async()=>{
            const projection=knownValue&&!knownValue.deleted?this.summaryCount!.prepare(knownValue.value,{wire:false}):undefined
            const result=await operation(scope)
            if(knownValue)this.summaryCount!.record(key,knownValue.deleted!==true,projection,result&&typeof result==='object'&&Object.hasOwn(result,'old_value')&&Object.hasOwn(result,'new_value')?Reflect.get(result,'new_value'):undefined)
            else if(result&&typeof result==='object'&&Object.hasOwn(result,'new_value'))this.summaryCount!.record(key,true,this.summaryCount!.prepare(Reflect.get(result,'new_value')))
            else this.summaryCount!.invalidate()
            return result
          })
          return operation(scope)
        })
      } finally {
        noteGraphSnapshotWrite(this, scope, key)
      }
    }
    const orderedWrite = () => this.backend === 'redis'
      ? withKeyedLock(`state-update:${scope}\u0000${key}`, write)
      : write()
    const result = await withGraphIndexMutation(this, scope, key, () =>
      knownValue
        ? withGraphSnapshotIndexBarrier(this, scope, key, knownValue.value, orderedWrite)
        : withGraphSnapshotUnknownMutation(this, scope, key, orderedWrite),
    )
    await notifyGraphGenerationChange(this, scope, key)
    if (knownValue) this.record(scope, key, knownValue.value, knownValue.value === null && Boolean(result))
    else if (result && typeof result === 'object' && Object.hasOwn(result, 'new_value')) this.record(scope, key, Reflect.get(result,'new_value'))
    return result
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.mutate(scope, key, (resolvedScope) =>
      this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
        function_id: 'state::set',
        payload: { scope: resolvedScope, key, value },
      }),
      { value },
    )
  }

  async update<T = unknown>(scope: string, key: string, ops: UpdateOp[]): Promise<T> {
    return this.mutate(scope, key, async (resolvedScope) => {
      if (this.backend === 'redis' && canApplyLocally(ops)) {
        const oldValue = await this.sdk.trigger<{ scope: string; key: string }, unknown>({
          function_id: 'state::get', payload: { scope: resolvedScope, key },
        })
        const newValue = applyUpdateOps(oldValue, ops)
        await this.sdk.trigger({ function_id: 'state::set', payload: { scope: resolvedScope, key, value: newValue } })
        const result: UpdateResult = { old_value: oldValue, new_value: newValue, errors: [] }
        return result as T
      }
      return this.sdk.trigger<{ scope: string; key: string; ops: UpdateOp[] }, T>({
        function_id: 'state::update',
        payload: { scope: resolvedScope, key, ops },
      })
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.mutate(scope, key, async (resolvedScope) => {
      return this.sdk.trigger<{ scope: string; key: string }, unknown>({
        function_id: 'state::delete',
        payload: { scope: resolvedScope, key },
      })
    }, { value: null, deleted: true })
  }

  async countSummaries(): Promise<number> {
    if(this.uncertainMutation)throw Error('summary_count_mutation_uncertain')
    const count=this.summaryCount ? await this.summaryCount.count() : (await this.list('mem:summaries')).length
    if(this.uncertainMutation)throw Error('summary_count_mutation_uncertain')
    return count
  }

  async getSummaryMergeInputs(): Promise<{total:number;recent:Pick<import('../types.js').SessionSummary,'sessionId'|'createdAt'|'title'|'narrative'|'concepts'>[]}> {
    if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
    const result=this.summaryCount ? await this.summaryCount.inputs() : await this.list<import('../types.js').SessionSummary>('mem:summaries').then(rows=>({total:rows.length,recent:rows.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,20)}))
    if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
    return result
  }

  async getSummarySessionIds(): Promise<Set<unknown>> {
    if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
    const result=this.summaryCount ? await this.summaryCount.sessionIds() : new Set((await this.list<import('../types.js').SessionSummary>('mem:summaries')).map(row=>row.sessionId))
    if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
    return result
  }

  async getSummaryMetadata(): Promise<Pick<import('../types.js').SessionSummary,'sessionId'|'project'|'createdAt'|'title'>[]> {
    return withKeyedLock(this.summaryNamespaceLock,async()=>{
      if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
      if(this.writerLease&&!fileWriterReadCurrent(this.writerLease))throw Error('FILE_WRITER_EPOCH_UNVERIFIED')
      const rows=this.summaryCount?await this.summaryCount.metadata():(await this.list<import('../types.js').SessionSummary>('mem:summaries')).map(({sessionId,project,createdAt,title})=>({sessionId,project,createdAt,title}))
      if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
      if(this.writerLease&&!fileWriterReadCurrent(this.writerLease))throw Error('FILE_WRITER_EPOCH_UNVERIFIED')
      return rows
    })
  }

  async getRecentProjectSummaries(project:string,limit=5): Promise<import('../types.js').SessionSummary[]> {
    return withKeyedLock(this.summaryNamespaceLock,async()=>{
      if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
      if(this.writerLease&&!fileWriterReadCurrent(this.writerLease))throw Error('FILE_WRITER_EPOCH_UNVERIFIED')
      const rows=this.summaryCount?await this.summaryCount.recent(project,limit):(await this.list<import('../types.js').SessionSummary>('mem:summaries')).filter(row=>row.project===project).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,limit)
      if(this.uncertainMutation)throw Error('summary_projection_mutation_uncertain')
      if(this.writerLease&&!fileWriterReadCurrent(this.writerLease))throw Error('FILE_WRITER_EPOCH_UNVERIFIED')
      return rows
    })
  }

  async list<T = unknown>(scope: string, options?: { observationConsistency?: 'opened-generation'; project?: (value: unknown, key?: string) => T }): Promise<T[]> {
    scope = await resolveGraphScope(this, scope)
    await ensureGraphConsistency(this, scope)
    if (this.graphFileList?.accepts(scope)) return this.graphFileList.list<T>(scope, options)
    if (scope.startsWith('mem:obs:') && this.observationReader) {
      const rows = await this.observationReader.list<T>(scope, { consistency: options?.observationConsistency })
      return options?.project ? rows.map(value => options.project!(value)) : rows
    }
    const read = () => this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
    })
    const values = scope==='mem:summaries'&&this.summaryCount
      ? await withKeyedLock(this.summaryNamespaceLock,async()=>{
        if(this.uncertainMutation)throw Error('summary_list_mutation_uncertain')
        if(this.writerLease&&!fileWriterReadCurrent(this.writerLease))throw Error('FILE_WRITER_EPOCH_UNVERIFIED')
        const bytes=await this.summaryCount!.sdkListBytes(SAFE_PAYLOAD_BYTES)
        if(this.uncertainMutation)throw Error('summary_list_mutation_uncertain')
        if(this.writerLease&&!fileWriterReadCurrent(this.writerLease))throw Error('FILE_WRITER_EPOCH_UNVERIFIED')
        if(bytes>SAFE_PAYLOAD_BYTES)throw Object.assign(Error('summary_collection_too_large'),{code:'SUMMARY_COLLECTION_TOO_LARGE',status:413,bytes,limitBytes:SAFE_PAYLOAD_BYTES})
        const rows=await read()
        if(this.writerLease&&!fileWriterReadCurrent(this.writerLease))throw Error('FILE_WRITER_EPOCH_UNVERIFIED')
        return rows
      })
      : await read()
    const ordered = this.backend === 'redis' && Array.isArray(values) ? orderLikeInsertion(values) : values
    return options?.project && Array.isArray(ordered) ? ordered.map(value => options.project!(value)) : ordered
  }

  async listGroups(): Promise<string[]> {
    const result = await this.sdk.trigger<Record<string, never>, { groups?: unknown } | null>({
      function_id: 'state::list_groups',
      payload: {},
    })
    const groups = result?.groups
    if (!Array.isArray(groups) || !groups.every((group) => typeof group === 'string')) {
      throw new Error('state::list_groups returned an unexpected shape')
    }
    return groups
  }
}

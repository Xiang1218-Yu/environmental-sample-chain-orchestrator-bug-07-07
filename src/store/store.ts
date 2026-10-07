import type {
  Aliquot, AnalysisBatch, AuditRecord, CustodyTransfer, EvidencePackage, FileRecord, InstrumentRun, OutboxMessage,
  QualityDecision, ReceivingRecord, ResultRevision, SampleContainer, SamplingRecord, SyncRecord,
} from '../domain/types.js';
import { scopedIdKey, type Scope, type Scoped } from '../domain/scope.js';

class Mutex {
  private tail = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

type Snapshot = {
  sequence: number;
  samples: SamplingRecord[];
  containers: SampleContainer[];
  transfers: CustodyTransfer[];
  receiving: ReceivingRecord[];
  aliquots: Aliquot[];
  batches: AnalysisBatch[];
  runs: InstrumentRun[];
  results: ResultRevision[];
  quality: QualityDecision[];
  evidence: EvidencePackage[];
  syncRecords: SyncRecord[];
  audit: AuditRecord[];
  outbox: OutboxMessage[];
  files: FileRecord[];
};

export class Store {
  /**
   * Samples are keyed by (tenant, project, sample id): a client-supplied
   * sample id may legally exist in several projects at once. Every other
   * aggregate uses server-generated globally unique ids, but lookups still
   * go through the scoped finders below.
   */
  readonly samples = new Map<string, SamplingRecord>();
  readonly containers = new Map<string, SampleContainer>();
  readonly transfers = new Map<string, CustodyTransfer>();
  readonly receiving = new Map<string, ReceivingRecord>();
  readonly aliquots = new Map<string, Aliquot>();
  readonly batches = new Map<string, AnalysisBatch>();
  readonly runs = new Map<string, InstrumentRun>();
  readonly results = new Map<string, ResultRevision>();
  readonly quality = new Map<string, QualityDecision>();
  readonly evidence = new Map<string, EvidencePackage>();
  readonly syncRecords = new Map<string, SyncRecord>();
  readonly audit: AuditRecord[] = [];
  readonly outbox: OutboxMessage[] = [];
  readonly files = new Map<string, FileRecord>();
  readonly lock = new Mutex();
  private sequence = 0;

  now(): string { return new Date().toISOString(); }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(8, '0')}`;
  }

  // ---- scoped sample index -------------------------------------------------

  sampleKey(scope: Scope, sampleId: string): string {
    return scopedIdKey(scope, sampleId);
  }

  putSample(sample: SamplingRecord): void {
    this.samples.set(this.sampleKey(sample, sample.id), sample);
  }

  findSample(sampleId: string, scope: Scope): SamplingRecord | undefined {
    return this.samples.get(this.sampleKey(scope, sampleId));
  }

  listSamples(scope: Scope): SamplingRecord[] {
    return [...this.samples.values()].filter((item) => item.tenantId === scope.tenantId && item.projectId === scope.projectId);
  }

  // ---- scoped collection helpers ------------------------------------------

  inScope<T extends Scoped>(values: Iterable<T>, scope: Scope): T[] {
    const result: T[] = [];
    for (const value of values) {
      if (value.tenantId === scope.tenantId && value.projectId === scope.projectId) result.push(value);
    }
    return result;
  }

  findScoped<T extends Scoped>(values: Iterable<T>, predicate: (value: T) => boolean, scope: Scope): T | undefined {
    for (const value of values) {
      if (value.tenantId === scope.tenantId && value.projectId === scope.projectId && predicate(value)) return value;
    }
    return undefined;
  }

  addAudit(input: Omit<AuditRecord, 'id' | 'createdAt'>): AuditRecord {
    const record = { ...input, id: this.nextId('audit'), createdAt: this.now() };
    this.audit.push(record);
    return record;
  }

  addOutbox(input: Omit<OutboxMessage, 'id' | 'createdAt' | 'status'>): OutboxMessage {
    const message = { ...input, id: this.nextId('outbox'), status: 'PENDING' as const, createdAt: this.now() };
    this.outbox.push(message);
    return message;
  }

  snapshot(): Snapshot {
    return {
      sequence: this.sequence,
      samples: structuredClone([...this.samples.values()]),
      containers: structuredClone([...this.containers.values()]),
      transfers: structuredClone([...this.transfers.values()]),
      receiving: structuredClone([...this.receiving.values()]),
      aliquots: structuredClone([...this.aliquots.values()]),
      batches: structuredClone([...this.batches.values()]),
      runs: structuredClone([...this.runs.values()]),
      results: structuredClone([...this.results.values()]),
      quality: structuredClone([...this.quality.values()]),
      evidence: structuredClone([...this.evidence.values()]),
      syncRecords: structuredClone([...this.syncRecords.values()]),
      audit: structuredClone(this.audit),
      outbox: structuredClone(this.outbox),
      files: structuredClone([...this.files.values()]),
    };
  }

  restore(snapshot: Snapshot): void {
    this.sequence = snapshot.sequence;
    this.samples.clear();
    for (const sample of snapshot.samples) this.putSample(sample);
    this.replaceMap(this.containers, snapshot.containers);
    this.replaceMap(this.transfers, snapshot.transfers);
    this.replaceMap(this.receiving, snapshot.receiving);
    this.replaceMap(this.aliquots, snapshot.aliquots);
    this.replaceMap(this.batches, snapshot.batches);
    this.replaceMap(this.runs, snapshot.runs);
    this.replaceMap(this.results, snapshot.results);
    this.replaceMap(this.quality, snapshot.quality);
    this.replaceMap(this.evidence, snapshot.evidence);
    this.replaceMap(this.syncRecords, snapshot.syncRecords, (value) => value.key);
    this.replaceMap(this.files, snapshot.files, (value) => value.key);
    this.audit.splice(0, this.audit.length, ...snapshot.audit);
    this.outbox.splice(0, this.outbox.length, ...snapshot.outbox);
  }

  async transaction<T>(work: () => Promise<T> | T): Promise<T> {
    return this.lock.runExclusive(async () => {
      const before = this.snapshot();
      try {
        return await work();
      } catch (error) {
        this.restore(before);
        throw error;
      }
    });
  }

  private replaceMap<T>(target: Map<string, T>, values: T[], keyOf: (value: T) => string = (value) => (value as T & { id: string }).id): void {
    target.clear();
    for (const value of values) target.set(keyOf(value), value);
  }
}

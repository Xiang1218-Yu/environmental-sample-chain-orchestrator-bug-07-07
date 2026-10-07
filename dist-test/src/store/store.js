import { scopedIdKey } from '../domain/scope.js';
class Mutex {
    tail = Promise.resolve();
    async runExclusive(work) {
        const previous = this.tail;
        let release;
        this.tail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            return await work();
        }
        finally {
            release();
        }
    }
}
export class Store {
    /**
     * Samples are keyed by (tenant, project, sample id): a client-supplied
     * sample id may legally exist in several projects at once. Every other
     * aggregate uses server-generated globally unique ids, but lookups still
     * go through the scoped finders below.
     */
    samples = new Map();
    containers = new Map();
    transfers = new Map();
    receiving = new Map();
    aliquots = new Map();
    batches = new Map();
    runs = new Map();
    results = new Map();
    quality = new Map();
    evidence = new Map();
    syncRecords = new Map();
    audit = [];
    outbox = [];
    files = new Map();
    lock = new Mutex();
    sequence = 0;
    now() { return new Date().toISOString(); }
    nextId(prefix) {
        this.sequence += 1;
        return `${prefix}_${this.sequence.toString().padStart(8, '0')}`;
    }
    // ---- scoped sample index -------------------------------------------------
    sampleKey(scope, sampleId) {
        return scopedIdKey(scope, sampleId);
    }
    putSample(sample) {
        this.samples.set(this.sampleKey(sample, sample.id), sample);
    }
    findSample(sampleId, scope) {
        return this.samples.get(this.sampleKey(scope, sampleId));
    }
    listSamples(scope) {
        return [...this.samples.values()].filter((item) => item.tenantId === scope.tenantId && item.projectId === scope.projectId);
    }
    // ---- scoped collection helpers ------------------------------------------
    inScope(values, scope) {
        const result = [];
        for (const value of values) {
            if (value.tenantId === scope.tenantId && value.projectId === scope.projectId)
                result.push(value);
        }
        return result;
    }
    findScoped(values, predicate, scope) {
        for (const value of values) {
            if (value.tenantId === scope.tenantId && value.projectId === scope.projectId && predicate(value))
                return value;
        }
        return undefined;
    }
    addAudit(input) {
        const record = { ...input, id: this.nextId('audit'), createdAt: this.now() };
        this.audit.push(record);
        return record;
    }
    addOutbox(input) {
        const message = { ...input, id: this.nextId('outbox'), status: 'PENDING', createdAt: this.now() };
        this.outbox.push(message);
        return message;
    }
    snapshot() {
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
    restore(snapshot) {
        this.sequence = snapshot.sequence;
        this.samples.clear();
        for (const sample of snapshot.samples)
            this.putSample(sample);
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
    async transaction(work) {
        return this.lock.runExclusive(async () => {
            const before = this.snapshot();
            try {
                return await work();
            }
            catch (error) {
                this.restore(before);
                throw error;
            }
        });
    }
    replaceMap(target, values, keyOf = (value) => value.id) {
        target.clear();
        for (const value of values)
            target.set(keyOf(value), value);
    }
}

/**
 * NeuralRAG Database Layer
 * 
 * SQLite-backed neuron graph storage.
 * Zero infrastructure — the entire brain ships as a .db file.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import type {
    Neuron,
    NeuronCreateInput,
    Synapse,
    SynapseCreateInput,
    GraphStats,
    IndexedFile,
} from './types.js';

const SCHEMA_VERSION = 1;

export class NeuralDB {
    private db: Database.Database;

    constructor(projectRoot: string) {
        const dbDir = path.join(projectRoot, '.neuralrag');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        const dbPath = path.join(dbDir, 'brain.db');
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.migrate();
    }

    // ─── Schema Migration ───────────────────────────────────────────

    private migrate(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

        const versionRow = this.db.prepare(
            `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get() as { value: string } | undefined;

        const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

        if (currentVersion < 1) {
            this.db.exec(`
        -- Neurons: semantic code chunks
        CREATE TABLE IF NOT EXISTS neurons (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          embedding BLOB,
          file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT '',
          activation_count INTEGER NOT NULL DEFAULT 0,
          last_activated TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Synapses: weighted connections between neurons
        CREATE TABLE IF NOT EXISTS synapses (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
          weight REAL NOT NULL DEFAULT 0.5,
          type TEXT NOT NULL,
          metadata TEXT,
          fire_count INTEGER NOT NULL DEFAULT 0,
          last_fired TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(source_id, target_id, type)
        );

        -- Indexed files: track what's been indexed for incremental updates
        CREATE TABLE IF NOT EXISTS indexed_files (
          path TEXT PRIMARY KEY,
          language TEXT NOT NULL DEFAULT '',
          neuron_count INTEGER NOT NULL DEFAULT 0,
          last_indexed TEXT NOT NULL DEFAULT (datetime('now')),
          content_hash TEXT NOT NULL
        );

        -- Query history: for Hebbian learning signals
        CREATE TABLE IF NOT EXISTS query_log (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          activated_neuron_ids TEXT NOT NULL,    -- JSON array of neuron IDs
          used_neuron_ids TEXT,                  -- JSON array of IDs that appeared in response
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Indexes for fast lookups
        CREATE INDEX IF NOT EXISTS idx_neurons_file ON neurons(file_path);
        CREATE INDEX IF NOT EXISTS idx_neurons_type ON neurons(type);
        CREATE INDEX IF NOT EXISTS idx_neurons_name ON neurons(name);
        CREATE INDEX IF NOT EXISTS idx_synapses_source ON synapses(source_id);
        CREATE INDEX IF NOT EXISTS idx_synapses_target ON synapses(target_id);
        CREATE INDEX IF NOT EXISTS idx_synapses_type ON synapses(type);
      `);

            this.db.prepare(
                `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)`
            ).run(String(SCHEMA_VERSION));
        }
    }

    // ─── Neuron CRUD ────────────────────────────────────────────────

    createNeuron(input: NeuronCreateInput): Neuron {
        const id = uuidv4();
        const now = new Date().toISOString();
        const embeddingBuffer = input.embedding
            ? Buffer.from(input.embedding.buffer)
            : null;

        this.db.prepare(`
      INSERT INTO neurons (id, content, summary, embedding, file_path, start_line, end_line, type, name, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            id,
            input.content,
            input.summary,
            embeddingBuffer,
            input.file_path,
            input.start_line,
            input.end_line,
            input.type,
            input.name,
            input.language,
            now,
            now,
        );

        return this.getNeuron(id)!;
    }

    createNeuronsBatch(inputs: NeuronCreateInput[]): string[] {
        const ids: string[] = [];
        const now = new Date().toISOString();

        const stmt = this.db.prepare(`
      INSERT INTO neurons (id, content, summary, embedding, file_path, start_line, end_line, type, name, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const insertMany = this.db.transaction((items: NeuronCreateInput[]) => {
            for (const input of items) {
                const id = uuidv4();
                ids.push(id);
                const embeddingBuffer = input.embedding
                    ? Buffer.from(input.embedding.buffer)
                    : null;
                stmt.run(
                    id,
                    input.content,
                    input.summary,
                    embeddingBuffer,
                    input.file_path,
                    input.start_line,
                    input.end_line,
                    input.type,
                    input.name,
                    input.language,
                    now,
                    now,
                );
            }
        });

        insertMany(inputs);
        return ids;
    }

    getNeuron(id: string): Neuron | null {
        const row = this.db.prepare(`SELECT * FROM neurons WHERE id = ?`).get(id) as any;
        return row ? this.rowToNeuron(row) : null;
    }

    getNeuronsByFile(filePath: string): Neuron[] {
        const rows = this.db.prepare(
            `SELECT * FROM neurons WHERE file_path = ? ORDER BY start_line ASC`
        ).all(filePath) as any[];
        return rows.map(r => this.rowToNeuron(r));
    }

    getAllNeurons(): Neuron[] {
        const rows = this.db.prepare(`SELECT * FROM neurons ORDER BY file_path, start_line`).all() as any[];
        return rows.map(r => this.rowToNeuron(r));
    }

    deleteNeuronsByFile(filePath: string): number {
        const result = this.db.prepare(`DELETE FROM neurons WHERE file_path = ?`).run(filePath);
        return result.changes;
    }

    updateNeuronActivation(id: string): void {
        this.db.prepare(`
      UPDATE neurons 
      SET activation_count = activation_count + 1, last_activated = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    }

    private rowToNeuron(row: any): Neuron {
        return {
            ...row,
            embedding: row.embedding
                ? new Float32Array(new Uint8Array(row.embedding).buffer)
                : new Float32Array(0),
            activation_count: row.activation_count ?? 0,
        };
    }

    // ─── Synapse CRUD ───────────────────────────────────────────────

    createSynapse(input: SynapseCreateInput): Synapse {
        const id = uuidv4();
        const now = new Date().toISOString();
        const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

        this.db.prepare(`
      INSERT OR IGNORE INTO synapses (id, source_id, target_id, weight, type, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.source_id, input.target_id, input.weight, input.type, metadata, now);

        return this.getSynapse(id)!;
    }

    createSynapsesBatch(inputs: SynapseCreateInput[]): void {
        const now = new Date().toISOString();

        const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO synapses (id, source_id, target_id, weight, type, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

        const insertMany = this.db.transaction((items: SynapseCreateInput[]) => {
            for (const input of items) {
                const id = uuidv4();
                const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
                stmt.run(id, input.source_id, input.target_id, input.weight, input.type, metadata, now);
            }
        });

        insertMany(inputs);
    }

    getSynapse(id: string): Synapse | null {
        const row = this.db.prepare(`SELECT * FROM synapses WHERE id = ?`).get(id) as any;
        return row ? this.rowToSynapse(row) : null;
    }

    getOutgoingSynapses(neuronId: string): Synapse[] {
        const rows = this.db.prepare(
            `SELECT * FROM synapses WHERE source_id = ? ORDER BY weight DESC`
        ).all(neuronId) as any[];
        return rows.map(r => this.rowToSynapse(r));
    }

    getIncomingSynapses(neuronId: string): Synapse[] {
        const rows = this.db.prepare(
            `SELECT * FROM synapses WHERE target_id = ? ORDER BY weight DESC`
        ).all(neuronId) as any[];
        return rows.map(r => this.rowToSynapse(r));
    }

    getConnectedSynapses(neuronId: string): Synapse[] {
        const rows = this.db.prepare(
            `SELECT * FROM synapses WHERE source_id = ? OR target_id = ? ORDER BY weight DESC`
        ).all(neuronId, neuronId) as any[];
        return rows.map(r => this.rowToSynapse(r));
    }

    strengthenSynapse(sourceId: string, targetId: string, delta: number = 0.05): void {
        this.db.prepare(`
      UPDATE synapses 
      SET weight = MIN(1.0, weight + ?), fire_count = fire_count + 1, last_fired = datetime('now')
      WHERE source_id = ? AND target_id = ?
    `).run(delta, sourceId, targetId);
    }

    weakenSynapse(sourceId: string, targetId: string, delta: number = 0.01): void {
        this.db.prepare(`
      UPDATE synapses 
      SET weight = MAX(0.0, weight - ?)
      WHERE source_id = ? AND target_id = ?
    `).run(delta, sourceId, targetId);
    }

    decayUnusedSynapses(daysOld: number = 7, delta: number = 0.01): number {
        const result = this.db.prepare(`
      UPDATE synapses 
      SET weight = MAX(0.0, weight - ?)
      WHERE last_fired IS NOT NULL 
        AND julianday('now') - julianday(last_fired) > ?
        AND type = 'co_activation'
    `).run(delta, daysOld);
        return result.changes;
    }

    findOrCreateCoActivationSynapse(sourceId: string, targetId: string): void {
        const existing = this.db.prepare(
            `SELECT id FROM synapses WHERE source_id = ? AND target_id = ? AND type = 'co_activation'`
        ).get(sourceId, targetId) as any;

        if (existing) {
            this.strengthenSynapse(sourceId, targetId);
        } else {
            this.createSynapse({
                source_id: sourceId,
                target_id: targetId,
                weight: 0.3,
                type: 'co_activation',
            });
        }
    }

    private rowToSynapse(row: any): Synapse {
        return {
            ...row,
            metadata: row.metadata ? JSON.parse(row.metadata) : null,
            fire_count: row.fire_count ?? 0,
        };
    }

    // ─── Indexed Files ─────────────────────────────────────────────

    upsertIndexedFile(file: Omit<IndexedFile, 'last_indexed'>): void {
        this.db.prepare(`
      INSERT OR REPLACE INTO indexed_files (path, language, neuron_count, content_hash, last_indexed)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(file.path, file.language, file.neuron_count, file.content_hash);
    }

    getIndexedFile(filePath: string): IndexedFile | null {
        return this.db.prepare(
            `SELECT * FROM indexed_files WHERE path = ?`
        ).get(filePath) as IndexedFile | null;
    }

    getAllIndexedFiles(): IndexedFile[] {
        return this.db.prepare(`SELECT * FROM indexed_files`).all() as IndexedFile[];
    }

    deleteIndexedFile(filePath: string): void {
        this.db.prepare(`DELETE FROM indexed_files WHERE path = ?`).run(filePath);
    }

    // ─── Query Log ─────────────────────────────────────────────────

    logQuery(query: string, activatedIds: string[], usedIds?: string[]): void {
        this.db.prepare(`
      INSERT INTO query_log (id, query, activated_neuron_ids, used_neuron_ids)
      VALUES (?, ?, ?, ?)
    `).run(
            uuidv4(),
            query,
            JSON.stringify(activatedIds),
            usedIds ? JSON.stringify(usedIds) : null,
        );
    }

    // ─── Graph Stats ───────────────────────────────────────────────

    getStats(): GraphStats {
        const neuronCount = (this.db.prepare(`SELECT COUNT(*) as c FROM neurons`).get() as any).c;
        const synapseCount = (this.db.prepare(`SELECT COUNT(*) as c FROM synapses`).get() as any).c;
        const fileCount = (this.db.prepare(`SELECT COUNT(*) as c FROM indexed_files`).get() as any).c;
        const languages = (this.db.prepare(
            `SELECT DISTINCT language FROM neurons WHERE language != ''`
        ).all() as any[]).map(r => r.language);
        const lastIndexed = (this.db.prepare(
            `SELECT MAX(last_indexed) as t FROM indexed_files`
        ).get() as any)?.t ?? null;
        const totalQueries = (this.db.prepare(`SELECT COUNT(*) as c FROM query_log`).get() as any).c;

        return {
            neuron_count: neuronCount,
            synapse_count: synapseCount,
            file_count: fileCount,
            languages,
            last_indexed: lastIndexed,
            total_queries: totalQueries,
            avg_activation_depth: 0, // computed at query time
        };
    }

    // ─── Utilities ─────────────────────────────────────────────────

    clearAll(): void {
        this.db.exec(`
      DELETE FROM query_log;
      DELETE FROM synapses;
      DELETE FROM neurons;
      DELETE FROM indexed_files;
    `);
    }

    close(): void {
        this.db.close();
    }
}

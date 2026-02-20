/**
 * NeuralRAG Core Types
 * 
 * The brain-inspired data model:
 * - Neurons: semantic code chunks with embeddings
 * - Synapses: weighted directional connections between neurons
 * - Activation: spreading activation scores during query
 */

// ─── Neuron ──────────────────────────────────────────────────────────

export type NeuronType =
    | 'function'
    | 'class'
    | 'method'
    | 'type'
    | 'interface'
    | 'module'
    | 'config'
    | 'doc'
    | 'variable'
    | 'export';

export interface Neuron {
    id: string;
    content: string;              // the source code chunk
    summary: string;              // one-line description for fast scanning
    embedding: Float32Array;      // vector embedding for similarity
    file_path: string;            // relative to project root
    start_line: number;
    end_line: number;
    type: NeuronType;
    name: string;                 // function/class/variable name
    language: string;             // js, ts, py, go, etc.
    activation_count: number;     // total times activated (for Hebbian decay)
    last_activated: string | null;
    created_at: string;
    updated_at: string;
}

export interface NeuronCreateInput {
    content: string;
    summary: string;
    embedding: Float32Array;
    file_path: string;
    start_line: number;
    end_line: number;
    type: NeuronType;
    name: string;
    language: string;
}

// ─── Synapse ─────────────────────────────────────────────────────────

export type SynapseType =
    | 'imports'          // A imports from B
    | 'calls'            // A calls function in B
    | 'type_reference'   // A uses type defined in B
    | 'extends'          // A extends/implements B
    | 'proximity'        // A and B are in the same file/directory
    | 'co_activation'    // A and B were co-activated during queries (Hebbian)
    | 'semantic';        // A and B have high embedding similarity

export interface Synapse {
    id: string;
    source_id: string;           // neuron A
    target_id: string;           // neuron B
    weight: number;              // 0.0 to 1.0, Hebbian-updated
    type: SynapseType;
    metadata: Record<string, unknown> | null; // extra info (e.g., import path)
    fire_count: number;          // how many times this synapse was traversed
    last_fired: string | null;
    created_at: string;
}

export interface SynapseCreateInput {
    source_id: string;
    target_id: string;
    weight: number;
    type: SynapseType;
    metadata?: Record<string, unknown>;
}

// ─── Activation ──────────────────────────────────────────────────────

export interface ActivationResult {
    neuron: Neuron;
    score: number;               // activation strength (0.0 to 1.0)
    depth: number;               // how many hops from an entry neuron
    path: string[];              // neuron IDs that led here
}

export interface ActivationConfig {
    max_neurons: number;         // max neurons to return (default: 15)
    entry_count: number;         // number of entry neurons from embedding search (default: 3)
    decay_factor: number;        // activation decay per hop (default: 0.7)
    min_activation: number;      // stop spreading below this (default: 0.1)
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
    max_neurons: 15,
    entry_count: 3,
    decay_factor: 0.7,
    min_activation: 0.1,
};

// ─── Graph Stats ─────────────────────────────────────────────────────

export interface GraphStats {
    neuron_count: number;
    synapse_count: number;
    file_count: number;
    languages: string[];
    last_indexed: string | null;
    total_queries: number;
    avg_activation_depth: number;
}

// ─── Indexing ────────────────────────────────────────────────────────

export interface IndexedFile {
    path: string;
    language: string;
    neuron_count: number;
    last_indexed: string;
    content_hash: string;        // for incremental re-indexing
}

export interface IndexConfig {
    root_dir: string;
    ignore_patterns: string[];   // glob patterns to skip
    supported_languages: string[];
    max_chunk_lines: number;     // split chunks larger than this
    min_chunk_lines: number;     // don't create neurons smaller than this
}

export const DEFAULT_INDEX_CONFIG: IndexConfig = {
    root_dir: '.',
    ignore_patterns: [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'build/**',
        '.next/**',
        '*.min.js',
        '*.map',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
    ],
    supported_languages: ['javascript', 'typescript', 'python', 'go', 'rust'],
    max_chunk_lines: 200,
    min_chunk_lines: 3,
};

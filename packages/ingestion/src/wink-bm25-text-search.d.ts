declare module "wink-bm25-text-search" {
  export interface BM25Config {
    fldWeights: Record<string, number>;
    bm25Params?: {
      k1?: number;
      b?: number;
      k?: number;
    };
    ovFldNames?: string[];
  }

  export type BM25PrepTask = (input: string) => string[];
  export type BM25SearchHit = [id: string, score: number];

  export interface BM25Engine {
    defineConfig(config: BM25Config): boolean;
    definePrepTasks(tasks: BM25PrepTask[], field?: string): number;
    addDoc(doc: Record<string, string>, uniqueId: string): number;
    consolidate(fp?: number): boolean;
    search(text: string, limit?: number): BM25SearchHit[];
    exportJSON(): string;
    importJSON(json: string): boolean;
  }

  export default function bm25Factory(): BM25Engine;
}

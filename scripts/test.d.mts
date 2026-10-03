export type TestSuite = "all" | "unit" | "hot" | "contract";
export type TestShard = { index: number; count: number };

export function normalizeTestPath(value: string): string;
export function classifyTestFile(file: string): Exclude<TestSuite, "all">;
export function discoverTestFiles(root?: string): string[];
export function defaultJobs(env?: Record<string, string | undefined>): number;
export function parseShard(value: string, source?: string): TestShard;
export function defaultShard(env?: Record<string, string | undefined>): TestShard;
export function scheduleTestFiles(labels: string[], shard?: TestShard): { exclusive: string[]; pooled: string[] };
export function run(options: {
	suite: TestSuite;
	root: string;
	skipMemory: boolean;
	list: boolean;
	jobs?: number;
	shard?: TestShard;
}): Promise<number>;

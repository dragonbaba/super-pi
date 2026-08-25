export type TestSuite = "all" | "unit" | "hot" | "contract";

export function normalizeTestPath(value: string): string;
export function classifyTestFile(file: string): Exclude<TestSuite, "all">;
export function discoverTestFiles(root?: string): string[];
export function run(options: {
	suite: TestSuite;
	root: string;
	skipMemory: boolean;
	list: boolean;
}): number;

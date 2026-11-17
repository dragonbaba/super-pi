export function getPiUserAgent(version: string, product = "pi"): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `${product}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

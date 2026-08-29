/**
 * Mount-relative URL helper.
 * Production (Cloudflare root): BASE_URL = "/"
 * Staging (GitHub Pages project site): BASE_URL = "/master-carpenters/"
 */
export function withBase(path = "/"): string {
	const root = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
	if (!path) return root + "/";
	if (
		path.startsWith("http://") ||
		path.startsWith("https://") ||
		path.startsWith("tel:") ||
		path.startsWith("mailto:") ||
		path.startsWith("data:")
	) {
		return path;
	}
	// Same-page hash only
	if (path.startsWith("#")) return path;
	// Root-relative hash links like /#services
	if (path.startsWith("/#")) return `${root}${path}`;
	if (path.startsWith("/")) return `${root}${path}`;
	return `${root}/${path}`;
}

/** Prefix every URL inside an srcset string: "a 1x, b 2x" */
export function withBaseSrcset(srcset: string): string {
	if (!srcset) return srcset;
	return srcset
		.split(",")
		.map((part) => {
			const trimmed = part.trim();
			const sp = trimmed.indexOf(" ");
			if (sp === -1) return withBase(trimmed);
			return `${withBase(trimmed.slice(0, sp))} ${trimmed.slice(sp + 1)}`;
		})
		.join(", ");
}

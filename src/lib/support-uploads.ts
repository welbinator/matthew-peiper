/// <reference types="@cloudflare/workers-types" />
/**
 * Shared upload rules + R2 helpers for support attachments.
 *
 * Files are stored in R2 (binding SUPPORT_UPLOADS); D1 keeps only metadata
 * in support_attachments. Common-sense restrictions: images + PDF only,
 * 10 MB/file, 5 files/request, 25 MB total.
 */
import { makeId } from "./support-auth";

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_FILES = 5; // per request/reply
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB per request/reply

// Allowed MIME types → canonical extension.
export const ALLOWED_TYPES: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/heic": "heic",
	"image/heif": "heif",
	"application/pdf": "pdf",
};

export const ALLOWED_LABEL = "JPG, PNG, WebP, GIF, HEIC or PDF";

export interface StoredAttachment {
	id: string;
	r2_key: string;
	filename: string;
	content_type: string;
	size_bytes: number;
}

/** Sanitize a client-supplied filename to something safe for display/storage. */
export function safeName(name: string, fallbackExt: string): string {
	const base = (name || "").split(/[\\/]/).pop() || "";
	const cleaned = base
		.replace(/[^\w.\- ]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	if (cleaned && /\.[A-Za-z0-9]{1,8}$/.test(cleaned)) return cleaned;
	const stem = (cleaned || "file").replace(/\.+$/, "");
	return `${stem || "file"}.${fallbackExt}`;
}

export interface ValidationResult {
	ok: boolean;
	error?: string;
	files: File[];
}

/**
 * Pull File objects out of FormData and enforce type/size/count limits.
 * Returns a clear, client-facing error string on the first violation.
 */
export function collectValidFiles(form: FormData): ValidationResult {
	const raw: File[] = [];
	for (const value of form.getAll("files")) {
		if (value instanceof File && value.size > 0) raw.push(value);
	}
	// Also accept files[] and single "file" for flexibility.
	for (const key of ["files[]", "file"]) {
		for (const value of form.getAll(key)) {
			if (value instanceof File && value.size > 0) raw.push(value);
		}
	}

	if (raw.length === 0) return { ok: true, files: [] };
	if (raw.length > MAX_FILES) {
		return { ok: false, error: `Please attach at most ${MAX_FILES} files.`, files: [] };
	}

	let total = 0;
	for (const f of raw) {
		if (!ALLOWED_TYPES[f.type]) {
			return {
				ok: false,
				error: `"${f.name || "file"}" isn't a supported type. Allowed: ${ALLOWED_LABEL}.`,
				files: [],
			};
		}
		if (f.size > MAX_FILE_BYTES) {
			return {
				ok: false,
				error: `"${f.name || "file"}" is too large (max 10 MB per file).`,
				files: [],
			};
		}
		total += f.size;
	}
	if (total > MAX_TOTAL_BYTES) {
		return { ok: false, error: "Attachments total is too large (max 25 MB).", files: [] };
	}
	return { ok: true, files: raw };
}

/**
 * Store validated files in R2 and return metadata rows.
 * Keys: support/<ticketId>/<attachmentId>.<ext>
 */
export async function storeFiles(
	bucket: R2Bucket,
	ticketId: string,
	files: File[]
): Promise<StoredAttachment[]> {
	const out: StoredAttachment[] = [];
	for (const f of files) {
		const ext = ALLOWED_TYPES[f.type] || "bin";
		const id = makeId("att");
		const key = `support/${ticketId}/${id}.${ext}`;
		const buf = await f.arrayBuffer();
		await bucket.put(key, buf, {
			httpMetadata: { contentType: f.type },
		});
		out.push({
			id,
			r2_key: key,
			filename: safeName(f.name, ext),
			content_type: f.type,
			size_bytes: f.size,
		});
	}
	return out;
}

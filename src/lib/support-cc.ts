import { env } from "cloudflare:workers";

async function hmacHex(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function supportNotifyUrl(): string {
	return (
		(env as Record<string, string | undefined>).CC_SUPPORT_URL ||
		(env as Record<string, string | undefined>).CC_NOTIFY_URL?.replace(
			/\/api\/push\/notify$/,
			"/api/support/notify"
		) ||
		"https://cc.crweb.design/api/support/notify"
	);
}

async function postSigned(payload: Record<string, unknown>): Promise<void> {
	const secret = (env as Record<string, string | undefined>).PUSH_NOTIFY_SECRET;
	if (!secret) return;
	const url = supportNotifyUrl();
	try {
		const ts = Math.floor(Date.now() / 1000);
		const bodyObj = { ...payload, ts };
		const body = JSON.stringify(bodyObj);
		const sig = await hmacHex(secret, `v0:${ts}:${body}`);
		await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-CC-Signature": `t=${ts},v0=${sig}`,
			},
			body,
		});
	} catch {
		// CC down — local row already saved
	}
}

export type SupportTicketNotify = {
	id: string;
	site_id: string;
	site: string;
	subject: string;
	message: string;
	page_url?: string;
	user_email: string;
	user_name: string;
	status?: string;
	created_at: string;
	message_id?: string;
};

/** Fire-and-forget new-ticket webhook to Command Center. */
export async function notifySupportTicket(ticket: SupportTicketNotify): Promise<void> {
	await postSigned({
		type: "ticket",
		id: ticket.id,
		site_id: ticket.site_id,
		site: ticket.site,
		subject: ticket.subject,
		message: ticket.message,
		page_url: ticket.page_url || "",
		user_email: ticket.user_email,
		user_name: ticket.user_name,
		status: ticket.status || "new",
		created_at: ticket.created_at,
		message_id: ticket.message_id || "",
	});
}

export type SupportMessageNotify = {
	ticket_id: string;
	message_id: string;
	site_id: string;
	site: string;
	subject?: string;
	body: string;
	user_email: string;
	user_name: string;
	created_at: string;
};

/** Fire-and-forget client reply webhook to Command Center. */
export async function notifySupportMessage(msg: SupportMessageNotify): Promise<void> {
	await postSigned({
		type: "message",
		ticket_id: msg.ticket_id,
		message_id: msg.message_id,
		site_id: msg.site_id,
		site: msg.site,
		subject: msg.subject || "",
		body: msg.body,
		message: msg.body,
		user_email: msg.user_email,
		user_name: msg.user_name,
		created_at: msg.created_at,
	});
}

export type SupportApprovalNotify = {
	ticket_id: string;
	message_id: string;
	site_id: string;
	site: string;
	subject?: string;
	body: string;
	staging_url?: string;
	user_email: string;
	user_name: string;
	created_at: string;
	approved_at: string;
};

/** Fire-and-forget client approval webhook to Command Center. */
export async function notifySupportApproval(msg: SupportApprovalNotify): Promise<void> {
	await postSigned({
		type: "approval",
		ticket_id: msg.ticket_id,
		message_id: msg.message_id,
		site_id: msg.site_id,
		site: msg.site,
		subject: msg.subject || "",
		body: msg.body,
		message: msg.body,
		staging_url: msg.staging_url || "",
		status: "approved",
		user_email: msg.user_email,
		user_name: msg.user_name,
		created_at: msg.created_at,
		approved_at: msg.approved_at,
	});
}

export type SupportDisapprovalNotify = {
	ticket_id: string;
	message_id: string;
	site_id: string;
	site: string;
	subject?: string;
	body: string;
	reason: string;
	staging_url?: string;
	user_email: string;
	user_name: string;
	created_at: string;
};

/** Fire-and-forget client disapproval webhook to Command Center. */
export async function notifySupportDisapproval(msg: SupportDisapprovalNotify): Promise<void> {
	await postSigned({
		type: "disapproval",
		ticket_id: msg.ticket_id,
		message_id: msg.message_id,
		site_id: msg.site_id,
		site: msg.site,
		subject: msg.subject || "",
		body: msg.body,
		message: msg.body,
		reason: msg.reason,
		staging_url: msg.staging_url || "",
		status: "changes_requested",
		user_email: msg.user_email,
		user_name: msg.user_name,
		created_at: msg.created_at,
	});
}

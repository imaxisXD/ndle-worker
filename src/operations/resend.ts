import { sha256Hex } from "../crypto";
import { type OperationsBindings, readJson, record } from "./probes";

export async function sendEmail(
	env: OperationsBindings,
	sendRequest: typeof fetch,
	idempotencyKey: string,
	email: { subject: string; text: string; html: string },
): Promise<string> {
	// Hash the bounded signature to keep Resend's key under 256 characters.
	const key = await sha256Hex(
		`${idempotencyKey}/${env.OPS_ALERT_FROM}/${env.OPS_ALERT_TO}`,
	);
	const response = await sendRequest("https://api.resend.com/emails", {
		method: "POST",
		signal: AbortSignal.timeout(10_000),
		redirect: "manual",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
			"Idempotency-Key": `ndle-operations/${key}`,
		},
		body: JSON.stringify({
			from: env.OPS_ALERT_FROM,
			to: [env.OPS_ALERT_TO],
			subject: email.subject,
			text: email.text,
			html: email.html,
		}),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			`NDLE alert email was not accepted (HTTP ${response.status})`,
		);
	}
	const receipt = record(await readJson(response));
	if (typeof receipt.id !== "string" || !receipt.id) {
		throw new Error(
			`NDLE alert email was not accepted (HTTP ${response.status})`,
		);
	}
	return receipt.id;
}

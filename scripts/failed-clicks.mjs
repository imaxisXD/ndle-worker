// Run explicitly as an operator tool; no credentials are logged.
// Usage and required environment variables are documented in README.md.
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRequire = createRequire(join(project, "package.json"));
const wranglerRequire = createRequire(
	projectRequire.resolve("wrangler/package.json"),
);
const { build } = wranglerRequire("esbuild");
const [command, sourceQueue, messageId, decisionFile] = process.argv.slice(2);
if (!["inspect", "replay", "resolve", "resolve-invalid"].includes(command)) {
	throw new Error(
		"Use inspect, replay, resolve, or resolve-invalid, followed by the exact source queue and message ID",
	);
}
const required = (name) => {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} before running this command`);
	return value;
};
const account = required("CLOUDFLARE_ACCOUNT_ID");
const token = required("CLOUDFLARE_API_TOKEN");
const bucketName = required("FAILED_CLICK_BUCKET");
const mainQueue = required("CLICK_EVENTS_QUEUE_NAME");
const failedQueue = required("CLICK_EVENTS_FAILED_QUEUE_NAME");
if (![mainQueue, failedQueue].includes(sourceQueue))
	throw new Error("Source queue does not match the selected environment");
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}`;
async function api(path, options = {}) {
	return fetch(`${apiRoot}${path}`, {
		...options,
		redirect: "manual",
		signal: AbortSignal.timeout(20_000),
		headers: { Authorization: `Bearer ${token}`, ...options.headers },
	});
}
const objectPath = (key) =>
	`/r2/buckets/${encodeURIComponent(bucketName)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
// These are the R2 object operations used by the installed Wrangler CLI.
const bucket = {
	async get(key) {
		const response = await api(objectPath(key));
		if (response.status === 404) return null;
		if (!response.ok)
			throw new Error(`R2 read failed (HTTP ${response.status})`);
		const text = await response.text();
		return {
			size: new TextEncoder().encode(text).length,
			text: async () => text,
			json: async () => JSON.parse(text),
		};
	},
	async put(key, value) {
		const response = await api(objectPath(key), {
			method: "PUT",
			body: value,
			headers: { "Content-Type": "application/json", "If-None-Match": "*" },
		});
		if (response.status === 412) return null;
		if (!response.ok)
			throw new Error(`R2 write failed (HTTP ${response.status})`);
		return {};
	},
	async delete(key) {
		if (!key.startsWith("failed-clicks/v1/unresolved/"))
			throw new Error("This tool can only remove investigation markers");
		const response = await api(objectPath(key), { method: "DELETE" });
		if (!response.ok && response.status !== 404)
			throw new Error(`R2 marker removal failed (HTTP ${response.status})`);
	},
};
const temporary = await mkdtemp(join(tmpdir(), "ndle-failed-clicks-"));
try {
	const library = join(temporary, "recovery.mjs");
	await build({
		entryPoints: [join(project, "src/failed-click-recovery.ts")],
		bundle: true,
		outfile: library,
		format: "esm",
		platform: "node",
		target: "node22",
	});
	const recovery = await import(pathToFileURL(library).href);
	if (typeof messageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId))
		throw new Error("Supply the exact original message ID");
	const key = `failed-clicks/v1/archive/${sourceQueue}/${messageId}.json`;
	if (command === "inspect") {
		const archive = await recovery.readFailedArchive(bucket, key);
		const text = JSON.stringify(archive);
		console.log(
			JSON.stringify({
				key,
				eventId: archive.eventId,
				source: archive.source,
				reason: archive.reason,
				bodySha256: archive.bodySha256,
			}),
		);
		if (decisionFile)
			await writeFile(resolve(decisionFile), text, { mode: 0o600, flag: "wx" });
	} else if (command === "replay") {
		const queueId = required("CLICK_EVENTS_QUEUE_ID");
		const lookup = await api(`/queues/${encodeURIComponent(queueId)}`);
		const queue = await lookup.json();
		if (
			!lookup.ok ||
			queue.success !== true ||
			queue.result?.queue_name !== mainQueue
		)
			throw new Error("Main queue ID and name do not match");
		const result = await recovery.replayFailedClick(key, bucket, {
			async send(body) {
				const response = await api(
					`/queues/${encodeURIComponent(queueId)}/messages`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							body,
							content_type: "json",
						}),
					},
				);
				if (!response.ok || (await response.json()).success !== true)
					throw new Error(
						"Replay acceptance was not confirmed; retrying the unchanged event is safe",
					);
			},
		});
		console.log(JSON.stringify(result));
	} else if (command === "resolve") {
		console.log(
			JSON.stringify(
				await recovery.resolveFailedClick(
					key,
					bucket,
					{
						INGEST_ENDPOINT: process.env.INGEST_ENDPOINT,
						API_SECRET: process.env.API_SECRET,
						CONVEX_URL: process.env.CONVEX_URL,
						SHARED_SECRET: process.env.SHARED_SECRET,
					},
					required("RECOVERY_OPERATOR"),
				),
			),
		);
	} else {
		if (!decisionFile)
			throw new Error(
				"Supply a JSON decision file containing operator and reason",
			);
		const decision = JSON.parse(await readFile(decisionFile, "utf8"));
		console.log(
			JSON.stringify(
				await recovery.resolveInvalidFailedClick(key, bucket, decision),
			),
		);
	}
} finally {
	await rm(temporary, { recursive: true, force: true });
}

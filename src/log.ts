import type { Context } from "hono";

type LogLevel = "debug" | "info" | "warn" | "error";
type ConfiguredLogLevel = LogLevel | "silent";

const levels: Record<ConfiguredLogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: Number.POSITIVE_INFINITY,
};

export type RequestLogger = {
	[level in LogLevel]: (
		message: string,
		fields?: Record<string, unknown>,
	) => void;
};

export function createLogger(
	configuredLevel?: string,
	baseFields: Record<string, unknown> = {},
): RequestLogger {
	const threshold =
		levels[configuredLevel as ConfiguredLogLevel] ?? levels.info;
	const write = (
		level: LogLevel,
		message: string,
		fields?: Record<string, unknown>,
	) => {
		if (levels[level] < threshold) return;
		console[level](
			JSON.stringify(
				{
					...baseFields,
					...fields,
					level,
					message,
					time: new Date().toISOString(),
				},
				(_key, value: unknown) =>
					value instanceof Error
						? { name: value.name, message: value.message, stack: value.stack }
						: value,
			),
		);
	};
	return {
		debug: (message, fields) => write("debug", message, fields),
		info: (message, fields) => write("info", message, fields),
		warn: (message, fields) => write("warn", message, fields),
		error: (message, fields) => write("error", message, fields),
	};
}

export function createRequestLogger(
	c: Context,
	requestUrl: URL,
	fields?: Record<string, unknown>,
): RequestLogger {
	return createLogger(c.env.LOG_LEVEL, {
		method: c.req.method,
		path: requestUrl.pathname,
		cf_ray: c.req.header("cf-ray"),
		...fields,
	});
}

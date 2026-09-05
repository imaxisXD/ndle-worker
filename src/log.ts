import type { Context } from "hono";

type LogLevel = "debug" | "info" | "warn" | "error";
const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export type RequestLogger = {
	[level in LogLevel]: (
		message: string,
		fields?: Record<string, unknown>,
	) => void;
} & { child: (fields: Record<string, unknown>) => RequestLogger };

export function createLogger(
	configuredLevel?: string,
	baseFields: Record<string, unknown> = {},
): RequestLogger {
	const threshold = levels[configuredLevel as LogLevel] ?? levels.info;
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
		child: (fields) =>
			createLogger(configuredLevel, { ...baseFields, ...fields }),
	};
}

export function createRequestLogger(
	c: Context,
	fields?: Record<string, unknown>,
): RequestLogger {
	return createLogger(c.env.LOG_LEVEL, {
		method: c.req.method,
		path: new URL(c.req.url).pathname,
		cf_ray: c.req.header("cf-ray"),
		...fields,
	});
}

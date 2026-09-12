import { describe, expect, it } from 'vitest';
import { createLogger, type LogLevel } from '../src/index.ts';

interface Written {
	readonly level: LogLevel;
	readonly line: string;
}

function sink() {
	const lines: Written[] = [];
	return {
		lines,
		write: (level: LogLevel, line: string) => lines.push({ level, line }),
	};
}

function records(lines: readonly Written[]): Record<string, unknown>[] {
	return lines.map(
		(entry) => JSON.parse(entry.line) as Record<string, unknown>,
	);
}

describe('createLogger', () => {
	it('writes one json line per event', () => {
		const target = sink();
		const logger = createLogger({
			format: 'json',
			environment: {},
			write: target.write,
			now: () => new Date('2026-09-11T10:00:00.000Z'),
		});

		logger.info('module composed', {
			requestId: 'request-1',
			endpoint: 'system.health',
			module: 'system.core',
		});

		expect(target.lines).toHaveLength(1);
		expect(records(target.lines)[0]).toEqual({
			time: '2026-09-11T10:00:00.000Z',
			level: 'info',
			msg: 'module composed',
			requestId: 'request-1',
			endpoint: 'system.health',
			module: 'system.core',
		});
	});

	it('reports the error name and message without a stack in production', () => {
		const target = sink();
		const logger = createLogger({
			environment: { NODE_ENV: 'production' },
			write: target.write,
		});

		logger.error('repository failed', { err: new TypeError('bad column') });

		const [record] = records(target.lines);
		expect(logger.format).toBe('json');
		expect(record?.err).toEqual({ name: 'TypeError', message: 'bad column' });
	});

	it('keeps the stack when the operator asked for debug output', () => {
		const target = sink();
		const logger = createLogger({
			environment: { NODE_ENV: 'production', FD_LOG_LEVEL: 'debug' },
			write: target.write,
		});

		logger.error('repository failed', { err: new Error('bad column') });

		const error = records(target.lines)[0]?.err as { stack?: string };
		expect(error.stack).toContain('Error: bad column');
	});

	it('drops events below the configured level', () => {
		const target = sink();
		const logger = createLogger({
			format: 'json',
			environment: { FD_LOG_LEVEL: 'warn' },
			write: target.write,
		});

		logger.debug('poll started');
		logger.info('poll finished');
		logger.warn('poll slow');
		logger.error('poll failed');

		expect(target.lines.map((entry) => entry.level)).toEqual(['warn', 'error']);
	});

	it('redacts credential-shaped field names at any depth', () => {
		const target = sink();
		const logger = createLogger({
			format: 'json',
			environment: {},
			write: target.write,
		});

		logger.warn('provider call rejected', {
			fields: {
				authorization: 'Bearer sk-live-1',
				cookie: 'fd_session=abc',
				password: 'hunter2',
				token: 'sk-live-2',
				status: 401,
				headers: {
					Authorization: 'Bearer sk-live-3',
					accept: 'application/json',
				},
			},
		});

		const [record] = records(target.lines);
		expect(record?.fields).toEqual({
			authorization: '[redacted]',
			cookie: '[redacted]',
			password: '[redacted]',
			token: '[redacted]',
			status: 401,
			headers: { Authorization: '[redacted]', accept: 'application/json' },
		});
		expect(target.lines[0]?.line).not.toContain('sk-live-');
		expect(target.lines[0]?.line).not.toContain('hunter2');
	});

	it('bounds a field graph instead of following it', () => {
		const target = sink();
		const logger = createLogger({
			format: 'json',
			environment: {},
			write: target.write,
		});
		const cycle: Record<string, unknown> = { name: 'root' };
		cycle.self = cycle;

		logger.info('inspect', { fields: { cycle, items: Array(64).fill('x') } });

		const fields = records(target.lines)[0]?.fields as {
			items: readonly unknown[];
		};
		expect(fields.items).toHaveLength(33);
		expect(fields.items.at(-1)).toBe('[truncated]');
	});

	it('defaults to a text line outside production', () => {
		const target = sink();
		const logger = createLogger({
			environment: {},
			write: target.write,
			now: () => new Date('2026-09-11T10:00:00.000Z'),
		});

		logger.error('endpoint failed', {
			requestId: 'request-1',
			endpoint: 'system.secret',
			err: { name: 'Error' },
		});

		expect(logger.format).toBe('text');
		expect(target.lines[0]?.line).toBe(
			'2026-09-11T10:00:00.000Z ERROR endpoint failed requestId=request-1 endpoint=system.secret err=Error',
		);
	});

	it('cannot be split into a second line by a request id from a header', () => {
		const target = sink();
		const logger = createLogger({
			environment: {},
			write: target.write,
		});

		logger.error('endpoint failed', {
			requestId: 'abc\n2026-09-11T10:00:00.000Z ERROR forged',
		});

		expect(target.lines[0]?.line.split('\n')).toHaveLength(1);
		expect(target.lines[0]?.line).toContain('requestId=abc 2026');
	});

	it('falls back to the default when the environment names an unknown level', () => {
		const target = sink();
		const logger = createLogger({
			format: 'json',
			environment: { FD_LOG_LEVEL: 'chatty' },
			write: target.write,
		});

		expect(logger.level).toBe('info');
		expect(records(target.lines)[0]).toMatchObject({
			level: 'warn',
			fields: { level: 'info' },
		});
	});
});

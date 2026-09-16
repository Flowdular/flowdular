import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AGENT_ROLES,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@flowdular/coding-agent';
import {
	addAttachment,
	materializeAttachments,
	removeAttachment,
} from '../src/server/attachments.ts';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import {
	MAX_SAMPLE_LISTING_BYTES,
	MAX_SAMPLE_PREVIEW_BYTES,
	SAMPLE_DATA_ROWS,
	previewSampleData,
	readSampleData,
	sampleDataInstruction,
} from '../src/server/sample-data.ts';
import {
	createSession,
	deleteSession,
	readSession,
	sessionPaths,
} from '../src/server/sessions.ts';
import { runTurn, type TurnContext } from '../src/server/turns.ts';

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-sample-data-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	return root;
}

async function sessionFor(root: string) {
	return createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'booking.core',
		title: 'Room booking',
		brief: 'Let people book meeting rooms.',
		blueprint: 'new-module@1.0.0',
		role: 'business-manager',
		driver: 'fake',
		install: false,
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function csv(rows: number): string {
	const lines = ['name,email,note'];
	for (let index = 1; index <= rows; index += 1)
		lines.push(
			`Room ${index},room${index}@example.test,"floor ${index}, east"`,
		);
	return `${lines.join('\r\n')}\r\n`;
}

describe('sample data previews', () => {
	it('parses quoted CSV and keeps the header and the first rows', () => {
		const preview = previewSampleData(
			'rooms.csv',
			`\uFEFFname,note\n"Atlas","has ""quotes"", commas\nand a line break"\n\nBorealis,plain\n`,
		);
		expect(preview).toMatchObject({
			format: 'csv',
			delimiter: ',',
			columns: ['name', 'note'],
			rows: [
				['Atlas', 'has "quotes", commas\nand a line break'],
				['Borealis', 'plain'],
			],
			rowCount: 2,
			truncated: false,
		});

		const long = previewSampleData('rooms.csv', csv(25));
		expect(long.rowCount).toBe(25);
		expect(long.rows).toHaveLength(SAMPLE_DATA_ROWS);
		expect(long.rows[19]).toEqual([
			'Room 20',
			'room20@example.test',
			'floor 20, east',
		]);
		expect(long.truncated).toBe(true);
	});

	it('detects a semicolon delimiter and bounds long cells', () => {
		const preview = previewSampleData(
			'export.csv',
			`Nazwa;Kwota\nFaktura;${'9'.repeat(500)}\n`,
		);
		expect(preview.delimiter).toBe(';');
		expect(preview.columns).toEqual(['Nazwa', 'Kwota']);
		expect((preview.rows[0] as string[])[1]).toHaveLength(203);
		expect(preview.truncated).toBe(true);
	});

	it('previews a JSON array, a collection inside an object and invalid JSON', () => {
		const items = Array.from({ length: 30 }, (_, index) => ({
			id: index,
			name: `Room ${index}`,
			...(index === 1 ? { floor: 2 } : {}),
		}));
		const array = previewSampleData('rooms.json', JSON.stringify(items));
		expect(array).toMatchObject({
			format: 'json',
			path: '$',
			rowCount: 30,
			columns: ['id', 'name', 'floor'],
			truncated: true,
		});
		expect(array.rows).toHaveLength(SAMPLE_DATA_ROWS);

		const nested = previewSampleData(
			'export.json',
			JSON.stringify({ exportedAt: '2026-09-16', customers: [{ id: 'c1' }] }),
		);
		expect(nested).toMatchObject({
			path: '$.customers',
			rowCount: 1,
			rows: [{ id: 'c1' }],
		});

		expect(previewSampleData('broken.json', '{ nope').error).toMatch(
			/not valid JSON/,
		);
	});

	it('previews text as lines and keeps a wide file under its byte budget', () => {
		expect(previewSampleData('page.txt', 'one\r\ntwo\n')).toMatchObject({
			format: 'text',
			rowCount: 2,
			rows: ['one', 'two'],
		});
		const wide = previewSampleData(
			'wide.csv',
			[
				Array.from({ length: 60 }, (_, index) => `c${index}`).join(','),
				...Array.from({ length: 20 }, () =>
					Array.from({ length: 60 }, () => 'x'.repeat(300)).join(','),
				),
			].join('\n'),
		);
		expect(wide.columns).toHaveLength(40);
		expect(wide.rows.length).toBeLessThan(SAMPLE_DATA_ROWS);
		expect(Buffer.byteLength(JSON.stringify(wide))).toBeLessThanOrEqual(
			MAX_SAMPLE_PREVIEW_BYTES,
		);
		expect(wide.truncated).toBe(true);
	});
});

function capturingDriver(sink: {
	request?: CodingAgentTurnRequest;
	input?: Record<string, unknown>;
	answer?: string | undefined;
	reference?: string | undefined;
}): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			sink.request = request;
			const tool = request.tools?.find((entry) => entry.name === 'sample-data');
			sink.answer = await tool?.execute(sink.input ?? {});
			sink.reference = await readFile(
				join(request.workspacePath, 'reference/sample-data.json'),
				'utf8',
			).catch(() => undefined);
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			yield {
				type: 'assistant.message',
				text: 'Read the sample.\n\nHANDOFF: none - done',
			};
			yield {
				type: 'turn.completed',
				resumeId: null,
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				costUsd: null,
				finishReason: 'stop',
			};
		},
	};
}

function turnContext(root: string, driver: CodingAgentDriver): TurnContext {
	return {
		workspaceRoot: root,
		configuration: { ...DEFAULT_CONFIGURATION, driver: driver.id },
		registry: createCodingAgentRegistry({
			mode: 'loopback',
			drivers: [driver],
		}),
		roles: DEFAULT_AGENT_ROLES,
		platform: null,
		installDependencies: async () => ({
			ran: false,
			ok: true,
			durationMs: 0,
			output: '',
		}),
		executeGates: async () => [],
	};
}

async function drain(turn: AsyncGenerator<unknown, unknown>): Promise<void> {
	for (;;) if ((await turn.next()).done) return;
}

describe('the sample-data tool in a turn', () => {
	it('lends the tool, leaves the listing in reference and deletes it with the session', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		await addAttachment(root, session, {
			name: 'rooms.csv',
			bytes: Buffer.from(csv(25)),
		});
		await addAttachment(root, session, {
			name: 'concept.md',
			bytes: Buffer.from('# concept\n'),
		});
		const sink: Parameters<typeof capturingDriver>[0] = {
			input: { name: 'rooms.csv' },
		};
		await drain(
			runTurn(turnContext(root, capturingDriver(sink)), {
				sessionId: session.id,
				message: 'Model the rooms from the sample.',
				role: 'business-manager',
			}),
		);

		expect(sink.request?.tools?.map((tool) => tool.name)).toEqual([
			'sample-data',
		]);
		expect(sink.request?.prompt).toContain('Sample data: rooms.csv.');
		expect(sink.request?.prompt).toContain('preview/seed.json');
		const answer = JSON.parse(sink.answer!) as {
			sampleData: { name: string; rowCount: number; rows: unknown[] }[];
		};
		expect(answer.sampleData).toHaveLength(1);
		expect(answer.sampleData[0]).toMatchObject({
			name: 'rooms.csv',
			rowCount: 25,
			columns: ['name', 'email', 'note'],
		});
		expect(answer.sampleData[0]!.rows).toHaveLength(SAMPLE_DATA_ROWS);
		expect(JSON.parse(sink.reference!)).toEqual(
			await readSampleData(
				sink.request!.workspacePath,
				(await readSession(root, session.id)).attachments,
			),
		);

		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await expect(
			sink.request!.tools![0]!.execute({ name: 'concept.md' }),
		).rejects.toMatchObject({ code: 'SAMPLE_DATA_NOT_FOUND' });
		expect(
			await exists(join(paths.workspace, 'reference/sample-data.json')),
		).toBe(true);
		await deleteSession(root, session.id, { keepTranscript: false });
		expect(await exists(paths.root)).toBe(false);
	});

	it('lends nothing and removes a stale listing when no sample data is attached', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		const sink: Parameters<typeof capturingDriver>[0] = {};
		await addAttachment(root, session, {
			name: 'rooms.json',
			bytes: Buffer.from('[{"name":"Atlas"}]'),
		});
		await drain(
			runTurn(turnContext(root, capturingDriver(sink)), {
				sessionId: session.id,
				message: 'First turn.',
				role: 'business-manager',
			}),
		);
		expect(sink.reference).toContain('Atlas');
		const [attachment] = (await readSession(root, session.id)).attachments;
		await removeAttachment(root, session, attachment!.id);

		await drain(
			runTurn(turnContext(root, capturingDriver(sink)), {
				sessionId: session.id,
				message: 'Second turn.',
				role: 'business-manager',
			}),
		);
		expect(sink.request?.tools).toBeUndefined();
		expect(sink.request?.prompt).not.toContain('Sample data');
		expect(
			await exists(join(paths.workspace, 'reference/sample-data.json')),
		).toBe(false);
	});

	it('bounds the listing and points at the tool for the rows it left out', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		const wide = [
			Array.from({ length: 40 }, (_, index) => `c${index}`).join(','),
			...Array.from({ length: 20 }, () =>
				Array.from({ length: 40 }, () => 'y'.repeat(35)).join(','),
			),
		].join('\n');
		for (const name of ['a.csv', 'b.csv', 'c.csv', 'd.csv'])
			await addAttachment(root, session, { name, bytes: Buffer.from(wide) });
		const current = await readSession(root, session.id);
		await materializeAttachments(root, current);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		const listing = await readSampleData(paths.workspace, current.attachments);
		expect(
			Buffer.byteLength(JSON.stringify(listing.sampleData)),
		).toBeLessThanOrEqual(MAX_SAMPLE_LISTING_BYTES + 2_048);
		const omitted = listing.sampleData.filter((entry) => entry.note);
		expect(omitted.length).toBeGreaterThan(0);
		expect(omitted[0]).toMatchObject({ rows: [], rowCount: 20 });
		expect(omitted[0]!.note).toContain('sample-data');
		expect(sampleDataInstruction(current.attachments)).toContain(
			'a.csv, b.csv, c.csv, d.csv',
		);
	});
});

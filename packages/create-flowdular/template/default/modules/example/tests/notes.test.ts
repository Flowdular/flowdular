import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NoteService, NoteServiceError } from '../src/services/note-service.ts';
import {
	closeExampleTestDatabases,
	createExampleTestDatabase,
	type ExampleTestDatabase,
} from './support/database.ts';

const databases = new Set<ExampleTestDatabase>();

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeExampleTestDatabases);

async function fixture(): Promise<ExampleTestDatabase> {
	const database = await createExampleTestDatabase();
	databases.add(database);
	return database;
}

describe('example notes', () => {
	it('lists only the notes the active tenant owns', async () => {
		const service = new NoteService((await fixture()).repository);
		await service.create('tenant-a', { title: 'A', body: 'Owned by A' });
		await service.create('tenant-b', { title: 'B', body: 'Owned by B' });

		expect((await service.list('tenant-a')).map((note) => note.title)).toEqual([
			'A',
		]);
		expect((await service.list('tenant-b')).map((note) => note.title)).toEqual([
			'B',
		]);
	});

	it('normalizes the BIGINT timestamp PostgreSQL returns as a string', async () => {
		const service = new NoteService((await fixture()).repository);
		const created = await service.create('tenant-a', {
			title: 'Timestamps',
			body: 'One note',
		});

		const [read] = await service.list('tenant-a');
		expect(read?.createdAt).toBe(created.createdAt);
		expect(typeof read?.createdAt).toBe('number');
	});

	it('returns the newest note first', async () => {
		let clock = 1_000;
		const service = new NoteService(
			(await fixture()).repository,
			() => (clock += 1_000),
		);
		await service.create('tenant-a', { title: 'First', body: 'x' });
		await service.create('tenant-a', { title: 'Second', body: 'y' });

		expect((await service.list('tenant-a')).map((note) => note.title)).toEqual([
			'Second',
			'First',
		]);
	});

	it('refuses a query that carries no tenant context', async () => {
		const database = await fixture();

		await expect(
			database.runtime.query({ text: 'SELECT 1 FROM example_notes' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('rejects an empty title and a title longer than the column allows', async () => {
		const service = new NoteService((await fixture()).repository);

		await expect(async () =>
			service.create('tenant-a', { title: '   ', body: 'x' }),
		).rejects.toBeInstanceOf(NoteServiceError);
		await expect(async () =>
			service.create('tenant-a', { title: 'x'.repeat(121), body: 'x' }),
		).rejects.toBeInstanceOf(NoteServiceError);
	});
});

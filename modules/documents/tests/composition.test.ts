import { describe, expect, it } from 'vitest';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import { createServerComposition } from '../src/platform.ts';

function context(environment: Readonly<Record<string, string>>) {
	const registered: string[] = [];
	const tools: string[] = [];
	const classes: string[] = [];
	const value = {
		environment: { NODE_ENV: 'test', ...environment },
		workspaceRoot: process.cwd(),
		auth: {},
		settings: {},
		storage: {},
		databases: {
			acquire: () => Promise.reject(new Error('No database in this case.')),
			dispose: () => Promise.resolve(),
		},
		agentTools: {
			register: (entries: readonly { id: string }[]) =>
				tools.push(...entries.map((entry) => entry.id)),
		},
		dataClasses: {
			declare: (declared: readonly { key: string }[]) =>
				classes.push(...declared.map((entry) => entry.key)),
		},
		capabilities: {
			register: (id: string) => registered.push(id),
			get: () => null,
		},
	};
	return {
		context: value as unknown as PlatformServerContext,
		registered,
		tools,
		classes,
	};
}

describe('documents composition', () => {
	it('DOCUMENTS-TEXT-OCR refuses to compose with an OCR URL the egress rules would refuse', () => {
		expect(() =>
			createServerComposition(
				context({ FD_DOCUMENTS_OCR_URL: 'http://ocr.example.com/read' })
					.context,
			),
		).toThrow(/FD_DOCUMENTS_OCR_URL/);
	});

	it('DOCUMENTS-TEXT-FORMATS registers the text capability, the agent tool and the text data class', async () => {
		const composed = context({
			FD_DOCUMENTS_OCR_URL: 'https://ocr.example.com/read',
		});
		const composition = createServerComposition(composed.context);
		expect(composed.registered).toEqual([
			'documents.attachments.v1',
			'documents.text.v1',
		]);
		expect(composed.tools).toEqual(['documents.read-text']);
		expect(composed.classes).toEqual(['documents', 'text']);
		expect(
			composition.routes
				.map((route) => route.path)
				.filter((path) => path.includes('/text')),
		).toEqual(['/api/documents/text', '/api/documents/text/retry']);
		expect(composition.start).toBeTypeOf('function');
		expect(composition.stop).toBeTypeOf('function');
		await composition.dispose?.();
	});
});

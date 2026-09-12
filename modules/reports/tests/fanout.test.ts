import { describe, expect, it } from 'vitest';
import { REPORT_PROVIDER_LIMITS } from '../src/domain/providers.ts';
import {
	createHarness,
	fakeProvider,
	principal,
	series,
	TEST_RANGE,
	tile,
} from './support/harness.ts';

const USAGE = 'metering.usage.read';
const RUNS = 'agents.runs.read';

describe('REPORTS-FANOUT', () => {
	it('answers with the other providers and names the slow one unavailable', async () => {
		const harness = createHarness({
			budget: { providerTimeoutMs: 200 },
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({
							key: 'metering.usage',
							permission: USAGE,
							answer: { tiles: [tile('requests', 42)] },
						}),
					],
				},
				{
					moduleId: 'agents.core',
					providers: [
						fakeProvider({ key: 'agents.runs', permission: RUNS, hangs: true }),
					],
				},
			],
		});

		const started = Date.now();
		const page = await harness.service.read({
			principal: principal([USAGE, RUNS]),
			range: TEST_RANGE,
		});

		expect(page.reports.map((report) => report.key)).toEqual([
			'metering.usage',
		]);
		expect(page.reports[0]!.tiles.map((entry) => entry.value)).toEqual([42]);
		expect(page.unavailable).toEqual(['agents.runs']);
		/* The budget bounds the wait: the report settles near it, not at whatever
		   the slow provider would eventually have taken. */
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it('aborts the signal it handed the slow provider', async () => {
		let observed: AbortSignal | undefined;
		const harness = createHarness({
			budget: { providerTimeoutMs: 200 },
			providers: [
				{
					moduleId: 'agents.core',
					providers: [
						fakeProvider({
							key: 'agents.runs',
							permission: RUNS,
							hangs: true,
							onCall: (input) => {
								observed = input.signal;
							},
						}),
					],
				},
			],
		});

		await harness.service.read({
			principal: principal([RUNS]),
			range: TEST_RANGE,
		});

		expect(observed?.aborted).toBe(true);
	});

	/* A provider that validates before its first await throws while reports.core
	   is still on its own stack; the fan-out has to survive that the same way it
	   survives a rejection, or one module's guard clause loses the whole report. */
	it('names a provider that threw before awaiting and keeps the report', async () => {
		const harness = createHarness({
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({
							key: 'metering.usage',
							permission: USAGE,
							answer: { tiles: [tile('requests', 7)] },
						}),
						fakeProvider({
							key: 'metering.broken',
							permission: USAGE,
							throwsSynchronously: true,
						}),
					],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([USAGE]),
			range: TEST_RANGE,
		});

		expect(page.reports.map((report) => report.key)).toEqual([
			'metering.usage',
		]);
		expect(page.unavailable).toEqual(['metering.broken']);
	});

	it('names a provider that rejected and keeps the report', async () => {
		const harness = createHarness({
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({
							key: 'metering.usage',
							permission: USAGE,
							answer: { tiles: [tile('requests', 7)] },
						}),
						fakeProvider({
							key: 'metering.broken',
							permission: USAGE,
							fails: true,
						}),
					],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([USAGE]),
			range: TEST_RANGE,
		});

		expect(page.reports.map((report) => report.key)).toEqual([
			'metering.usage',
		]);
		expect(page.unavailable).toEqual(['metering.broken']);
	});

	it('keeps registration order and echoes the range it was asked for', async () => {
		const harness = createHarness({
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({ key: 'metering.usage', permission: USAGE }),
					],
				},
				{
					moduleId: 'agents.core',
					providers: [fakeProvider({ key: 'agents.runs', permission: RUNS })],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([RUNS, USAGE]),
			range: TEST_RANGE,
		});

		expect(page.reports.map((report) => report.key)).toEqual([
			'metering.usage',
			'agents.runs',
		]);
		expect(page.range).toEqual(TEST_RANGE);
	});
});

describe('REPORTS-PERMISSION', () => {
	it('never calls a provider whose permission the reader lacks', async () => {
		const asked: string[] = [];
		const harness = createHarness({
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({
							key: 'metering.usage',
							permission: USAGE,
							onCall: () => asked.push('metering.usage'),
						}),
					],
				},
				{
					moduleId: 'agents.core',
					providers: [
						fakeProvider({
							key: 'agents.runs',
							permission: RUNS,
							onCall: () => asked.push('agents.runs'),
						}),
					],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([USAGE]),
			range: TEST_RANGE,
		});

		expect(asked).toEqual(['metering.usage']);
		expect(page.reports.map((report) => report.key)).toEqual([
			'metering.usage',
		]);
		/* Absent, not unavailable: the report must not reveal that a provider
		   the reader may not see exists at all. */
		expect(page.unavailable).toEqual([]);
		expect(
			harness.service.providers(principal([USAGE])).map((entry) => entry.key),
		).toEqual(['metering.usage']);
	});

	it('asks nobody when the reader holds no provider permission', async () => {
		const asked: string[] = [];
		const harness = createHarness({
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({
							key: 'metering.usage',
							permission: USAGE,
							onCall: () => asked.push('metering.usage'),
						}),
					],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal(['reports.workspace.read']),
			range: TEST_RANGE,
		});

		expect(asked).toEqual([]);
		expect(page.reports).toEqual([]);
		expect(page.unavailable).toEqual([]);
	});
});

describe('REPORTS-BOUNDS answer', () => {
	const over = {
		tiles: {
			tiles: Array.from(
				{ length: REPORT_PROVIDER_LIMITS.tiles + 1 },
				(_entry, index) => tile(`t-${index}`, index),
			),
		},
		series: {
			tiles: [tile('ok', 1)],
			series: Array.from(
				{ length: REPORT_PROVIDER_LIMITS.series + 1 },
				(_entry, index) => series(`s-${index}`, 1),
			),
		},
		points: {
			tiles: [tile('ok', 1)],
			series: [series('daily', REPORT_PROVIDER_LIMITS.points + 1)],
		},
		labelKey: {
			tiles: [
				{
					key: 'ok',
					label: 'Ok',
					tileLabelKey: 'x'.repeat(REPORT_PROVIDER_LIMITS.key + 1),
					value: 1,
				},
			],
		},
		period: {
			tiles: [tile('ok', 1)],
			period: {
				from: 'x'.repeat(REPORT_PROVIDER_LIMITS.at + 1),
				to: '2026-09-30',
			},
		},
		shape: { tiles: [{ key: 'broken', label: 'Broken' }] as never },
	};

	for (const [name, answer] of Object.entries(over)) {
		it(`makes only the provider over the ${name} bound unavailable`, async () => {
			const harness = createHarness({
				providers: [
					{
						moduleId: 'metering.core',
						providers: [
							fakeProvider({
								key: 'metering.usage',
								permission: USAGE,
								answer: { tiles: [tile('requests', 3)] },
							}),
						],
					},
					{
						moduleId: 'agents.core',
						providers: [
							fakeProvider({ key: 'agents.runs', permission: RUNS, answer }),
						],
					},
				],
			});

			const page = await harness.service.read({
				principal: principal([USAGE, RUNS]),
				range: TEST_RANGE,
			});

			expect(page.unavailable).toEqual(['agents.runs']);
			expect(page.reports.map((report) => report.key)).toEqual([
				'metering.usage',
			]);
		});
	}

	it('accepts an answer exactly at every bound', async () => {
		const harness = createHarness({
			providers: [
				{
					moduleId: 'agents.core',
					providers: [
						fakeProvider({
							key: 'agents.runs',
							permission: RUNS,
							answer: {
								tiles: Array.from(
									{ length: REPORT_PROVIDER_LIMITS.tiles },
									(_entry, index) => tile(`t-${index}`, index),
								),
								series: Array.from(
									{ length: REPORT_PROVIDER_LIMITS.series },
									(_entry, index) =>
										series(`s-${index}`, REPORT_PROVIDER_LIMITS.points),
								),
							},
						}),
					],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([RUNS]),
			range: TEST_RANGE,
		});

		expect(page.unavailable).toEqual([]);
		expect(page.reports[0]!.tiles).toHaveLength(REPORT_PROVIDER_LIMITS.tiles);
		expect(page.reports[0]!.series).toHaveLength(REPORT_PROVIDER_LIMITS.series);
		expect(page.reports[0]!.series[0]!.points).toHaveLength(
			REPORT_PROVIDER_LIMITS.points,
		);
	});

	/* Only what the contract names reaches a response: a provider that adds a
	   field cannot smuggle it into the report. */
	it('drops a field the tile contract does not carry', async () => {
		const harness = createHarness({
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({
							key: 'metering.usage',
							permission: USAGE,
							answer: {
								tiles: [
									{
										key: 'requests',
										label: 'Requests',
										value: 5,
										secret: 'tenant-b',
									} as never,
								],
							},
						}),
					],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([USAGE]),
			range: TEST_RANGE,
		});

		expect(page.reports[0]!.tiles).toEqual([
			{ key: 'requests', label: 'Requests', value: 5 },
		]);
	});
});

describe('REPORTS-LABELS', () => {
	/* The screen resolves a label key against the owning module's own bundle,
	   so the key has to survive the answer reader beside the literal it falls
	   back to. */
	it('carries the label keys of the provider, its tiles and its series', async () => {
		const harness = createHarness({
			providers: [
				{
					moduleId: 'agents.core',
					providers: [
						fakeProvider({
							key: 'agents.runs',
							permission: RUNS,
							label: 'Agent runs',
							labelKey: 'agents.report.runs.label',
							answer: {
								tiles: [
									{
										key: 'runs',
										label: 'Runs',
										tileLabelKey: 'agents.report.runs.tile.runs',
										value: 3,
									},
								],
								series: [
									{
										key: 'runs',
										label: 'Runs per day',
										seriesLabelKey: 'agents.report.runs.series.runs',
										points: [{ at: '2026-09-01', value: 3 }],
									},
								],
							},
						}),
					],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([RUNS]),
			range: TEST_RANGE,
		});

		expect(page.reports[0]!.labelKey).toBe('agents.report.runs.label');
		expect(page.reports[0]!.tiles[0]!.tileLabelKey).toBe(
			'agents.report.runs.tile.runs',
		);
		expect(page.reports[0]!.series[0]!.seriesLabelKey).toBe(
			'agents.report.runs.series.runs',
		);
	});
});

describe('REPORTS-PERIOD', () => {
	/* A provider that rolls up by its own period says so, and the screen
	   captions that card with the period instead of the request range. */
	it('carries the period a provider answered for and leaves it out otherwise', async () => {
		const harness = createHarness({
			providers: [
				{
					moduleId: 'metering.core',
					providers: [
						fakeProvider({
							key: 'metering.usage',
							permission: USAGE,
							answer: {
								tiles: [tile('requests', 5)],
								period: { from: '2026-09-01', to: '2026-09-30' },
							},
						}),
					],
				},
				{
					moduleId: 'agents.core',
					providers: [fakeProvider({ key: 'agents.runs', permission: RUNS })],
				},
			],
		});

		const page = await harness.service.read({
			principal: principal([USAGE, RUNS]),
			range: TEST_RANGE,
		});

		expect(page.reports[0]!.period).toEqual({
			from: '2026-09-01',
			to: '2026-09-30',
		});
		expect(page.reports[1]!.period).toBeUndefined();
		expect(page.range).toEqual(TEST_RANGE);
	});
});

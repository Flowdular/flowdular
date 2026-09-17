import { act, createRoot, setIsOctaneActEnvironment } from 'octane';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewCharts } from '../src/shell/OverviewCharts.tsrx';

setIsOctaneActEnvironment(true);

function days(counts: readonly number[]) {
	return counts.map(
		(count, index) => ({
			date: '2026-09-' + String(index + 1).padStart(2, '0'),
			count,
		}),
	);
}

async function render(activity: readonly { date: string; count: number }[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () => new Response(JSON.stringify({
				enabledModuleCount: 1,
				moduleCount: 1,
				activity,
				modules: [],
			}), { status: 200, headers: { 'content-type': 'application/json' } }),
		),
	);
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<OverviewCharts />);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const activityCard = container.querySelector('.ui-card') as HTMLElement;
	return {
		activityCard,
		unmount: () => {
			root.unmount();
			container.remove();
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Overview activity', () => {
	it('charts the events of a workspace used on a single day', async () => {
		const view = await render(days([0, 0, 0, 3]));
		expect(view.activityCard.querySelector('.ui-chart')).not.toBeNull();
		expect(view.activityCard.querySelector('.ui-empty')).toBeNull();
		view.unmount();
	});

	it('keeps the empty state for a workspace without events', async () => {
		const view = await render(days([0, 0, 0, 0]));
		expect(view.activityCard.querySelector('.ui-chart')).toBeNull();
		expect(view.activityCard.querySelector('.ui-empty')).not.toBeNull();
		view.unmount();
	});
});

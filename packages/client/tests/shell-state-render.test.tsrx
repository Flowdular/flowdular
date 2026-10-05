import { act, createRoot } from 'octane';
import { useValue } from 'segment-state';
import { expect, it } from 'vitest';
import { createShellState, type ShellState } from '../src/state.ts';

function ActiveView(props: { readonly shell: ShellState }) @{
	const [view] = useValue(props.shell.state.activeView);
	const [navigationOpen] = useValue(props.shell.state.navigationOpen);
	<output>
		{view}:{navigationOpen ? 'open' : 'closed'}
	</output>
}

it(
	'renders a committed shell state change through the Octane subscription',
	async () => {
		const shell = createShellState();
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(() => root.render(<ActiveView shell={shell} />));
			expect(container.textContent).toBe('overview:closed');

			await act(() => {
				shell.store.act((transaction) => {
					transaction.set(shell.state.activeView, 'reports');
					transaction.set(shell.state.navigationOpen, true);
				}, 'shell/navigate');
			});
			expect(container.textContent).toBe('reports:open');
		} finally {
			root.unmount();
			container.remove();
		}
	},
);

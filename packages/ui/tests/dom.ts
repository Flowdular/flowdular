import { act, createRoot, setIsOctaneActEnvironment } from 'octane';

setIsOctaneActEnvironment(true);

export interface Mounted {
	readonly container: HTMLElement;
	/** Renders and drains effects, so a clamp report or a subscription has run. */
	readonly render: (element: unknown) => Promise<void>;
	readonly unmount: () => void;
}

/** Mounts one primitive into a detached container and returns its live DOM. */
export async function mount(element: unknown): Promise<Mounted> {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	const render = async (next: unknown) => {
		await act(() => {
			root.render(next as never);
		});
	};
	await render(element);
	return {
		container,
		render,
		unmount: () => {
			root.unmount();
			container.remove();
		},
	};
}

/** Runs an interaction and drains the render and effects it caused. */
export async function run(action: () => void): Promise<void> {
	await act(action);
}

export function text(node: Element | null): string {
	return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

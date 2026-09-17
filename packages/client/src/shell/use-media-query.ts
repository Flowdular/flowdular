import { useEffect, useState } from 'octane';

/** Whether the window matches `query`. False until mounted, so the server render and hydration agree. */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(false);
	useEffect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const list = window.matchMedia(query);
		const update = () => setMatches(list.matches);
		update();
		list.addEventListener('change', update);
		return () => list.removeEventListener('change', update);
	}, [query]);
	return matches;
}

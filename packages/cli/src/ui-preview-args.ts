/**
 * What one `ui:preview` invocation asks for.
 *
 * The parsing lives here rather than in the script so the shapes a person and
 * an agent actually type are covered by tests: a fragment alone reached main
 * broken once, because every trial run had passed a flag.
 */
export interface PreviewInvocation {
	readonly fragment: string | null;
	readonly scaffold: boolean;
	readonly shot: string | null;
	readonly open: boolean;
	/** What to tell the caller instead of rendering, when the call makes no sense. */
	readonly refusal: string | null;
}

export function parsePreviewArguments(
	argv: readonly string[],
): PreviewInvocation {
	const scaffoldIndex = argv.indexOf('--scaffold');
	const shotIndex = argv.indexOf('--shot');
	const shot = shotIndex === -1 ? null : (argv[shotIndex + 1] ?? null);
	/* The value of --shot is a file, never the fragment; --scaffold names the
	   fragment it writes, so its value is the fragment. */
	const fragment =
		argv.find(
			(value, index) =>
				!value.startsWith('--') &&
				(shotIndex === -1 || index !== shotIndex + 1) &&
				(scaffoldIndex === -1 || index === scaffoldIndex + 1),
		) ?? null;
	const invocation = {
		fragment,
		scaffold: scaffoldIndex !== -1,
		shot,
		open: argv.includes('--open'),
	};
	if (shotIndex !== -1 && (shot === null || shot.startsWith('--'))) {
		return {
			...invocation,
			shot: null,
			refusal: '--shot needs a file to write.',
		};
	}
	if (!fragment) {
		return { ...invocation, refusal: 'Name the fragment to render.' };
	}
	if (invocation.scaffold && (invocation.shot || invocation.open)) {
		return {
			...invocation,
			refusal:
				'--scaffold writes a fragment; render it in a second call to see it.',
		};
	}
	return { ...invocation, refusal: null };
}

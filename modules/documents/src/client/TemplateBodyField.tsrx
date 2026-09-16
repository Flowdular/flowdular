import { useRef } from 'octane';
import { lineNumbers } from './templates-presentation.ts';

export interface TemplateBodyFieldProps {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly disabled: boolean;
	readonly invalid: boolean;
	readonly maxLength: number;
	/** Lines an issue names, marked in the gutter. */
	readonly flagged: ReadonlySet<number>;
	readonly describedBy?: string | undefined;
	readonly onInput: (value: string) => void;
}

/*
 * A monospace text area with a gutter of line numbers that scrolls with it, so
 * a validation error naming a line can be found. Built on tokens in this
 * module; a promotion candidate for @flowdular/ui once a second screen edits
 * code.
 */
export function TemplateBodyField(props: TemplateBodyFieldProps) @{
	const gutter = useRef<HTMLDivElement | null>(null);
	const numbers = lineNumbers(props.value);

	<div class="ui-field">
		<label class="ui-label" for={props.id}>{props.label}</label>
		<div class={['documents-code', props.invalid && 'documents-code--error']}>
			<div class="documents-code__gutter" aria-hidden="true" ref={gutter}>
				@for (const number of numbers; key number) {
					<span
						class={[
							'documents-code__number',
							props.flagged.has(number) && 'documents-code__number--flagged',
						]}
					>{number}</span>
				}
			</div>
			<textarea
				class="ui-textarea documents-code__input"
				id={props.id}
				value={props.value}
				rows={18}
				wrap="off"
				spellcheck={false}
				maxlength={props.maxLength}
				disabled={props.disabled}
				aria-invalid={props.invalid}
				aria-describedby={props.describedBy}
				onInput={(event) => props.onInput(event.currentTarget.value)}
				onScroll={(event) => {
					if (gutter.current) gutter.current.scrollTop =
						event.currentTarget.scrollTop;
				}}
			></textarea>
		</div>
	</div>
}

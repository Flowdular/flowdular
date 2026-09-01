import { useEffect } from 'octane';
import type { OctaneNode } from 'octane';
import { Button } from './Button.tsrx';

export interface ConfirmDialogProps {
	open: boolean;
	title: string;
	/** What happens and what cannot be undone. */
	children?: OctaneNode;
	confirmLabel?: string;
	cancelLabel?: string;
	/** danger for destructive actions, primary for the rest. */
	tone?: 'danger' | 'primary';
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) @{
	useEffect(() => {
		if (!props.open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') props.onCancel();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [props.open]);

	<div class="ui-drawer-slot">
		@if (props.open) {
			<div
				class="ui-dialog"
				role="presentation"
				onClick={() => props.onCancel()}
			>
				<div
					class="ui-dialog__panel"
					role="alertdialog"
					aria-modal="true"
					aria-label={props.title}
					onClick={(event: MouseEvent) => event.stopPropagation()}
				>
					<b class="ui-dialog__title">{props.title}</b>
					@if (props.children) {
						<p class="ui-dialog__body">{props.children}</p>
					}
					<div class="ui-dialog__actions">
						<Button disabled={props.busy ?? false} onClick={props.onCancel}>
							{props.cancelLabel ?? 'Cancel'}
						</Button>
						<Button
							variant={props.tone ?? 'danger'}
							disabled={props.busy ?? false}
							onClick={props.onConfirm}
						>
							{props.confirmLabel ?? 'Confirm'}
						</Button>
					</div>
				</div>
			</div>
		}
	</div>
}

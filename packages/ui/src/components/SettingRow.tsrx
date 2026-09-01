import type { OctaneNode } from 'octane';
import { Tag } from './Tag.tsrx';

export interface SettingRowStatus {
	readonly ok: boolean;
	readonly message: string;
}

export interface SettingRowProps {
	/** The row title doubles as the control's label; do not repeat it inside. */
	label: string;
	/** One line under the title; inline `code` is allowed. */
	description?: OctaneNode | undefined;
	/** Small neutral tag after the title, for example "All workspaces". */
	scopeLabel?: string | undefined;
	/** Inline result of the last save, shown under the control cluster. */
	status?: SettingRowStatus | null | undefined;
	/** The control cluster: the control, its Save button, a state tag. */
	children?: OctaneNode;
}

/* Presentation only: title and help on the left, one line of controls on the
   right, vertically centered. Loading and saving belong to the caller. */
export function SettingRow(props: SettingRowProps) @{
	<div class="ui-setting">
		<div class="ui-setting__text">
			<b>
				<span>{props.label}</span>
				@if (props.scopeLabel) {
					<Tag>{props.scopeLabel}</Tag>
				}
			</b>
			@if (props.description) {
				<small>{props.description}</small>
			}
		</div>
		<div class="ui-setting__control">
			{props.children}
			@if (props.status) {
				<span
					class={[
						'ui-setting__status',
						!props.status.ok && 'ui-setting__status--error',
					]}
					role="status"
				>{props.status.message}</span>
			}
		</div>
	</div>
}

import { useMemo } from 'octane';
import { t } from '@coreloom/client';
import { Button, SettingRow } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';

export interface WorkspaceCardProps {
	readonly name: string;
	readonly slug: string;
	readonly canManage: boolean;
	readonly busy: boolean;
	readonly result: { readonly ok: boolean; readonly message: string } | null;
	readonly onRename: (name: string) => void;
}

/* The workspace name lives on the tenant record, not in module settings, so
   the shell and every principal keep reading one value. */
export function WorkspaceCard(props: WorkspaceCardProps) @{
	const draft = useMemo(() => createStore({ name: cell(props.name) }), [
		props.name,
	]);
	const [name, setName] = useValue(draft.state.name);
	const trimmed = name.trim();
	const dirty = trimmed !== props.name && trimmed.length >= 2;

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{t('auth.settings.workspace.title')}
				<small>{t('auth.settings.workspace.subtitle')}</small>
			</span>
		</div>
		<SettingRow
			label={t('auth.settings.workspace.name')}
			description={<>
				{t('auth.settings.workspace.description') + ' '}
				<code>{props.slug}</code>
			</>}
			status={props.result}
		>
			<input
				class="ui-input"
				aria-label={t('auth.settings.workspace.name')}
				value={name}
				minlength={2}
				maxlength={120}
				disabled={!props.canManage || props.busy}
				onInput={(event) => setName(
					(event.currentTarget as HTMLInputElement).value,
				)}
			/>
			<Button
				size="sm"
				variant="primary"
				disabled={!props.canManage || props.busy || !dirty}
				onClick={() => props.onRename(trimmed)}
			>{t('auth.common.save')}</Button>
		</SettingRow>
	</section>
}

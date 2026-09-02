import { useMemo } from 'octane';
import { t } from '@coreloom/client';
import { Button, CheckGrid, FormField } from '@coreloom/ui';
import type { CheckGroup, CheckOption } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import type { CreateApiTokenRequest } from './api.ts';

export interface ApiTokenFormProps {
	readonly availableScopes: readonly string[];
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onSubmit: (input: CreateApiTokenRequest) => void;
}

/* A sandbox connection reads platform data and proves sandbox authority. It
   never needs a write scope: session-guarded mutations reject API tokens. */
function sandboxPreset(scope: string): boolean {
	return scope.startsWith('sandbox.') || scope.endsWith('.read');
}

function scopeGroups(scopes: readonly string[]): readonly CheckGroup[] {
	const groups = new Map<string, CheckOption[]>();
	for (const scope of scopes) {
		const namespace = scope.split('.')[0] ?? scope;
		const options = groups.get(namespace) ?? [];
		options.push({
			value: scope,
			label: scope.slice(namespace.length + 1) || scope,
		});
		groups.set(namespace, options);
	}
	return [...groups].map(([label, options]) => ({ label, options }));
}

function expiryTimestamp(days: string): number | null {
	const value = Number(days);
	if (!Number.isFinite(value) || value <= 0) return null;
	return Date.now() + Math.min(value, 365) * 24 * 60 * 60 * 1000;
}

export function ApiTokenForm(props: ApiTokenFormProps) @{
	const formState = useMemo(
		() => createStore({
			scopes: cell<readonly string[]>(
				props.availableScopes.filter(sandboxPreset),
			),
			expiryDays: '0',
		}),
		[],
	);
	const [scopes, setScopes] = useValue(formState.state.scopes);
	const [expiryDays, setExpiryDays] = useValue(formState.state.expiryDays);
	const groups = scopeGroups(props.availableScopes);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const label = form.get('label');
		props.onSubmit({
			label: typeof label === 'string' ? label : '',
			scopes,
			expiresAt: expiryTimestamp(expiryDays),
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField
					label={t('auth.tokens.form.label')}
					help={t('auth.tokens.form.labelHelp')}
					required
				>
					<input
						class="ui-input"
						name="label"
						minlength={2}
						maxlength={80}
						placeholder={t('auth.tokens.form.labelPlaceholder')}
						autoFocus
						required
					/>
				</FormField>
				<FormField label={t('auth.tokens.form.expiry')}>
					<select
						class="ui-select"
						value={expiryDays}
						onInput={(event) => setExpiryDays(event.currentTarget.value)}
					>
						<option value="0">{t('auth.tokens.form.noExpiry')}</option>
						<option value="7">{t('auth.tokens.form.days', {
							count: 7,
						})}</option>
						<option value="30">{t('auth.tokens.form.days', {
							count: 30,
						})}</option>
						<option value="90">{t('auth.tokens.form.days', {
							count: 90,
						})}</option>
						<option value="365">{t('auth.tokens.form.days', {
							count: 365,
						})}</option>
					</select>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">
						{t('auth.tokens.form.scopes')}
						<em aria-hidden="true">{' *'}</em>
					</span>
					<div class="token-presets">
						<Button
							size="sm"
							onClick={() => setScopes(
								props.availableScopes.filter(sandboxPreset),
							)}
						>{t('auth.tokens.form.presetSandbox')}</Button>
						<Button
							size="sm"
							onClick={() => setScopes(
								props.availableScopes.filter(
									(scope) => scope.endsWith('.read'),
								),
							)}
						>{t('auth.tokens.form.presetRead')}</Button>
						<Button size="sm" variant="ghost" onClick={() => setScopes([])}>{t(
							'auth.tokens.form.clear',
						)}</Button>
					</div>
					<CheckGrid groups={groups} value={scopes} mono onChange={setScopes} />
					<span class="ui-help">{t('auth.tokens.form.selected', {
						selected: scopes.length,
						total: props.availableScopes.length,
					})}</span>
				</div>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('auth.tokens.form.secretOnce')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('auth.common.cancel')}</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || scopes.length === 0}
				>
					{props.busy
						? t('auth.tokens.form.creating')
						: t('auth.tokens.form.create')}
				</Button>
			</div>
		</div>
	</form>
}

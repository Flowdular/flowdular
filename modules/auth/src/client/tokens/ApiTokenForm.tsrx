import { useMemo } from 'octane';
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
					label="Label"
					help="Name the client that holds the token, not the person creating it."
					required
				>
					<input
						class="ui-input"
						name="label"
						minlength={2}
						maxlength={80}
						placeholder="Local sandbox"
						autoFocus
						required
					/>
				</FormField>
				<FormField label="Expiry">
					<select
						class="ui-select"
						value={expiryDays}
						onInput={(event) => setExpiryDays(event.currentTarget.value)}
					>
						<option value="0">No expiry</option>
						<option value="7">7 days</option>
						<option value="30">30 days</option>
						<option value="90">90 days</option>
						<option value="365">365 days</option>
					</select>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">
						Scopes
						<em aria-hidden="true">{' *'}</em>
					</span>
					<div class="token-presets">
						<Button
							size="sm"
							onClick={() => setScopes(
								props.availableScopes.filter(sandboxPreset),
							)}
						>Sandbox connection</Button>
						<Button
							size="sm"
							onClick={() => setScopes(
								props.availableScopes.filter(
									(scope) => scope.endsWith('.read'),
								),
							)}
						>Read only</Button>
						<Button size="sm" variant="ghost" onClick={() => setScopes([])}>
							Clear
						</Button>
					</div>
					<CheckGrid groups={groups} value={scopes} mono onChange={setScopes} />
					<span class="ui-help">
						{scopes.length + ' of ' + props.availableScopes.length +
							' scopes selected'}
					</span>
				</div>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>The secret is shown once, right after it is created.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || scopes.length === 0}
				>
					{props.busy ? 'Creating…' : 'Create token'}
				</Button>
			</div>
		</div>
	</form>
}

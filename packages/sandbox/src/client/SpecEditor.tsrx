import { useEffect, useRef, useState } from 'octane';
import { Alert, Button, Icon } from '@flowdular/ui';
import { loadModuleSpec, saveModuleSpec } from './api.ts';
import { useTranslation } from './i18n.ts';

export interface SpecEditorProps {
	readonly sessionId: string;
	readonly module: string;
	readonly onSaved: () => void;
}

// Keyed by session and module in WorkbenchModal. A document cannot be saved
// until this editor has loaded it; stale responses never populate another editor.
export function SpecEditor(props: SpecEditorProps) @{
	const { t } = useTranslation();
	const [text, setText] = useState('');
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [saved, setSaved] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		let cancelled = false;
		setLoaded(false);
		setError('');
		void loadModuleSpec(props.sessionId, props.module).then((document) => {
			if (cancelled) return;
			if (document.module !== props.module) throw new Error(t(
				'sandbox.workbench.spec.readFailed',
			));
			setText(document.text);
			setLoaded(true);
		}).catch((failure: unknown) => {
			if (!cancelled) setError(
				failure instanceof Error
					? failure.message
					: t('sandbox.workbench.spec.readFailed'),
			);
		});
		return () => {
			cancelled = true;
			mounted.current = false;
		};
	}, [attempt]);
	const save = async () => {
		if (!loaded || saving || !text.trim()) return;
		setSaving(true);
		setError('');
		setSaved(false);
		try {
			await saveModuleSpec(props.sessionId, props.module, text);
			if (!mounted.current) return;
			setSaved(true);
			props.onSaved();
		} catch (failure) {
			if (mounted.current) setError(
				failure instanceof Error
					? failure.message
					: t('sandbox.workbench.spec.saveFailed'),
			);
		} finally {
			if (mounted.current) setSaving(false);
		}
	};
	<div class="spec-editor">
		<div class="spec-editor__bar">
			<span class="ui-mono">
				{'modules/' + props.module + '/spec/module.yaml'}
			</span>
			<span class="sandbox__spacer"></span>
			<Button
				size="sm"
				variant="primary"
				disabled={!loaded || saving || !text.trim()}
				onClick={() => void save()}
			>
				<Icon name="check" size={14} />
				{saving ? t('sandbox.common.saving') : t('sandbox.common.save')}
			</Button>
		</div>
		@if (error) {
			<Alert>{error}</Alert>
		} @else if (saved) {
			<Alert tone="info">{t('sandbox.workbench.spec.saved')}</Alert>
		}
		@if (!loaded) {
			@if (error) {
				<Button onClick={() => setAttempt(attempt + 1)}>{t(
					'sandbox.dashboard.refresh',
				)}</Button>
			} @else {
				<p class="ui-help">{t('sandbox.workbench.spec.loading')}</p>
			}
		}
		<textarea
			class="ui-textarea spec-editor__text"
			aria-label={t('sandbox.workbench.specification')}
			spellcheck={false}
			disabled={!loaded || saving}
			value={text}
			onInput={(event) => {
				setText(event.currentTarget.value);
				setSaved(false);
			}}
		></textarea>
	</div>
}

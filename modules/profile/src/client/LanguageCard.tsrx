import {
	cancelActiveLocalePreview,
	previewActiveLocale,
	setServerAccountLocale,
	SUPPORTED_LOCALES,
	useTranslation,
} from '@flowdular/client';
import { Alert, FormField, Icon } from '@flowdular/ui';
import { useMemo } from 'octane';
import { createStore, useValue } from 'segment-state';
import { updateOwnLanguagePreference } from './api.ts';

export interface LanguageCardProps {
	readonly csrfToken: string;
}

export function LanguageCard(props: LanguageCardProps) @{
	const { locale, t } = useTranslation();
	const client = useMemo(
		() => createStore({ saving: false, error: '', success: '' }),
		[],
	);
	const [saving, setSaving] = useValue(client.state.saving);
	const [error, setError] = useValue(client.state.error);
	const [success, setSuccess] = useValue(client.state.success);

	const selectLocale = async (nextLocale: string) => {
		setSaving(true);
		setError('');
		setSuccess('');
		previewActiveLocale(nextLocale);
		try {
			const preference = await updateOwnLanguagePreference(
				nextLocale,
				props.csrfToken,
			);
			setServerAccountLocale(preference.locale);
			setSuccess(t('profile.language.saved'));
		} catch (saveError) {
			cancelActiveLocalePreview();
			setError(
				saveError instanceof Error
					? saveError.message
					: t('profile.error.languageSave'),
			);
		} finally {
			setSaving(false);
		}
	};

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{t('profile.language.title')}
				<small>{t('profile.language.description')}</small>
			</span>
		</div>
		<div class="ui-form">
			@if (error) {
				<Alert>{error}</Alert>
			} @else if (success) {
				<Alert tone="info">{success}</Alert>
			}
			<FormField
				label={t('profile.language.label')}
				help={t('profile.language.help')}
			>
				<select
					class="ui-select"
					value={locale}
					disabled={saving}
					onChange={(event: Event) => void selectLocale(
						(event.currentTarget as HTMLSelectElement).value,
					)}
				>
					@for (const option of SUPPORTED_LOCALES; key option) {
						<option value={option}>{t('shell.language.' + option)}</option>
					}
				</select>
			</FormField>
			<p class="ui-note">
				<Icon name="globe" size={14} />
				<span>
					{saving ? t('profile.language.saving') : t('profile.language.note')}
				</span>
			</p>
		</div>
	</section>
}

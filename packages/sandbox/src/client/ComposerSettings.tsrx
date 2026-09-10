import { useEffect, useRef, useState } from 'octane';
import { Icon } from '@flowdular/ui';
import { useTranslation } from './i18n.ts';

export function ComposerSettings(props: {
	readonly autoContinue: boolean;
	readonly freshContext: boolean;
	readonly running: boolean;
	readonly onAutoContinue: (enabled: boolean) => void;
	readonly onFreshContext: (enabled: boolean) => void;
}) @{
	const { t } = useTranslation();
	const root = useRef<HTMLDivElement | null>(null);
	const trigger = useRef<HTMLButtonElement | null>(null);
	const [position, setPosition] = useState<
		{ left: number; bottom: number } | null
	>(null);
	const toggle = () => {
		if (position) return setPosition(null);
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		setPosition({
			left: Math.max(16, Math.min(rect.left, window.innerWidth - 336)),
			bottom: window.innerHeight - rect.top + 8,
		});
	};
	useEffect(() => {
		if (!position) return;
		const dismiss = (event: PointerEvent | FocusEvent) => {
			if (!root.current?.contains(event.target as Node)) setPosition(null);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			setPosition(null);
			trigger.current?.focus();
		};
		const resize = () => setPosition(null);
		document.addEventListener('pointerdown', dismiss);
		document.addEventListener('focusin', dismiss);
		document.addEventListener('keydown', escape);
		window.addEventListener('resize', resize);
		return () => {
			document.removeEventListener('pointerdown', dismiss);
			document.removeEventListener('focusin', dismiss);
			document.removeEventListener('keydown', escape);
			window.removeEventListener('resize', resize);
		};
	}, [position]);

	<div ref={root} class="chat-settings">
		<button
			ref={trigger}
			class="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon"
			type="button"
			aria-expanded={position !== null}
			aria-controls="composer-settings"
			aria-label={t('sandbox.chat.settings')}
			title={t('sandbox.chat.settings')}
			onClick={toggle}
		>
			<Icon name="settings" size={14} />
		</button>
		@if (position) {
			<div
				id="composer-settings"
				class="ui-menu chat-settings__panel"
				role="group"
				aria-label={t('sandbox.chat.settings')}
				style={{ left: position.left + 'px', bottom: position.bottom + 'px' }}
			>
				<label class="ui-menu__item ui-checkbox">
					<input
						type="checkbox"
						checked={props.autoContinue}
						onChange={(event) => props.onAutoContinue(
							event.currentTarget.checked,
						)}
					/>
					<span>{t('sandbox.chat.autoHandoff')}</span>
				</label>
				<label
					class="ui-menu__item ui-checkbox"
					title={t('sandbox.chat.freshHelp')}
				>
					<input
						type="checkbox"
						checked={props.freshContext}
						disabled={props.running}
						onChange={(event) => props.onFreshContext(
							event.currentTarget.checked,
						)}
					/>
					<span>{t('sandbox.chat.fresh')}</span>
				</label>
			</div>
		}
	</div>
}

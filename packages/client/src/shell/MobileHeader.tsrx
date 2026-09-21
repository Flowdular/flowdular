import { applicationBranding } from '../branding.ts';
import { applicationPath } from '../routing.ts';
import { ShellMark } from './BrandMark.tsrx';
import { Icon } from '@flowdular/ui';
import { t } from '../i18n/runtime.ts';

export function MobileHeader(props: { onToggle: () => void }) @{
	<header class="mobile-header">
		<a
			class="mobile-header__brand"
			href={applicationPath()}
			aria-label={t('shell.brand.home')}
		>
			<ShellMark size={22} />
			{applicationBranding().appName}
		</a>
		<button
			class="ui-btn ui-btn--secondary ui-btn--icon"
			type="button"
			aria-label={t('shell.nav.toggle')}
			onClick={props.onToggle}
		>
			<Icon name="panel-left" size={16} />
		</button>
	</header>
}

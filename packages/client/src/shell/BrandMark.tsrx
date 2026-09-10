import { applicationPath } from '../routing.ts';
import { BrandMark } from '@flowdular/ui';
import { t } from '../i18n/runtime.ts';

export function SidebarBrand() @{
	<a
		class="sidebar__home"
		href={applicationPath()}
		aria-label={t('shell.brand.home')}
	>
		<BrandMark size={22} />
		<span class="sidebar__wordmark">Flowdular</span>
	</a>
}

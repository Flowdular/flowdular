import { BrandMark } from '@coreloom/ui';
import { t } from '../i18n/runtime.ts';

export function SidebarBrand() @{
	<a class="sidebar__home" href="/app" aria-label={t('shell.brand.home')}>
		<BrandMark size={22} />
		<span class="sidebar__wordmark">Coreloom</span>
	</a>
}

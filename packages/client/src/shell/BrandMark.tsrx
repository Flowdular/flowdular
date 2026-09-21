import { applicationBranding } from '../branding.ts';
import { applicationPath } from '../routing.ts';
import { BrandMark } from '@flowdular/ui';
import { t } from '../i18n/runtime.ts';

/* The deployment's own logo when it set one, the product mark otherwise. The
   image is decorative: the wordmark beside it already names the workspace, so
   a second reading would only repeat it. */
export function ShellMark(props: { size: number }) @{
	const logo = applicationBranding().logoUrl;
	@if (logo) {
		<img
			class="shell-brand__logo"
			src={logo}
			alt=""
			width={props.size}
			height={props.size}
		/>
	} @else {
		<BrandMark size={props.size} />
	}
}

export function SidebarBrand() @{
	<a
		class="sidebar__home"
		href={applicationPath()}
		aria-label={t('shell.brand.home')}
	>
		<ShellMark size={22} />
		<span class="sidebar__wordmark">{applicationBranding().appName}</span>
	</a>
}

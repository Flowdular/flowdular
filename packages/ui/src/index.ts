import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/index.css';

export { BrandMark } from './brand/BrandMark.tsrx';
export type { BrandMarkProps, BrandMarkTone } from './brand/BrandMark.tsrx';
export { MARK_VIEWBOX, MARK_WARP, MARK_WEFT } from './brand/mark.ts';
export type { MarkShape } from './brand/mark.ts';
export { Icon, ICON_PATHS } from './icons/Icon.tsrx';
export type { IconProps } from './icons/Icon.tsrx';
export { Button } from './components/Button.tsrx';
export type {
	ButtonProps,
	ButtonSize,
	ButtonVariant,
} from './components/Button.tsrx';
export { FormField } from './components/FormField.tsrx';
export type { FormFieldProps } from './components/FormField.tsrx';
export { SearchField } from './components/SearchField.tsrx';
export type { SearchFieldProps } from './components/SearchField.tsrx';
export { CheckGrid } from './components/CheckGrid.tsrx';
export type {
	CheckGridProps,
	CheckGroup,
	CheckOption,
} from './components/CheckGrid.tsrx';
export { Drawer } from './components/Drawer.tsrx';
export type { DrawerProps, DrawerWidth } from './components/Drawer.tsrx';
export { ScopeSummary, summarizeScopes } from './components/ScopeSummary.tsrx';
export type { ScopeSummaryProps } from './components/ScopeSummary.tsrx';
export { SettingRow } from './components/SettingRow.tsrx';
export type {
	SettingRowProps,
	SettingRowStatus,
} from './components/SettingRow.tsrx';
export { Tag } from './components/Tag.tsrx';
export type { TagProps, TagTone } from './components/Tag.tsrx';
export { Kpi } from './components/Kpi.tsrx';
export type { KpiProps } from './components/Kpi.tsrx';
export { PageHeader } from './components/PageHeader.tsrx';
export type { PageHeaderProps } from './components/PageHeader.tsrx';
export { EmptyState } from './components/EmptyState.tsrx';
export type { EmptyStateProps } from './components/EmptyState.tsrx';
export { Alert } from './components/Alert.tsrx';
export type { AlertProps, AlertTone } from './components/Alert.tsrx';
export { Avatar } from './components/Avatar.tsrx';
export type { AvatarProps } from './components/Avatar.tsrx';
export { Switch } from './components/Switch.tsrx';
export type { SwitchProps } from './components/Switch.tsrx';
export { ConfirmDialog } from './components/ConfirmDialog.tsrx';
export type { ConfirmDialogProps } from './components/ConfirmDialog.tsrx';
export { initials } from './initials.ts';

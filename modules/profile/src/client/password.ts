import type { ChangePasswordInput } from './api.ts';

export interface PasswordFormValues {
	readonly currentPassword: string;
	readonly newPassword: string;
	readonly confirmation: string;
}

export type PasswordChangeValidation =
	| {
			readonly valid: true;
			readonly input: ChangePasswordInput;
	  }
	| {
			readonly valid: false;
			readonly code: 'required' | 'mismatch';
	  };

export function validatePasswordChange(
	values: PasswordFormValues,
): PasswordChangeValidation {
	if (values.currentPassword.length === 0 || values.newPassword.length === 0) {
		return {
			valid: false,
			code: 'required',
		};
	}
	if (values.newPassword !== values.confirmation) {
		return {
			valid: false,
			code: 'mismatch',
		};
	}
	return {
		valid: true,
		input: {
			currentPassword: values.currentPassword,
			newPassword: values.newPassword,
		},
	};
}

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
			readonly message: string;
	  };

export function validatePasswordChange(
	values: PasswordFormValues,
): PasswordChangeValidation {
	if (values.currentPassword.length === 0 || values.newPassword.length === 0) {
		return {
			valid: false,
			message: 'Enter your current password and a new password.',
		};
	}
	if (values.newPassword !== values.confirmation) {
		return {
			valid: false,
			message: 'The new password and confirmation do not match.',
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

import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class E2BApi implements ICredentialType {
	name = 'e2bApi';

	displayName = 'E2B API';

	documentationUrl = 'e2b';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Your E2B API key. Get it from your E2B account.',
		},
		{
			displayName: 'API URL',
			name: 'apiUrl',
			type: 'string',
			default: '',
			description: 'Optional custom E2B API URL',
		},
		{
			displayName: 'Domain',
			name: 'domain',
			type: 'string',
			default: '',
			description: 'Optional custom E2B control plane domain',
		},
		{
			displayName: 'Sandbox URL',
			name: 'sandboxUrl',
			type: 'string',
			default: '',
			description: 'Optional custom E2B sandbox URL',
		},
	];
}

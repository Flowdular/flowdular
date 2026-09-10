import blueprintSchemaJson from '../schemas/blueprint.schema.json' with { type: 'json' };
import cliExtensionSchemaJson from '../schemas/cli-extension.schema.json' with { type: 'json' };
import moduleSchemaJson from '../schemas/module.schema.json' with { type: 'json' };
import moduleSpecSchemaJson from '../schemas/module-spec.schema.json' with { type: 'json' };
import platformSpecSchemaJson from '../schemas/platform-spec.schema.json' with { type: 'json' };
import projectSchemaJson from '../schemas/project.schema.json' with { type: 'json' };

export const blueprintSchema = blueprintSchemaJson;
export const cliExtensionSchema = cliExtensionSchemaJson;
export const moduleSchema = moduleSchemaJson;
export const moduleSpecSchema = moduleSpecSchemaJson;
export const platformSpecSchema = platformSpecSchemaJson;
export const projectSchema = projectSchemaJson;

import moduleCatalogSchemaJson from '../schemas/module-catalog.schema.json' with { type: 'json' };
import moduleArtifactSchemaJson from '../schemas/module-artifact.schema.json' with { type: 'json' };
export const moduleCatalogSchema = moduleCatalogSchemaJson;
export const moduleArtifactSchema = moduleArtifactSchemaJson;

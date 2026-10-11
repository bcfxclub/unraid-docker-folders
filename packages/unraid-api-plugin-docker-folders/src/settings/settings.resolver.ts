import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { ComposeService } from '../compose/compose.service.js';
import { DockerFoldersSetting, DockerFoldersSettingInput } from './settings.model.js';
import { SettingsService } from './settings.service.js';

/**
 * Every field needs an explicit @UsePermissions or the API refuses to load
 * the plugin. `Resource` is upstream's enum and a plugin cannot extend it, so
 * this uses the closest existing resource, the same one `FolderResolver` and
 * `ContainerResolver` use.
 *
 * Delegation, like `FolderResolver`, apart from the flash copy that
 * `compose_auto_install` keeps in step. A rejected key or value throws
 * `BadRequestException` from the service, and the API turns that into a
 * GraphQL error the frontend reads the same way it reads PHP's 400 body.
 */
@Resolver()
export class SettingsResolver {
    constructor(
        private readonly settingsService: SettingsService,
        private readonly compose: ComposeService
    ) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersSetting], {
        description:
            'Every stored plugin setting, plus the read-only server_timezone entry.',
    })
    public dockerFoldersSettings(): DockerFoldersSetting[] {
        return this.settingsService.getAll();
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersSetting, {
        description: 'Set one plugin setting. Rejects a key outside the fixed allowlist.',
    })
    public async setDockerFoldersSetting(
        @Args('input') input: DockerFoldersSettingInput
    ): Promise<DockerFoldersSetting> {
        const setting = this.settingsService.set(input.key, input.value);
        // Same side effect, and same error, as settings.php.
        if (setting.key === 'compose_auto_install') {
            const applied = await this.compose.applyAutoInstallSetting(input.value);
            if (!applied.success) {
                throw new Error(`Saved, but ${applied.error}`);
            }
        }
        return setting;
    }
}

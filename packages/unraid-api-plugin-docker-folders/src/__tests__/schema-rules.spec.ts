import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { TypeMetadataStorage } from '@nestjs/graphql/dist/schema-builder/storages/type-metadata.storage.js';
import { getMetadataStorage } from 'class-validator';
import type { GraphQLInputObjectType, GraphQLNamedType, GraphQLSchema } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';

import { ApiModule } from '../index.js';

/**
 * The rules the Unraid API enforces on a plugin, found by testing on Unraid
 * 7.3.2 / API 4.35.1. Upstream documents none of them, so these tests are the
 * record. Each break below takes GraphQL offline, or breaks every write, on a
 * real server, and none of them shows in a unit test of a single service:
 *
 * - A type name the API already uses fails the whole schema, and GraphQL goes
 *   offline for the entire server. Every type of ours starts with
 *   `DockerFolders`, apart from a frozen list that shipped before this test.
 * - A resolver without `@UsePermissions` makes the API refuse the plugin.
 * - The API's global ValidationPipe uses `whitelist` and
 *   `forbidNonWhitelisted`, so an input field with no class-validator
 *   decorator is rejected on every request.
 *
 * The resolver list comes from `ApiModule`, so a new resolver is covered
 * without editing this file.
 */

const RESOLVER_TYPE = 'graphql:resolver_type';
const RESOLVER_PROPERTY = 'graphql:resolve_property';
const PERMISSIONS = '__PERMISSIONS__';
const ROOT_TYPES = new Set(['Query', 'Mutation', 'Subscription']);
const PREFIX = 'DockerFolders';

/**
 * Types that shipped before this test with the singular `DockerFolder`
 * prefix. Upstream builds Docker folders of its own (`docker.organizer`), so
 * these names sit where a collision is most likely. Renaming them changes the
 * API the frontend calls, so they are frozen here instead. Do not add to it.
 */
const LEGACY_TYPE_NAMES = new Set([
    'DockerFolder',
    'DockerFolderMember',
    'DockerFolderLayout',
    'DockerFolderCreateInput',
    'DockerFolderUpdateInput',
]);

/**
 * Root fields that shipped before this test, without the plugin's name in
 * them. Upstream's own Docker fields are mostly nested under `docker`, but
 * not all: from v4.35.1, behind ENABLE_NEXT_DOCKER_RELEASE, it defines root
 * mutations such as `createDockerFolder` and `setDockerFolderChildren`. Ours
 * was also called `createDockerFolder` and collided, so it became
 * `createDockerFoldersFolder`. Renaming changes the API the frontend calls,
 * so the rest are frozen here instead. Do not add to it: a new root field
 * must carry `DockerFolders` in its name.
 */
const LEGACY_ROOT_FIELDS = new Set([
    'Query.dockerFolderLayout',
    'Mutation.updateDockerFolder',
    'Mutation.deleteDockerFolder',
    'Mutation.addContainerToDockerFolder',
    'Mutation.removeContainerFromDockerFolder',
    'Mutation.reorderDockerFolderContainers',
    'Mutation.startDockerContainer',
    'Mutation.resumeDockerContainer',
    'Mutation.stopDockerContainer',
    'Mutation.restartDockerContainer',
    'Mutation.removeDockerContainer',
    'Mutation.reorderUnfolderedDockerContainers',
]);

type Method = { owner: string; name: string; fn: object };

// The schema factory loads graphql's CommonJS build and this file its ESM
// build, so graphql's own isScalarType() and friends throw "from another
// module or realm". Read the kind by class name instead.
function kindOf(type: GraphQLNamedType): string {
    return type.constructor.name;
}

function providerClasses(): Function[] {
    const providers: unknown[] = Reflect.getMetadata('providers', ApiModule) ?? [];
    return providers.filter((p): p is Function => typeof p === 'function');
}

/** Every query, mutation, subscription and resolve-field method. */
function resolverMethods(cls: Function): Method[] {
    const proto = cls.prototype as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto)
        .filter((name) => name !== 'constructor')
        .map((name) => ({ owner: cls.name, name, fn: proto[name] as object }))
        .filter(({ fn }) => {
            if (typeof fn !== 'function') return false;
            const type = Reflect.getMetadata(RESOLVER_TYPE, fn);
            return ROOT_TYPES.has(type) || Reflect.getMetadata(RESOLVER_PROPERTY, fn) === true;
        });
}

const resolvers = providerClasses().filter((cls) => resolverMethods(cls).length > 0);

describe('plugin schema rules', () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
        const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
            logger: false,
        });
        schema = await app.get(GraphQLSchemaFactory).create(resolvers);
        await app.close();
    });

    it('finds the resolvers through ApiModule', () => {
        expect(resolvers.map((r) => r.name)).toEqual(
            expect.arrayContaining(['FolderResolver', 'EventResolver'])
        );
    });

    it('builds a schema with every root field it declares', () => {
        for (const root of ['Query', 'Mutation', 'Subscription'] as const) {
            const type = schema.getType(root);
            expect(type, root).toBeDefined();
        }
        expect(schema.getSubscriptionType()?.getFields()).toHaveProperty('dockerFoldersEvents');
        expect(schema.getQueryType()?.getFields()).toHaveProperty('dockerFoldersInfo');
    });

    it('prefixes every type name with DockerFolders', () => {
        const unprefixed = Object.values(schema.getTypeMap())
            .filter((type) => !type.name.startsWith('__') && kindOf(type) !== 'GraphQLScalarType')
            .map((type) => type.name)
            .filter((name) => !ROOT_TYPES.has(name) && !name.startsWith(PREFIX));
        expect(unprefixed.filter((name) => !LEGACY_TYPE_NAMES.has(name))).toEqual([]);
        // A legacy entry that no longer exists should leave the list.
        expect([...LEGACY_TYPE_NAMES].filter((name) => !unprefixed.includes(name))).toEqual([]);
    });

    it('names every new root field with DockerFolders, so it cannot shadow an upstream field', () => {
        const roots = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()];
        const unprefixed = roots.flatMap((root) =>
            Object.keys(root?.getFields() ?? {})
                .filter((field) => !/dockerfolders/i.test(field))
                .map((field) => `${root?.name}.${field}`)
        );
        expect(unprefixed.filter((field) => !LEGACY_ROOT_FIELDS.has(field))).toEqual([]);
        // A legacy entry that no longer exists should leave the list.
        expect([...LEGACY_ROOT_FIELDS].filter((field) => !unprefixed.includes(field))).toEqual([]);
    });

    it('puts @UsePermissions on every resolver method', () => {
        const missing = resolvers
            .flatMap(resolverMethods)
            .filter(({ fn }) => !Reflect.getMetadata(PERMISSIONS, fn))
            .map(({ owner, name }) => `${owner}.${name}`);
        expect(missing).toEqual([]);
    });

    it('gives every input field a class-validator decorator', () => {
        const validation = getMetadataStorage();
        const missing: string[] = [];
        const checked: string[] = [];

        for (const { target, name } of TypeMetadataStorage.getInputTypesMetadata()) {
            const type = schema.getType(name);
            if (!type || kindOf(type) !== 'GraphQLInputObjectType') continue;
            checked.push(name);
            const validated = new Set(
                validation
                    .getTargetValidationMetadatas(target as Function, '', true, false)
                    .map((m) => m.propertyName)
            );
            for (const field of Object.keys((type as GraphQLInputObjectType).getFields())) {
                if (!validated.has(field)) missing.push(`${name}.${field}`);
            }
        }

        expect(checked.length).toBeGreaterThan(0);
        expect(missing).toEqual([]);
    });
});

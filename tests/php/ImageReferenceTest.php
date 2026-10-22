<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * DockerClient::splitImageReference, which turns a reference into the
 * fromImage and tag parameters of a pull, and the reference tests the
 * container list uses to spot a pulled image that is not applied yet.
 */
final class ImageReferenceTest extends TestCase
{
    #[Test]
    public function aPlainNameAndTagSplitOnTheColon(): void
    {
        $this->assertSame(['linuxserver/plex', '1.40'], DockerClient::splitImageReference('linuxserver/plex:1.40'));
    }

    #[Test]
    public function aNameWithNoTagPullsLatest(): void
    {
        $this->assertSame(['linuxserver/plex', 'latest'], DockerClient::splitImageReference('linuxserver/plex'));
    }

    #[Test]
    public function aRegistryPortIsNotATag(): void
    {
        $this->assertSame(['registry:5000/foo/bar', 'latest'], DockerClient::splitImageReference('registry:5000/foo/bar'));
        $this->assertSame(['registry:5000/foo/bar', 'v2'], DockerClient::splitImageReference('registry:5000/foo/bar:v2'));
    }

    #[Test]
    public function aDigestPinGoesWholeWithNoTag(): void
    {
        $ref = 'foo/bar@sha256:' . str_repeat('a', 64);
        $this->assertSame([$ref, null], DockerClient::splitImageReference($ref));
    }

    #[Test]
    public function onlyATagCanMoveToANewerImage(): void
    {
        $this->assertTrue(DockerClient::isTagReference('linuxserver/plex:latest'));
        $this->assertTrue(DockerClient::isTagReference('nginx'));
        $this->assertTrue(DockerClient::isTagReference('registry:5000/foo/bar:v2'));
        $this->assertFalse(DockerClient::isTagReference(''));
        $this->assertFalse(DockerClient::isTagReference('sha256:' . str_repeat('a', 64)));
        $this->assertFalse(DockerClient::isTagReference('foo/bar@sha256:' . str_repeat('a', 64)));
    }

    #[Test]
    public function aShaInTheListForATaggedContainerMeansTheImageIsOutdated(): void
    {
        $sha = 'sha256:' . str_repeat('b', 64);
        $this->assertTrue(DockerClient::isImageOutdated($sha, 'nginx:latest'));
    }

    #[Test]
    public function aListThatStillShowsTheTagIsNotOutdated(): void
    {
        $this->assertFalse(DockerClient::isImageOutdated('nginx:latest', 'nginx:latest'));
    }

    #[Test]
    public function aContainerCreatedFromAnIdOrDigestIsNeverOutdated(): void
    {
        $sha = 'sha256:' . str_repeat('c', 64);
        $this->assertFalse(DockerClient::isImageOutdated($sha, $sha));
        $this->assertFalse(DockerClient::isImageOutdated($sha, 'nginx@' . $sha));
        $this->assertFalse(DockerClient::isImageOutdated($sha, ''));
    }
}

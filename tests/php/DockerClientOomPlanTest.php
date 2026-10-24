<?php

declare(strict_types=1);

if (!defined('DOCKER_SOCKET')) {
    define('DOCKER_SOCKET', '/var/run/docker.sock');
}
if (!defined('DOCKER_API_VERSION')) {
    define('DOCKER_API_VERSION', 'v1.41');
}

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * planOomChecks() decides which containers cost an inspect on a list. Only a
 * container whose last exit was 137 is worth one, and only once per exit.
 */
final class DockerClientOomPlanTest extends TestCase
{
    private const NOW = 1_000_000_000;

    private static function listed(string $id, string $state, string $status): array
    {
        return ['Id' => $id, 'State' => $state, 'Status' => $status];
    }

    private static function plan(array $listed, array $cache): array
    {
        return DockerClient::planOomChecks(
            array_filter($listed, [DockerClient::class, 'isOomCandidate']),
            $cache,
            self::NOW
        );
    }

    #[Test]
    public function picksContainersWhoseLastExitWas137(): void
    {
        $listed = [
            self::listed('a', 'exited', 'Exited (137) 2 hours ago'),
            self::listed('b', 'exited', 'Exited (1) 2 hours ago'),
            self::listed('c', 'running', 'Up 2 hours'),
            self::listed('d', 'restarting', 'Restarting (137) 5 seconds ago'),
        ];
        $plan = self::plan($listed, []);

        $this->assertSame(['a', 'd'], $plan['inspect']);
        $this->assertSame([], $plan['cache']);
    }

    #[Test]
    public function keepsAnAnswerForTheSameExitHoweverOld(): void
    {
        $cache = ['a' => ['oom' => true, 'finished' => self::NOW - 3 * 86400]];
        $plan = self::plan([self::listed('a', 'exited', 'Exited (137) 3 days ago')], $cache);

        $this->assertSame([], $plan['inspect']);
        $this->assertSame($cache, $plan['cache']);
    }

    #[Test]
    public function inspectsAgainAfterALaterExit(): void
    {
        // It ran again and was stopped 30 seconds ago, between two polls.
        $cache = ['a' => ['oom' => true, 'finished' => self::NOW - 600]];
        $plan = self::plan([self::listed('a', 'exited', 'Exited (137) 30 seconds ago')], $cache);

        $this->assertSame(['a'], $plan['inspect']);
        // The old answer stays until the inspect replaces it.
        $this->assertSame($cache, $plan['cache']);
    }

    #[Test]
    public function waitsBeforeRetryingAFailedInspect(): void
    {
        $listed = [self::listed('a', 'exited', 'Exited (137) 30 seconds ago')];

        $recent = ['a' => ['oom' => false, 'finished' => 0, 'failedAt' => self::NOW - 10]];
        $this->assertSame([], self::plan($listed, $recent)['inspect']);

        $old = ['a' => ['oom' => false, 'finished' => 0, 'failedAt' => self::NOW - DockerClient::OOM_RETRY_SECONDS]];
        $this->assertSame(['a'], self::plan($listed, $old)['inspect']);
    }

    #[Test]
    public function dropsContainersThatRanAgainOrAreGone(): void
    {
        $cache = [
            'ran' => ['oom' => true, 'finished' => self::NOW - 600],
            'gone' => ['oom' => true, 'finished' => self::NOW - 600],
        ];
        $plan = self::plan([self::listed('ran', 'running', 'Up 5 seconds')], $cache);

        $this->assertSame([], $plan['inspect']);
        $this->assertSame([], $plan['cache']);
    }

    #[Test]
    public function readsTheUpperBoundOfDockersAgeWording(): void
    {
        $this->assertSame(1, DockerClient::statusAgeUpperBound('Exited (137) Less than a second ago'));
        $this->assertSame(31, DockerClient::statusAgeUpperBound('Exited (137) 30 seconds ago'));
        $this->assertSame(120, DockerClient::statusAgeUpperBound('Exited (137) About a minute ago'));
        $this->assertSame(360, DockerClient::statusAgeUpperBound('Exited (137) 5 minutes ago'));
        $this->assertSame(5400, DockerClient::statusAgeUpperBound('Exited (137) About an hour ago'));
        $this->assertSame(9000, DockerClient::statusAgeUpperBound('Exited (137) 2 hours ago'));
        $this->assertSame(4 * 86400, DockerClient::statusAgeUpperBound('Exited (137) 3 days ago'));
        $this->assertSame(1 * 2592000 + 2592000, DockerClient::statusAgeUpperBound('Exited (137) 1 month ago'));
        $this->assertNull(DockerClient::statusAgeUpperBound('Exited (137)'));
    }
}

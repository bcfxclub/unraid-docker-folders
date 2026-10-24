<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * selectRecreateTargets(), which picks the containers pull.php recreates.
 */
final class RecreateTargetsTest extends TestCase
{
    private const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    private const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    private const C = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

    private function containers(): array
    {
        return [
            ['id' => self::A, 'name' => 'web', 'image' => 'nginx:latest'],
            ['id' => self::B, 'name' => 'web2', 'image' => 'nginx:latest'],
            ['id' => self::C, 'name' => 'db', 'image' => 'postgres:16'],
        ];
    }

    #[Test]
    public function withoutIdsEveryContainerOnTheImageIsPicked(): void
    {
        $result = selectRecreateTargets($this->containers(), 'nginx:latest', null);

        $this->assertSame(['web', 'web2'], array_column($result['targets'], 'name'));
        $this->assertSame([], $result['missing']);
    }

    #[Test]
    public function withIdsOnlyThoseContainersArePicked(): void
    {
        $result = selectRecreateTargets($this->containers(), 'nginx:latest', [self::B => true]);

        $this->assertSame(['web2'], array_column($result['targets'], 'name'));
        $this->assertSame([], $result['missing']);
    }

    #[Test]
    public function anIdOnAnotherImageIsReportedNotRecreated(): void
    {
        $result = selectRecreateTargets($this->containers(), 'nginx:latest', [self::A => true, self::C => true]);

        $this->assertSame(['web'], array_column($result['targets'], 'name'));
        $this->assertSame([self::C], $result['missing']);
    }

    #[Test]
    public function anIdThatNoLongerExistsIsReportedNotRecreated(): void
    {
        $gone = str_repeat('d', 64);
        $result = selectRecreateTargets($this->containers(), 'nginx:latest', [$gone => true]);

        $this->assertSame([], $result['targets']);
        $this->assertSame([$gone], $result['missing']);
    }
}

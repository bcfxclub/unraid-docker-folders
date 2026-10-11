<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * The flash copy of the compose binary: cached on enable, verified against the
 * pinned SHA256, and restored into the (RAM) CLI plugin directory at boot.
 * The manager is built without its constructor, so no database is needed.
 */
final class ComposeRestoreTest extends TestCase
{
    private string $dir;
    private ComposeManager $manager;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/dfm-compose-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->manager = (new ReflectionClass(ComposeManager::class))->newInstanceWithoutConstructor();
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/{,*/}{*,.tmp}', GLOB_BRACE) ?: [] as $f) {
            is_file($f) && unlink($f);
        }
        @rmdir($this->dir . '/plugins');
        @rmdir($this->dir);
    }

    private function binary(string $name, string $content): array
    {
        $path = $this->dir . '/' . $name;
        file_put_contents($path, $content);
        return [$path, hash('sha256', $content)];
    }

    #[Test]
    public function aMatchingBinaryIsCachedAndExecutable(): void
    {
        [$src, $sha] = $this->binary('src', 'compose-bytes');
        $cache = $this->dir . '/cache';

        $this->assertTrue($this->manager->cacheComposeBinary($src, $cache, $sha));
        $this->assertSame('compose-bytes', file_get_contents($cache));
        $this->assertTrue(is_executable($cache));
        $this->assertFileDoesNotExist($cache . '.tmp');
    }

    #[Test]
    public function aBinaryThatDoesNotMatchTheHashIsNeverCachedOrRestored(): void
    {
        [$src] = $this->binary('src', 'tampered');
        $wrong = hash('sha256', 'something else');

        $this->assertFalse($this->manager->cacheComposeBinary($src, $this->dir . '/cache', $wrong));
        $this->assertFileDoesNotExist($this->dir . '/cache');

        $this->assertFalse($this->manager->restoreComposeBinary($src, $this->dir . '/dest', $wrong));
        $this->assertFileDoesNotExist($this->dir . '/dest');
    }

    #[Test]
    public function aMissingSourceIsReportedNotFatal(): void
    {
        $this->assertFalse($this->manager->cacheComposeBinary($this->dir . '/none', $this->dir . '/cache'));
        $this->assertFalse($this->manager->restoreComposeBinary($this->dir . '/none', $this->dir . '/dest'));
    }

    #[Test]
    public function restoreCreatesTheMissingPluginDirectoryAndMakesTheBinaryExecutable(): void
    {
        [$cache, $sha] = $this->binary('cache', 'compose-bytes');
        $dest = $this->dir . '/plugins/docker-compose';

        $this->assertTrue($this->manager->restoreComposeBinary($cache, $dest, $sha));
        $this->assertSame('compose-bytes', file_get_contents($dest));
        $this->assertTrue(is_executable($dest));
        $this->assertFileDoesNotExist($dest . '.tmp');
    }

    #[Test]
    public function removingTheCachedCopyDeletesIt(): void
    {
        [$cache] = $this->binary('cache', 'x');
        $this->manager->removeCachedComposeBinary($cache);
        $this->assertFileDoesNotExist($cache);

        // Removing a copy that is not there is not an error.
        $this->manager->removeCachedComposeBinary($cache);
        $this->assertFileDoesNotExist($cache);
    }
}

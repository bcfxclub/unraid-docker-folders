<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * The Unraid API version gate: dfmUnraidApiVersion reads the API's
 * package.json, and dfmApiVersionSupported checks it against api-compat.json.
 */
final class ApiVersionTest extends TestCase
{
    private const RANGE = ['min' => '4.35.0', 'maxExclusive' => '4.36.0', 'testedOn' => 'test'];

    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/dfm-api-version-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->dir . '/*') ?: []);
        rmdir($this->dir);
    }

    private function packageJson(string $json): string
    {
        $path = $this->dir . '/package.json';
        file_put_contents($path, $json);
        return $path;
    }

    #[Test]
    public function readsTheVersionAndDropsBuildMetadata(): void
    {
        $this->assertSame('4.35.1', dfmUnraidApiVersion($this->packageJson('{"version":"4.35.1+a9625ae2"}')));
        $this->assertSame('4.36.0-beta.1', dfmUnraidApiVersion($this->packageJson('{"version":"4.36.0-beta.1"}')));
    }

    #[Test]
    public function anUnreadableVersionIsNull(): void
    {
        $this->assertNull(dfmUnraidApiVersion($this->dir . '/missing.json'));
        $this->assertNull(dfmUnraidApiVersion($this->packageJson('not json')));
        $this->assertNull(dfmUnraidApiVersion($this->packageJson('{"name":"x"}')));
        $this->assertNull(dfmUnraidApiVersion($this->packageJson('{"version":"4.35.1\\" injected"}')));
    }

    #[Test]
    public function acceptsOnlyTheTestedRange(): void
    {
        foreach (['4.35.0', '4.35.1', '4.35.10'] as $v) {
            $this->assertTrue(dfmApiVersionSupported($v, self::RANGE), $v);
        }
        foreach (['4.34.9', '4.36.0', '4.37.4', '5.0.0'] as $v) {
            $this->assertFalse(dfmApiVersionSupported($v, self::RANGE), $v);
        }
    }

    #[Test]
    public function refusesPrereleasesAtBothEnds(): void
    {
        $this->assertFalse(dfmApiVersionSupported('4.35.0-beta.1', self::RANGE));
        $this->assertFalse(dfmApiVersionSupported('4.36.0-beta.1', self::RANGE));
    }

    #[Test]
    public function anUnknownVersionOrRangeIsRefusedWithAReason(): void
    {
        $this->assertFalse(dfmApiVersionSupported(null, self::RANGE));
        $this->assertFalse(dfmApiVersionSupported('4.35.1', null));
        $this->assertStringContainsString('could not be read', dfmApiVersionReason(null, self::RANGE));
        $this->assertStringContainsString('missing', dfmApiVersionReason('4.35.1', null));
        $this->assertStringContainsString('4.37.4', dfmApiVersionReason('4.37.4', self::RANGE));
        $this->assertSame('', dfmApiVersionReason('4.35.1', self::RANGE));
    }

    #[Test]
    public function theShippedRangeFileParses(): void
    {
        $range = dfmApiCompatRange();
        $this->assertIsArray($range);
        $this->assertTrue(dfmApiVersionSupported('4.35.1', $range), 'the version the backend was measured on');
    }
}
